import { createPublicKey, publicEncrypt, constants, randomBytes } from 'node:crypto';
import {
  ModuleError,
  invalid,
  loginExpired,
  protocolChanged,
  rejected,
  unsupported,
  verificationRequired,
} from './errors.mjs';
import { answerList, htmlImages, htmlToText } from './html.mjs';

export const HOSTS = {
  yxjc: 'https://yxjc.qlteacher.com',
  player: 'https://player.qlteacher.com',
  passport: 'https://passport.qlteacher.com',
  account: 'https://account.qlteacher.com',
  download: 'https://downloadres.qlteacher.com',
};

const BASIC = 'd2ViOnFsdGVhY2hlcg==';
const PUBLIC_KEY_URL = `${HOSTS.passport}/api/oauth2/public-key`;
const TOKEN_URL = `${HOSTS.passport}/api/oauth2/token`;
const DEFAULT_PROJECT = 'cz2026';
const AUTH_NAMESPACE = 'auth';
const CATALOG_NAMESPACE = 'catalog';
const EXAM_NAMESPACE = 'exam';

const KINDS = {
  video: 'video',
  teletext: 'reading',
  txt: 'reading',
  doc: 'document',
  resource: 'document',
  link: 'reading',
  exam: 'empty',
  homework: 'empty',
  assignment: 'empty',
};

const EXAM_TYPES = new Set(['exam']);
const UNSUPPORTED_TYPES = new Set(['homework', 'assignment']);

export class LoginFailure extends Error {
  constructor(message, code = 0) {
    super(message);
    this.name = 'LoginFailure';
    this.code = code;
  }
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const projectId = typeof source.project_id === 'string' && source.project_id.trim()
    ? source.project_id.trim()
    : DEFAULT_PROJECT;
  let projectIds = source.project_ids;
  if (typeof projectIds === 'string') projectIds = projectIds.split(/[\s,]+/);
  if (!Array.isArray(projectIds)) projectIds = [];
  projectIds = projectIds
    .map(value => String(value).trim())
    .filter(Boolean);
  if (!projectIds.includes(projectId)) projectIds.unshift(projectId);
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  return {
    source: source.source === 'fixture' ? 'fixture' : 'live',
    project_id: projectId,
    project_ids: [...new Set(projectIds)],
    chunk_seconds: number(source.chunk_seconds, 60, 10, 60),
    course_cache_seconds: number(source.course_cache_seconds, 900, 60, 3600),
    request_timeout_ms: number(source.request_timeout_ms, 12_000, 5_000, 25_000),
    study_verify_attempts: number(source.study_verify_attempts, 6, 2, 20),
    auto_finish_exams: source.auto_finish_exams !== false,
  };
}

export function courseKey(course) {
  return `${String(course?.id ?? '')}/${String(course?.recruit_id ?? '')}`;
}

export function isAllowedHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'qlteacher.com' || host.endsWith('.qlteacher.com');
}

function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function rsaEncrypt(value, pem) {
  const key = createPublicKey(pem);
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(String(value), 'utf8'),
  ).toString('base64');
}

function envelopeData(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'code')) {
    const code = Number(value.code);
    if (code === 200 || code === 0) return value.data ?? null;
    if (code === 401) throw loginExpired();
    return { __envelopeError: true, code, message: String(value.msg ?? value.message ?? '平台拒绝了操作') };
  }
  return value;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function boolFromTruth(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', '对', '正确', '是'].includes(text)) return 'true';
  if (['false', '0', 'no', '错', '错误', '否'].includes(text)) return 'false';
  return '';
}

function optionTruth(option) {
  const byText = boolFromTruth(option?.title ?? option?.text ?? option?.name ?? option?.content);
  if (byText) return byText;
  return boolFromTruth(option?.id);
}

function truthFromAnswer(answer, options) {
  const first = answerList(answer)[0];
  if (!first) return [];
  const direct = boolFromTruth(first);
  if (direct) return [direct];
  const option = (options || []).find(item => String(item.id) === String(first));
  const mapped = option ? optionTruth(option) : '';
  if (mapped) return [mapped];
  if (option && (options || []).some(optionCorrect)) {
    return [optionCorrect(option) ? 'true' : 'false'];
  }
  return [];
}

function judgeOptions(options) {
  const mapping = {};
  for (const option of options || []) {
    const truth = optionTruth(option);
    if (truth && !mapping[truth]) mapping[truth] = String(option.id);
  }
  const right = (options || []).find(optionCorrect);
  if (right) {
    if (!mapping.true) mapping.true = String(right.id);
    if (!mapping.false) {
      const other = (options || []).find(option => String(option?.id ?? '') !== String(right.id));
      if (other) mapping.false = String(other.id);
    }
  }
  if (!mapping.true || !mapping.false) {
    for (const option of options || []) {
      if (mapping.true && mapping.false) break;
      const id = String(option?.id ?? '');
      const truth = boolFromTruth(id);
      if (truth && !mapping[truth]) mapping[truth] = id;
    }
  }
  return mapping;
}

function optionCorrect(option) {
  return option?.right === true
    || option?.right === 1
    || option?.correct === true
    || option?.isCorrect === true
    || String(option?.right ?? '').toLowerCase() === 'true';
}

function correctAnswer(raw, options, userAnswer) {
  const explicit = raw?.rightAnswer ?? raw?.correctAnswer ?? userAnswer?.rightAnswer;
  if (Array.isArray(explicit)) return explicit.map(value => String(value)).filter(Boolean);
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.split(',').map(value => value.trim()).filter(Boolean);
  }
  return (options || []).filter(optionCorrect).map(option => String(option.id));
}

function collectActivities(courseData) {
  const rows = [];
  for (const section of Array.isArray(courseData?.sections) ? courseData.sections : []) {
    const activities = asList(section?.courseSessions ?? section?.activities ?? section?.activitys);
    for (const activity of activities) {
      rows.push({
        section,
        activity,
        type: String(activity?.sessionType ?? activity?.type ?? '').toLowerCase(),
      });
    }
  }
  const plusSections = Array.isArray(courseData?.plusSections)
    ? courseData.plusSections
    : courseData?.plusSections
      ? [courseData.plusSections]
      : [];
  for (const section of plusSections) {
    const activities = asList(section?.courseSessions ?? section?.activities ?? section?.activitys);
    for (const activity of activities) {
      rows.push({
        section,
        activity,
        type: String(activity?.sessionType ?? activity?.type ?? '').toLowerCase(),
      });
    }
  }
  return rows;
}

function activityProgress(activity) {
  return Math.max(0, Math.floor(
    numberOrNull(activity?.ext?.duration)
      ?? numberOrNull(activity?.duration)
      ?? 0,
  ));
}

function finishedActs(courseData) {
  return {
    ...(courseData?.courseStat?.finishedActs ?? {}),
    ...(courseData?.courseStatInfo?.finishedActs ?? {}),
    ...(courseData?.finishedActs ?? {}),
  };
}

function activityFinished(courseData, activity) {
  if (courseData?.finished === true || courseData?.course?.finished === true) return true;
  if (Number(courseData?.status ?? -1) === 1) return true;
  const id = String(activity?.id ?? '');
  return Number(activity?.status ?? 0) === 1 || Boolean(finishedActs(courseData)[id]);
}

function activityStatus(courseData, activity) {
  if (activityFinished(courseData, activity)) return 'completed';
  return Number(activity?.status ?? 0) === 2 || activityProgress(activity) > 0
    ? 'in_progress'
    : 'not_started';
}

function playerTokenFromUrl(value) {
  let url;
  try {
    url = new URL(String(value), HOSTS.yxjc);
  } catch {
    return '';
  }
  if (!isAllowedHost(url.hostname)) return '';
  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.indexOf('learning');
  const token = index >= 0 ? parts[index + 1] : parts.at(-1);
  return token ? decodeURIComponent(token) : '';
}

export class QLTeacherClient {
  constructor({ host, settings }) {
    this.host = host;
    this.settings = normalizeSettings(settings);
    this.textCache = new Map();
    this.refreshTasks = new Map();
  }

  async now() {
    const result = await this.host.call('cw.clock.now', {});
    const value = Number(result?.now);
    return Number.isFinite(value) ? value : Math.floor(Date.now() / 1000);
  }

  async stateGet(namespace, key, session) {
    const result = await this.host.call('cw.state', { namespace, key, session });
    return result?.value ?? null;
  }

  async stateSet(namespace, key, value, session) {
    await this.host.call('cw.state', { namespace, key, value, session });
  }

  async net(session, { method, url, headers = {}, body, encoding = 'json', stage = 'read', commit = false }) {
    const params = {
      session,
      method: String(method || 'GET').toUpperCase(),
      url,
      headers,
      stage,
      commit,
      timeout_ms: this.settings.request_timeout_ms,
    };
    if (body !== undefined) {
      params.body = body;
      params.encoding = encoding;
    }
    return this.host.call('cw.net.fetch', params);
  }

  statusError(response) {
    if (response.status === 401) return loginExpired();
    if ([403, 418, 429].includes(response.status)) {
      return verificationRequired(`平台返回 ${response.status}，请在官方页面完成验证后再继续`);
    }
    if (response.status === 404) return protocolChanged('平台接口不存在，页面或接口可能已更新');
    if (response.status >= 500) return new ModuleError('platform_unavailable', `平台暂时不可用（HTTP ${response.status}）`);
    return rejected(`平台拒绝了请求（HTTP ${response.status}）`);
  }

  parse(response, { raw = false, login = false } = {}) {
    if (raw) {
      if (response.status < 200 || response.status >= 300) throw this.statusError(response);
      return response.body;
    }
    const text = String(response.body ?? '').trim();
    if (!text) {
      if (response.status < 200 || response.status >= 300) throw this.statusError(response);
      return null;
    }
    let value;
    let parsed = true;
    try {
      value = JSON.parse(text);
    } catch {
      parsed = false;
    }
    if (login && parsed && value && typeof value === 'object' && Object.hasOwn(value, 'code')) {
      return value;
    }
    if (response.status < 200 || response.status >= 300) throw this.statusError(response);
    if (!parsed) {
      if (text.startsWith('<') || String(response.headers?.['content-type'] ?? '').includes('text/html')) {
        throw loginExpired();
      }
      throw protocolChanged();
    }
    if (login) return value;
    const data = envelopeData(value);
    if (data && typeof data === 'object' && data.__envelopeError === true) {
      if ([23002, 23004, 23006, 23007, 23013, 23014].includes(data.code)) {
        throw verificationRequired(data.message);
      }
      throw rejected(data.message);
    }
    return data;
  }

  async loadAuth(session) {
    const value = await this.stateGet(AUTH_NAMESPACE, 'token', session);
    return value && typeof value === 'object' && value.access_token ? value : null;
  }

  async saveAuth(session, auth) {
    await this.stateSet(AUTH_NAMESPACE, 'token', auth, session);
  }

  async saveLoginFailure(session, value) {
    await this.stateSet(AUTH_NAMESPACE, 'failure', value, session);
  }

  async loadLoginFailure(session) {
    const value = await this.stateGet(AUTH_NAMESPACE, 'failure', session);
    return value && typeof value === 'object' ? value : null;
  }

  async clearLoginFailure(session) {
    await this.stateSet(AUTH_NAMESPACE, 'failure', null, session);
  }

  async deviceId(session) {
    const stored = await this.stateGet(AUTH_NAMESPACE, 'device', session);
    if (stored && typeof stored === 'string' && stored.length >= 16) return stored;
    const device = randomBytes(32).toString('hex');
    await this.stateSet(AUTH_NAMESPACE, 'device', device, session);
    return device;
  }

  async profile(session, accessToken) {
    try {
      const response = await this.net(session, {
        method: 'GET',
        url: `${HOSTS.account}/api/me?_ignore_error=true`,
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      });
      if (response.status !== 200) return null;
      const parsed = this.parse(response);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  authFromToken(data, deviceId, previous = null) {
    if (!data || typeof data !== 'object') throw protocolChanged('登录接口没有返回令牌');
    const accessToken = String(data.access_token ?? '');
    const refreshToken = String(data.refresh_token ?? '');
    if (!accessToken || !refreshToken) throw protocolChanged('登录接口返回的令牌不完整');
    const payload = decodeJwt(accessToken) ?? {};
    const expiresIn = numberOrNull(data.expires_in);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Number.isFinite(Number(payload.exp))
      ? Number(payload.exp)
      : now + (expiresIn && expiresIn > 0 ? expiresIn : 3600);
    const accountRaw = String(payload.sub ?? payload.user_id ?? previous?.account_raw ?? '');
    const displayName = String(payload.name ?? payload.username ?? previous?.display_name ?? accountRaw);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: String(data.token_type ?? 'Bearer'),
      expires_in: expiresIn ?? Math.max(60, expiresAt - now),
      expires_at: expiresAt,
      device_id: deviceId || previous?.device_id || '',
      account_raw: accountRaw,
      display_name: displayName,
      connected_at: previous?.connected_at ?? now,
    };
  }

  async fillIdentity(session, auth) {
    if (auth.account_raw && auth.display_name && auth.display_name !== auth.account_raw) return auth;
    const profile = await this.profile(session, auth.access_token);
    if (profile) {
      auth.account_raw ||= String(profile.id ?? profile.userId ?? profile.uid ?? '');
      auth.display_name ||= String(profile.name ?? profile.loginName ?? profile.username ?? '');
    }
    return auth;
  }

  async login(session, username, password) {
    if (!username || !password) throw invalid('请输入账号和密码');
    const keyResponse = await this.net(session, {
      method: 'GET',
      url: PUBLIC_KEY_URL,
      headers: { Accept: 'application/json' },
    });
    const keyData = this.parse(keyResponse);
    const pem = typeof keyData === 'string' ? keyData : String(keyData?.publicKey ?? keyData?.public_key ?? '');
    if (!pem.includes('BEGIN PUBLIC KEY')) throw protocolChanged('登录公钥格式无法识别');
    let encrypted;
    try {
      encrypted = rsaEncrypt(password, pem);
    } catch {
      throw protocolChanged('登录密码加密失败，平台公钥可能已更新');
    }
    const deviceId = await this.deviceId(session);
    const response = await this.net(session, {
      method: 'POST',
      url: TOKEN_URL,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${BASIC}`,
        'X-Device-ID': deviceId,
      },
      body: {
        username: String(username),
        password: encrypted,
        grant_type: 'password',
      },
      encoding: 'form',
      stage: 'read',
    });
    let raw;
    try {
      raw = this.parse(response, { login: true });
    } catch (error) {
      if (error instanceof ModuleError) {
        if (error.code === 'platform_login_expired') {
          throw new LoginFailure('QLTeacher 登录失败，请检查账号密码', 23001);
        }
        if (error.code === 'platform_verification_required') {
          throw new LoginFailure(error.message, 23002);
        }
        if (error.code === 'platform_rejected') {
          throw new LoginFailure(error.message, 23001);
        }
      }
      throw error;
    }
    const code = Number(raw?.code ?? 200);
    if (code !== 200 && code !== 0) {
      if (code === 401) throw new LoginFailure('QLTeacher 登录已过期，请重新连接', code);
      throw new LoginFailure(String(raw?.msg ?? raw?.message ?? 'QLTeacher 登录失败'), code);
    }
    const auth = this.authFromToken(raw?.data ?? raw, deviceId);
    await this.fillIdentity(session, auth);
    if (!auth.account_raw || !auth.display_name) {
      throw protocolChanged('登录成功但无法读取平台账号标识，请稍后重试');
    }
    await this.saveAuth(session, auth);
    return auth;
  }

  async doRefresh(session, auth) {
    if (!auth?.refresh_token) throw loginExpired();
    const deviceId = auth.device_id || await this.deviceId(session);
    const response = await this.net(session, {
      method: 'POST',
      url: TOKEN_URL,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${BASIC}`,
        'X-Device-ID': deviceId,
      },
      body: { refresh_token: auth.refresh_token, grant_type: 'refresh_token' },
      encoding: 'form',
      stage: 'read',
    });
    const raw = this.parse(response, { login: true });
    const code = Number(raw?.code ?? 200);
    if (code !== 200 && code !== 0) {
      throw loginExpired();
    }
    const next = this.authFromToken(raw?.data ?? raw, deviceId, auth);
    await this.fillIdentity(session, next);
    await this.saveAuth(session, next);
    return next;
  }

  async refreshAuth(session, auth) {
    if (!auth?.refresh_token) throw loginExpired();
    const key = auth.refresh_token;
    const existing = this.refreshTasks.get(key);
    if (existing) return existing;
    const task = this.doRefresh(session, auth)
      .finally(() => this.refreshTasks.delete(key));
    this.refreshTasks.set(key, task);
    return task;
  }

  async ensureAuth(session, { refresh = true, margin = 300 } = {}) {
    let auth = await this.loadAuth(session);
    if (!auth) throw loginExpired();
    const now = await this.now();
    if (auth.expires_at && auth.expires_at - now <= margin) {
      if (!refresh) throw loginExpired();
      try {
        auth = await this.refreshAuth(session, auth);
      } catch (error) {
        if (auth.expires_at > now && error instanceof ModuleError && error.code === 'platform_unavailable') {
          return auth;
        }
        throw error;
      }
    }
    return auth;
  }

  async withAuth(session, options, { retried = false, refresh = true } = {}) {
    const auth = await this.ensureAuth(session, { refresh });
    const headers = {
      Accept: 'application/json',
      ...(options.headers || {}),
      Authorization: `Bearer ${auth.access_token}`,
    };
    try {
      const response = await this.net(session, { ...options, headers });
      return this.parse(response, { raw: Boolean(options.raw), login: false });
    } catch (error) {
      if (!retried && refresh && error instanceof ModuleError && error.code === 'platform_login_expired') {
        await this.refreshAuth(session, auth);
        return this.withAuth(session, options, { retried: true, refresh });
      }
      throw error;
    }
  }

  async identity(session) {
    const auth = await this.ensureAuth(session);
    if (!auth.account_raw || !auth.display_name) {
      throw protocolChanged('登录状态缺少平台账号标识，请重新连接');
    }
    return {
      display_name: auth.display_name,
      account_raw: auth.account_raw,
      connected_at: auth.connected_at ?? null,
    };
  }

  async verify(session) {
    return this.identity(session);
  }

  async keepalive(session) {
    let auth = await this.loadAuth(session);
    if (!auth) throw loginExpired();
    const now = await this.now();
    if (!auth.expires_at || auth.expires_at - now <= 600) {
      try {
        auth = await this.refreshAuth(session, auth);
      } catch (error) {
        if (!(auth.expires_at > now && error instanceof ModuleError && error.code === 'platform_unavailable')) throw error;
      }
    }
    return { ok: true, display_name: auth.display_name, account_raw: auth.account_raw, expires_at: auth.expires_at };
  }

  async listCourses(session) {
    const courses = [];
    const seen = new Set();
    for (const projectId of this.settings.project_ids) {
      const data = await this.withAuth(session, {
        method: 'GET',
        url: `${HOSTS.yxjc}/api/lesson/lessons/my?projectId=${encodeURIComponent(projectId)}`,
      });
      const groups = Array.isArray(data)
        ? data
        : Array.isArray(data?.list)
          ? data.list
          : Array.isArray(data?.lessons)
            ? [{ lessons: data.lessons }]
            : [];
      const lessons = [];
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const entry of value) visit(entry);
          return;
        }
        if (Array.isArray(value.lessons)) {
          for (const lesson of value.lessons) visit(lesson);
        }
        if (Array.isArray(value.lessonGroups)) {
          for (const group of value.lessonGroups) visit(group);
        }
        if (!Array.isArray(value.lessons) && !Array.isArray(value.lessonGroups) && value.id && (value.name || value.title)) {
          lessons.push(value);
        }
      };
      visit(groups);
      for (const lesson of lessons) {
        const id = String(lesson.id);
        if (!id) continue;
        const key = `${projectId}/${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const learnStatus = lesson.lessonLearnStatus?.status;
        const finished = Number(learnStatus) === 1 || lesson.studyFinished === true;
        courses.push({
          id,
          recruit_id: projectId,
          name: String(lesson.name ?? lesson.title ?? id),
          kind: lesson.mustLearn ? 'required' : 'optional',
          kind_label: lesson.external ? '外部课程' : lesson.mustLearn ? '必修课程' : '选修课程',
          family: projectId,
          progress: finished ? 100 : null,
          outline_available: !lesson.external,
        });
      }
    }
    return courses;
  }

  courseCacheKey(projectId, lessonId) {
    return `course:${projectId}:${lessonId}`;
  }

  async clearCourseCache(session, course) {
    const projectId = String(course?.recruit_id || this.settings.project_id);
    await this.stateSet(CATALOG_NAMESPACE, this.courseCacheKey(projectId, course?.id), null, session);
  }

  async resolveCourse(session, course, { force = false } = {}) {
    const projectId = String(course?.recruit_id || this.settings.project_id);
    const lessonId = String(course?.id ?? '');
    if (!projectId || !lessonId) throw invalid('课程编号不完整');
    const key = this.courseCacheKey(projectId, lessonId);
    if (!force) {
      const cached = await this.stateGet(CATALOG_NAMESPACE, key, session);
      if (cached?.token && await this.now() - Number(cached.fetched_at ?? 0) < this.settings.course_cache_seconds) {
        return cached;
      }
    }
    const link = await this.withAuth(session, {
      method: 'GET',
      url: `${HOSTS.yxjc}/api/lesson/learning/url?projectId=${encodeURIComponent(projectId)}&lessonId=${encodeURIComponent(lessonId)}`,
    });
    const url = typeof link === 'string'
      ? link
      : String(link?.url ?? link?.learningUrl ?? link?.learning_url ?? '');
    const token = playerTokenFromUrl(url);
    if (!token) throw new ModuleError('platform_unavailable', '平台没有提供可访问的课程播放器地址');
    const data = await this.withAuth(session, {
      method: 'GET',
      url: `${HOSTS.player}/api/learning/${encodeURIComponent(token)}/course`,
    });
    if (!data || typeof data !== 'object' || !data.course) throw protocolChanged('课程数据格式无法识别');
    const record = {
      token,
      project_id: projectId,
      lesson_id: lessonId,
      fetched_at: await this.now(),
    };
    await this.stateSet(CATALOG_NAMESPACE, key, record, session);
    return { ...record, data };
  }

  async getCourseData(session, course, options = {}) {
    const cached = await this.resolveCourse(session, course, options);
    if (cached.data) return cached;
    const data = await this.withAuth(session, {
      method: 'GET',
      url: `${HOSTS.player}/api/learning/${encodeURIComponent(cached.token)}/course`,
    });
    if (!data || typeof data !== 'object' || !data.course) throw protocolChanged('课程数据格式无法识别');
    return { ...cached, data };
  }

  async catalogUnits(session, course) {
    const info = await this.getCourseData(session, course, { force: true });
    const units = [];
    const seen = new Set();
    for (const { section, activity, type } of collectActivities(info.data)) {
      const id = String(activity?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const kind = KINDS[type] ?? 'reading';
      const extended = section?.extendedResource === true;
      const supported = ['video', 'teletext', 'txt', 'doc', 'resource', 'link'].includes(type);
      const exam = EXAM_TYPES.has(type);
      const duration = numberOrNull(activity?.ext?.studyTime)
        ?? numberOrNull(activity?.standard)
        ?? numberOrNull(activity?.length)
        ?? 0;
      const watched = activityFinished(info.data, activity) && duration > 0
        ? duration
        : activityProgress(activity);
      let selectable = supported && !extended;
      let note = activity?.mustLearn === 1 ? '' : (supported ? '选修内容' : '');
      if (exam) {
        selectable = this.settings.auto_finish_exams !== false && !extended;
        note = selectable
          ? '课程测验，自动作答（使用工作台模型）'
          : extended
            ? '扩展资源，不计入课程学习'
            : '课程测验，请在「课程测验」中完成';
      } else if (extended) {
        selectable = false;
        note = '扩展资源，不计入课程学习';
      } else if (UNSUPPORTED_TYPES.has(type)) {
        selectable = false;
        note = '平台作业/考试，请在官方页面完成';
      } else if (!supported) {
        selectable = false;
        note = '暂不支持的学习活动类型';
      } else if (type === 'resource' || type === 'link') {
        if (!duration && activity?.mustLearn !== 1) {
          selectable = false;
          note = '平台未提供可核验的学习时长';
        }
      }
      units.push({
        id,
        name: String(activity?.title ?? activity?.name ?? id),
        chapter_id: String(section?.id ?? 'chapter'),
        chapter_name: String(section?.title ?? section?.name ?? '章节'),
        lesson_id: String(course.id),
        kind,
        duration_seconds: duration > 0 ? Math.floor(duration) : watched > 0 ? watched : null,
        watched_seconds: watched,
        state: activityStatus(info.data, activity),
        video_id: type === 'video' ? id : null,
        selectable,
        ...(note ? { selectable_note: note } : {}),
      });
    }
    return units;
  }

  async getActivity(session, course, activityId, { forceCourse = false } = {}) {
    let info = await this.resolveCourse(session, course, { force: forceCourse });
    const fetch = async token => {
      const data = await this.withAuth(session, {
        method: 'GET',
        url: `${HOSTS.player}/api/learning/${encodeURIComponent(token)}/activity/${encodeURIComponent(activityId)}`,
      });
      if (!data || typeof data !== 'object' || !data.activity) throw protocolChanged('活动数据格式无法识别');
      return data;
    };
    let data;
    try {
      data = await fetch(info.token);
    } catch (error) {
      if (error instanceof ModuleError && ['platform_login_expired', 'platform_verification_required'].includes(error.code)) {
        await this.clearCourseCache(session, course);
        info = await this.resolveCourse(session, course, { force: true });
        data = await fetch(info.token);
      } else {
        throw error;
      }
    }
    const activity = data.activity;
    const type = String(activity?.sessionType ?? activity?.type ?? '').toLowerCase();
    return {
      info,
      data,
      activity,
      type,
      status: Number(data.status ?? activity?.status ?? 0),
      actToken: String(data.actToken ?? activity?.actToken ?? ''),
      interval: numberOrNull(data.updateDurationInterval) ?? 60,
      duration: numberOrNull(data.duration) ?? activityProgress(activity),
      finished: activityFinished(data, activity),
      finished_acts: finishedActs(data),
    };
  }

  async catalogPapers(session, course) {
    const info = await this.getCourseData(session, course, { force: true });
    const papers = [];
    const seen = new Set();
    for (const { section, activity, type } of collectActivities(info.data)) {
      if (!EXAM_TYPES.has(type)) continue;
      const id = String(activity?.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const done = activityFinished(info.data, activity);
      papers.push({
        id,
        name: String(activity?.title ?? activity?.name ?? '课程测验'),
        category: String(section?.title ?? section?.name ?? '课程测验'),
        available: true,
        done,
        can_redo: false,
        can_review: done,
        ...(done ? { attempts_left: 0 } : { attempts_left: 1 }),
        score: numberOrNull(activity?.ext?.score) ?? numberOrNull(activity?.score),
      });
    }
    return papers;
  }

  async getText(session, path) {
    const key = String(path);
    if (this.textCache.has(key)) return this.textCache.get(key);
    const url = /^https?:\/\//i.test(key)
      ? key
      : `${HOSTS.download}/${key.replace(/^\/+/, '')}`;
    const value = await this.withAuth(session, {
      method: 'GET',
      url,
      raw: true,
    });
    const text = String(value ?? '');
    this.textCache.set(key, text);
    return text;
  }

  async question(session, raw, userAnswer, { allowCorrect = true, submitAnswer = null } = {}) {
    const optionsRaw = asList(raw?.options);
    const type = String(raw?.type ?? raw?.typeName ?? '').toLowerCase();
    const itemType = String(raw?.itemType ?? '').toLowerCase();
    if (itemType === 'section' || type === 'section') return null;

    let title = String(raw?.title ?? raw?.text ?? '');
    let titleHtml = title;
    if (String(raw?.ext?.titleType ?? '').toLowerCase() === 'fastdfs') {
      try {
        titleHtml = await this.getText(session, title);
      } catch {
        titleHtml = title;
      }
    }
    title = htmlToText(titleHtml);
    const images = htmlImages(titleHtml, isAllowedHost);
    if (!title && !images.length && type !== 'section') {
      throw protocolChanged('题目内容为空，无法可靠读取；请稍后重试或使用官方页面');
    }

    const options = [];
    for (const option of optionsRaw) {
      let optionTitle = String(option?.title ?? option?.text ?? option?.name ?? option?.content ?? '');
      let optionHtml = optionTitle;
      if (String(option?.ext?.titleType ?? '').toLowerCase() === 'fastdfs') {
        try {
          optionHtml = await this.getText(session, optionTitle);
        } catch {
          optionHtml = optionTitle;
        }
      }
      optionTitle = htmlToText(optionHtml);
      for (const image of htmlImages(optionHtml, isAllowedHost)) {
        if (!images.includes(image)) images.push(image);
      }
      options.push({
        id: String(option?.id ?? ''),
        text: optionTitle,
      });
    }

    let kind = 'unsupported';
    if (type === 'single') kind = 'single';
    else if (type === 'multiple') kind = 'multiple';
    else if (['trueorfalse', 'truefalse', 'judge', 'judgement'].includes(type)) kind = 'judge';
    if (['single', 'multiple'].includes(kind) && options.some(option => !option.id || !option.text)) {
      kind = 'unsupported';
    }

    let publicOptions = options;
    let answer = [];
    let correct = [];
    const judgeMap = kind === 'judge' ? judgeOptions(optionsRaw) : {};
    if (kind === 'judge') {
      publicOptions = [
        { id: 'true', text: '正确' },
        { id: 'false', text: '错误' },
      ];
      answer = truthFromAnswer(userAnswer?.answer, optionsRaw);
      const right = allowCorrect ? correctAnswer(raw, optionsRaw, userAnswer) : [];
      correct = truthFromAnswer(right, optionsRaw);
      if (submitAnswer?.length) {
        const submitted = truthFromAnswer(submitAnswer, optionsRaw);
        if (submitted.length) answer = submitted;
      }
    } else {
      answer = answerList(userAnswer?.answer);
      if (submitAnswer?.length) answer = [...submitAnswer];
      if (allowCorrect) {
        correct = correctAnswer(raw, optionsRaw, userAnswer);
      }
    }

    let explanation = allowCorrect ? htmlToText(raw?.answerDesc ?? raw?.explanation ?? '') : '';
    if (allowCorrect && !explanation && raw?.answerDesc && String(raw?.ext?.answerDescType ?? '').toLowerCase() === 'fastdfs') {
      try {
        explanation = htmlToText(await this.getText(session, String(raw.answerDesc)));
      } catch {
        explanation = '';
      }
    }

    return {
      id: String(raw?.id ?? ''),
      kind,
      text: title || (images.length ? '图片题' : ''),
      options: publicOptions,
      answer: kind === 'judge' ? answer.slice(0, 1) : answer,
      ...(correct.length ? { correct_answer: kind === 'judge' ? correct.slice(0, 1) : correct } : {}),
      ...(explanation ? { explanation } : {}),
      ...(images.length ? { images } : {}),
      blanks: 0,
      _judge_map: judgeMap,
    };
  }

  stripPrivate(question) {
    const { _judge_map, ...clean } = question;
    return clean;
  }

  async buildQuestions(session, items, userAnswers, options = {}) {
    const map = new Map();
    if (Array.isArray(userAnswers)) {
      for (const entry of userAnswers) {
        const id = String(entry?.questionId ?? entry?.question_id ?? entry?.id ?? '');
        if (id) map.set(id, entry);
      }
    } else if (userAnswers && typeof userAnswers === 'object') {
      for (const [id, entry] of Object.entries(userAnswers)) map.set(String(id), entry);
    }
    let responseAnswers = options.submitResponse?.answers ?? options.submitResponse?.data?.answers ?? {};
    if (Array.isArray(responseAnswers)) {
      responseAnswers = Object.fromEntries(responseAnswers.map(entry => [
        String(entry?.questionId ?? entry?.question_id ?? entry?.id ?? ''),
        entry,
      ]).filter(([id]) => id));
    }
    const questions = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      if (String(item.itemType ?? '').toLowerCase() === 'section') continue;
      const id = String(item.id ?? '');
      if (!id) continue;
      const response = responseAnswers[id] ?? responseAnswers[String(id)];
      const question = await this.question(session, item, map.get(id), {
        allowCorrect: Boolean(options.allowCorrect),
        submitAnswer: response?.userAnswer ? answerList(response.userAnswer) : null,
      });
      if (!question) continue;
      if (response?.rightAnswer && question.kind !== 'judge') {
        const values = answerList(response.rightAnswer);
        if (values.length) question.correct_answer = values;
      }
      if (response?.rightAnswer && question.kind === 'judge') {
        const truth = truthFromAnswer(answerList(response.rightAnswer), item.options);
        if (truth.length) question.correct_answer = truth.slice(0, 1);
      }
      questions.push(question);
    }
    return questions;
  }

  async lookupBank(session, course, question) {
    if (!question || ['unsupported'].includes(question.kind)) return null;
    try {
      const result = await this.host.call('cw.question_bank.lookup', {
        session,
        course: courseKey(course),
        course_kind: course.kind,
        question: this.stripPrivate(question),
      });
      return Array.isArray(result?.correct) && result.correct.length ? result.correct : null;
    } catch {
      return null;
    }
  }

  async recordBank(session, course, question, answer, evidence) {
    try {
      if (evidence.result === 'correct') {
        await this.host.call('cw.question_bank.confirm', {
          session,
          course: courseKey(course),
          question: this.stripPrivate(question),
          answer,
          confirmation: { confirmed: true, source: 'platform' },
        });
      } else {
        await this.host.call('cw.question_bank.record', {
          session,
          course: courseKey(course),
          question: this.stripPrivate(question),
          answer,
          evidence: { result: 'incorrect', source: 'platform', at: Math.floor(Date.now() / 1000) },
        });
      }
    } catch {
      // Question-bank memory is best-effort and must never turn a confirmed platform result
      // into a failed task.
    }
  }

  async saveProgress(session, info, state, type, offset) {
    const activityId = String(state.activity.id);
    const token = info.token;
    let url;
    if (type === 'video') {
      url = `${HOSTS.player}/api/learning/${encodeURIComponent(token)}/duration/video/${encodeURIComponent(activityId)}/${encodeURIComponent(state.actToken)}/${encodeURIComponent(offset)}?_ignore_error=true`;
    } else if (type === 'doc') {
      url = `${HOSTS.player}/api/learning/${encodeURIComponent(token)}/duration/doc/${encodeURIComponent(activityId)}/${encodeURIComponent(state.actToken)}/${encodeURIComponent(offset)}`;
    } else if (type === 'teletext' || type === 'txt') {
      url = `${HOSTS.player}/api/learning/${encodeURIComponent(token)}/duration/txt/${encodeURIComponent(activityId)}/${encodeURIComponent(state.actToken)}/${encodeURIComponent(offset)}`;
    } else if (type === 'link') {
      url = `${HOSTS.player}/api/learning/${encodeURIComponent(token)}/duration/link/${encodeURIComponent(activityId)}/${encodeURIComponent(state.actToken)}/${encodeURIComponent(offset)}`;
    } else {
      throw unsupported(`不支持保存 ${type} 的学习进度`);
    }
    const data = await this.withAuth(session, {
      method: 'PUT',
      url,
      body: {},
      encoding: 'json',
      stage: 'save_study',
      commit: true,
    });
    return data && typeof data === 'object' ? data : {};
  }

  async saveResource(session, info, state, itemId) {
    const url = `${HOSTS.player}/api/learning/${encodeURIComponent(info.token)}/duration/resource/${encodeURIComponent(state.activity.id)}/${encodeURIComponent(itemId)}`;
    const data = await this.withAuth(session, {
      method: 'PUT',
      url,
      body: {},
      encoding: 'json',
      stage: 'save_study',
      commit: true,
    });
    return data && typeof data === 'object' ? data : {};
  }

  async submitExam(session, info, activityId, answers) {
    return this.withAuth(session, {
      method: 'POST',
      url: `${HOSTS.player}/api/learning/${encodeURIComponent(info.token)}/test`,
      body: { token: info.token, activityId, answers },
      encoding: 'json',
      stage: 'submit',
      commit: true,
    });
  }

  async loadAttempt(session, attemptId) {
    return this.stateGet(EXAM_NAMESPACE, `attempt:${attemptId}`, session);
  }

  async saveAttempt(session, attemptId, value) {
    await this.stateSet(EXAM_NAMESPACE, `attempt:${attemptId}`, value, session);
  }

  async loadSubmit(session, attemptId) {
    return this.stateGet(EXAM_NAMESPACE, `submit:${attemptId}`, session);
  }

  async saveSubmit(session, attemptId, value) {
    await this.stateSet(EXAM_NAMESPACE, `submit:${attemptId}`, value, session);
  }

  buildPlatformAnswers(attempt, answers) {
    const rows = [];
    for (const question of attempt.questions) {
      const values = answerList(answers?.[question.id]);
      if (!values.length) throw invalid(`题目 ${question.id} 尚未作答`);
      let answer;
      if (question.kind === 'judge') {
        const truth = boolFromTruth(values[0]);
        const optionId = attempt.judge_map?.[question.id]?.[truth];
        if (!optionId) throw rejected('判断题选项无法映射回平台');
        answer = optionId;
      } else if (question.kind === 'multiple') {
        answer = values.join(',');
      } else {
        answer = values[0];
      }
      rows.push({ questionId: question.id, answer });
    }
    return rows;
  }

  async openExam(session, course, paperId, { review = false } = {}) {
    const state = await this.getActivity(session, course, paperId, { forceCourse: false });
    const items = asList(state.activity?.ext?.examItems);
    const questions = await this.buildQuestions(session, items, state.data.userAnswers, {
      allowCorrect: state.finished || review,
    });
    if (!questions.length) throw new ModuleError('no_questions', '该课程测验没有可读取的题目');
    const judgeMap = {};
    for (const question of questions) {
      if (question.kind === 'judge' && question._judge_map) judgeMap[question.id] = question._judge_map;
    }
    for (const question of questions) {
      if (question.answer?.length || !['single', 'multiple', 'judge'].includes(question.kind)) continue;
      const known = await this.lookupBank(session, course, question);
      if (known?.length) {
        question.answer = known;
        question.correct_answer ||= known;
      }
    }
    const attemptId = `${String(course.id)}:${String(paperId)}`;
    const attempt = {
      id: attemptId,
      paper_id: String(paperId),
      name: String(state.activity?.title ?? state.activity?.name ?? '课程测验'),
      questions: questions.map(question => this.stripPrivate(question)),
      expires_at: null,
    };
    await this.saveAttempt(session, attemptId, {
      course_id: String(course.id),
      recruit_id: String(course.recruit_id),
      paper_id: String(paperId),
      activity_id: String(paperId),
      token: state.info.token,
      question_ids: questions.map(question => question.id),
      questions: attempt.questions,
      judge_map: judgeMap,
      created_at: await this.now(),
    });
    return { ready: true, attempt };
  }

  async readbackExam(session, course, attemptId) {
    const stored = await this.loadAttempt(session, attemptId);
    if (!stored) throw invalid('找不到本次作答记录，请重新打开试卷');
    const submit = await this.loadSubmit(session, attemptId);
    const state = await this.getActivity(session, course, stored.activity_id, { forceCourse: false });
    const items = asList(state.activity?.ext?.examItems);
    const questions = await this.buildQuestions(session, items, state.data.userAnswers, {
      allowCorrect: true,
      submitResponse: submit?.response ?? null,
    });
    const confirmed = state.finished;
    if (!confirmed) {
      return { confirmed: false, attempt_id: attemptId };
    }
    const answers = new Map();
    const rawUserAnswers = state.data.userAnswers
      ?? submit?.response?.answers
      ?? submit?.response?.data?.answers
      ?? [];
    if (Array.isArray(rawUserAnswers)) {
      for (const entry of rawUserAnswers) {
        const id = String(entry?.questionId ?? entry?.question_id ?? entry?.id ?? '');
        if (id) answers.set(id, entry);
      }
    } else if (rawUserAnswers && typeof rawUserAnswers === 'object') {
      for (const [id, entry] of Object.entries(rawUserAnswers)) answers.set(String(id), entry);
    }
    let responseMap = submit?.response?.answers ?? submit?.response?.data?.answers ?? {};
    if (Array.isArray(responseMap)) {
      responseMap = Object.fromEntries(responseMap.map(entry => [
        String(entry?.questionId ?? entry?.question_id ?? entry?.id ?? ''),
        entry,
      ]).filter(([id]) => id));
    }
    let correctCount = 0;
    let graded = 0;
    const gradedAnswers = {};
    for (const question of questions) {
      const entry = answers.get(question.id) ?? responseMap[question.id] ?? null;
      const isCorrect = entry?.correct === true;
      if (typeof entry?.correct === 'boolean') graded += 1;
      if (isCorrect) {
        correctCount += 1;
        const answer = question.correct_answer?.length
          ? question.correct_answer
          : question.answer;
        if (answer?.length) gradedAnswers[question.id] = answer;
        if (answer?.length) await this.recordBank(session, course, question, answer, { result: 'correct' });
      } else if (entry?.correct === false && question.answer?.length) {
        await this.recordBank(session, course, question, question.answer, { result: 'incorrect' });
      }
    }
    let score = null;
    const rightCount = numberOrNull(state.activity?.rightCount) ?? numberOrNull(state.data?.rightCount);
    if (rightCount !== null && questions.length) score = Math.round((rightCount / questions.length) * 100);
    else if (graded > 0) score = Math.round((correctCount / graded) * 100);
    return {
      confirmed: true,
      attempt_id: attemptId,
      ...(score === null ? {} : { score }),
      ...(Object.keys(gradedAnswers).length ? { graded_answers: gradedAnswers } : {}),
      review: { questions },
    };
  }
}

#!/usr/bin/env node
/**
 * Real-account smoke test for the QLTeacher module.
 *
 * Read-only by default. Pass --study-one to finish the first selectable unit,
 * which writes real progress to the platform.
 *
 * Output is privacy-safe by default: it does not print the account name/id,
 * course/unit names or question text. Add --verbose only if you intentionally
 * want to see that content in your terminal/log.
 *
 *   QL_USERNAME=... QL_PASSWORD=... node scripts/live-smoke.mjs
 *   QL_USERNAME=... QL_PASSWORD=... node scripts/live-smoke.mjs --study-one
 *   QL_USERNAME=... QL_PASSWORD=... node scripts/live-smoke.mjs --exam-open --verbose
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = flag => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const username = process.env.QL_USERNAME || '';
const password = process.env.QL_PASSWORD || '';
const projectId = valueOf('--project', process.env.QL_PROJECT_ID || 'cz2026');
const lessonId = valueOf('--lesson', process.env.QL_LESSON_ID || '');
const verbose = has('--verbose');

if (!username || !password) {
  process.stderr.write(
    '缺少真实账号。请设置 QL_USERNAME 和 QL_PASSWORD，例如：\n'
    + '  QL_USERNAME=your-account QL_PASSWORD=*** node scripts/live-smoke.mjs\n',
  );
  process.exit(2);
}

// Never print credentials, platform identifiers, JWTs or device ids in logs.
const redact = value => {
  let text = String(value ?? '');
  if (username) text = text.split(username).join('[账号]');
  if (password) text = text.split(password).join('[密码]');
  text = text.replace(/https?:\/\/\S+/g, '[url]');
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]');
  text = text.replace(/\b[a-f0-9]{32,64}\b/gi, '[device]');
  text = text.replace(/(access_token|refresh_token|authorization|password|cookie)\s*[=:]\s*\S+/gi, '$1=[redacted]');
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

const state = new Map();
const deviceFile = process.env.QL_DEVICE_FILE || fileURLToPath(new URL('../../cache/qlteacher-device', import.meta.url));
const readDevice = () => {
  if (process.env.QL_DEVICE_ID) return process.env.QL_DEVICE_ID;
  try { return fs.readFileSync(deviceFile, 'utf8').trim(); } catch { return ''; }
};
const saveDevice = value => {
  try {
    fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
    fs.writeFileSync(deviceFile, `${value}\n`, { mode: 0o600 });
  } catch { /* best effort; the platform only needs a stable value for this run */ }
};
let nextId = 1;
const pending = new Map();
let child;

const write = message => {
  if (child?.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
};

const moduleCall = (method, params = {}, timeoutMs = 60_000) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`模块调用 ${method} 超时`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    write({ jsonrpc: '2.0', id, method, params });
  });
};

const encodeBody = params => {
  if (params.body === undefined) return undefined;
  if (params.encoding === 'json') return JSON.stringify(params.body);
  if (params.encoding === 'form') return new URLSearchParams(params.body).toString();
  return typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
};

const netFetch = async params => {
  let url = params.url;
  if (params.encoding === 'query' && params.body) {
    const query = new URLSearchParams(params.body).toString();
    url += `${url.includes('?') ? '&' : '?'}${query}`;
  }
  const headers = {};
  for (const [key, value] of Object.entries(params.headers || {})) {
    if (typeof value === 'string' && !key.toLowerCase().includes('cookie')) headers[key] = value;
  }
  const body = encodeBody(params);
  if (body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
    if (params.encoding === 'json') headers['Content-Type'] = 'application/json';
    if (params.encoding === 'form') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const response = await fetch(url, {
    method: String(params.method || 'GET').toUpperCase(),
    headers,
    body,
    redirect: 'follow',
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
};

const hostCall = async (method, params) => {
  switch (method) {
    case 'cw.clock.now':
      return { now: Math.floor(Date.now() / 1000) };
    case 'cw.state': {
      const key = `${params.namespace}\u0000${params.key}`;
      if (params.namespace === 'auth' && params.key === 'device') {
        if (Object.hasOwn(params, 'value')) {
          const value = String(params.value ?? '');
          saveDevice(value);
          state.set(key, value);
          return {};
        }
        const value = readDevice() || state.get(key) || null;
        return { value };
      }
      if (Object.hasOwn(params, 'value')) {
        state.set(key, structuredClone(params.value));
        return {};
      }
      return { value: state.has(key) ? structuredClone(state.get(key)) : null };
    }
    case 'cw.net.fetch':
      return netFetch(params);
    case 'cw.question_bank.lookup':
      return { correct: null, wrong: [], updated_at: null };
    case 'cw.question_bank.confirm':
    case 'cw.question_bank.record':
      return { ok: true };
    case 'cw.log':
      return {};
    default:
      throw Object.assign(new Error(`未知宿主服务 ${method}`), { code: 'unsupported_operation' });
  }
};

const handleLine = line => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'module error');
      error.code = message.error.code;
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
    return;
  }
  if (typeof message.method === 'string' && message.id !== undefined) {
    void (async () => {
      try {
        const result = await hostCall(message.method, message.params || {});
        write({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
      } catch (error) {
        write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: error.code || 'host_error', message: error.message },
        });
      }
    })();
    return;
  }
  if (verbose && message.method === 'cw.log' && ['warn', 'error'].includes(message.params?.level)) {
    process.stderr.write(`[module] ${message.params.level}: ${redact(message.params.message)}\n`);
  }
};

const start = async () => {
  child = spawn(process.execPath, [path.join(root, 'index.mjs')], {
    cwd: root,
    env: {
      // Do not pass QL_PASSWORD/QL_USERNAME or other unrelated environment
      // variables to the module child process.
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TZ: 'UTC',
      CF_MODULE_SETTINGS: JSON.stringify({
        project_id: projectId,
        chunk_seconds: 60,
      }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', handleLine);
  const errorLines = createInterface({ input: child.stderr });
  errorLines.on('line', line => {
    // The module writes diagnostics, not course content. Keep them visible for
    // troubleshooting, but redact credentials/tokens/ids first.
    process.stderr.write(`[module] ${redact(line)}\n`);
  });
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const describeUnit = (unit, index) =>
  `${verbose ? unit.name : `单元 #${index + 1}`} [${unit.kind}] ${unit.state} `
  + `${unit.duration_seconds ?? '?'}s${unit.selectable ? '' : ' 不可选'}`
  + (unit.selectable_note ? ` (${unit.selectable_note})` : '');

const main = async () => {
  if (verbose) {
    process.stderr.write('警告：--verbose 会输出课程/单元/题目内容，请勿把日志直接分享给他人。\n');
  }
  await start();
  const begin = await moduleCall('auth.begin', { method: 'password', session: 'ch_live' });
  const challenge = begin.challenge.id;
  const submitted = await moduleCall('auth.submit', {
    challenge,
    session: challenge,
    fields: { username, password },
  });
  if (submitted.state !== 'connected') {
    const error = new Error(submitted.message || '登录失败');
    error.code = 'login_failed';
    throw error;
  }
  await moduleCall('auth.complete', { challenge, session: challenge });
  process.stdout.write('已连接（账号身份已校验；默认不输出姓名和账号 ID）\n');

  const { courses } = await moduleCall('catalog.courses', { session: 's_live' });
  process.stdout.write(`课程数：${courses.length}\n`);
  for (const [index, course] of courses.entries()) {
    const label = verbose ? `${course.name}  ${course.id}/${course.recruit_id}` : `课程 #${index + 1}`;
    process.stdout.write(`- ${label}  ${course.kind_label}${course.progress == null ? '' : ` ${course.progress}%`}\n`);
  }
  const courseIndex = lessonId
    ? courses.findIndex(item => item.id === String(lessonId))
    : Math.max(0, courses.findIndex(item => item.outline_available));
  const course = courses[courseIndex];
  if (!course) throw new Error('账号下没有可读取的课程');
  const courseLabel = verbose
    ? `课程：${course.name} (${course.id}/${course.recruit_id})`
    : `第 ${courseIndex + 1} 门课程`;
  process.stdout.write(`\n使用${courseLabel}\n`);

  const { units } = await moduleCall('catalog.units', { session: 's_live', course });
  process.stdout.write(`单元数：${units.length}\n`);
  for (const [index, unit] of units.entries()) {
    process.stdout.write(`- ${describeUnit(unit, index)}\n`);
  }

  const { papers } = await moduleCall('catalog.papers', { session: 's_live', course });
  process.stdout.write(`课程测验数：${papers.length}\n`);
  for (const [index, paper] of papers.entries()) {
    const label = verbose ? `${paper.name}  ${paper.id}` : `测验 #${index + 1}`;
    process.stdout.write(`- ${label}  done=${paper.done}  can_review=${paper.can_review}\n`);
  }

  if (has('--exam-open') && papers.length) {
    const paperIndex = Math.max(0, papers.findIndex(item => !item.done));
    const paper = papers[paperIndex];
    process.stdout.write(`\n读取测验：${verbose ? paper.name : `测验 #${paperIndex + 1}`}\n`);
    const opened = await moduleCall('exam.open', {
      session: 's_live',
      course,
      paper_id: paper.id,
      request_id: 'live-smoke/0',
    });
    for (const [index, question] of (opened.attempt.questions || []).entries()) {
      if (verbose) {
        process.stdout.write(`- [${question.kind}] ${question.text}\n`);
        for (const option of question.options || []) {
          process.stdout.write(`    ${option.id}. ${option.text}\n`);
        }
      } else {
        process.stdout.write(`- [${question.kind}] 题目 #${index + 1}（内容已隐藏，使用 --verbose 显示）\n`);
      }
    }
  }

  if (has('--study-one')) {
    const unit = units.find(item => item.selectable && item.state !== 'completed' && item.kind === 'video')
      || units.find(item => item.selectable && item.state !== 'completed' && item.kind !== 'empty');
    if (!unit) {
      process.stdout.write('\n没有需要学习且可自动处理的单元。\n');
      return;
    }
    const unitIndex = units.indexOf(unit);
    const unitLabel = verbose ? unit.name : `单元 #${unitIndex + 1}`;
    process.stdout.write(`\n开始真实学习（会写入平台进度）：${unitLabel}\n`);
    let checkpoint = null;
    let result;
    const deadline = Date.now() + 15 * 60 * 1000;
    const options = {
      operation: 'study',
      execution_id: `live-smoke/${Date.now()}`,
      speedup: false,
      max_speed: 1,
      interaction_answers: {},
    };
    do {
      result = await moduleCall('study.step', {
        session: 's_live',
        course,
        unit,
        checkpoint,
        options,
      }, 65_000);
      checkpoint = result.checkpoint ?? checkpoint;
      const detail = result.detail ? `：${redact(result.detail)}` : '';
      const reason = result.reason ? `：${redact(result.reason)}` : '';
      process.stdout.write(`- ${result.status}${detail}${reason}\n`);
      if (result.status === 'in_progress') {
        if (Date.now() > deadline) throw new Error('学习单步测试超过 15 分钟，已停止');
        await sleep(Math.max(1000, Math.min(60_000, Number(result.wait_ms) || 5000)));
      } else if (result.status === 'needs_ai') {
        const missing = result.questions?.filter(question => !question.correct_answer?.length) || [];
        if (missing.length) throw new Error('视频弹题没有平台公布答案，需要配置模型或人工补答');
        for (const question of result.questions) {
          options.interaction_answers[question.id] = question.correct_answer;
        }
        checkpoint = result.checkpoint ?? checkpoint;
        await sleep(1000);
      } else {
        break;
      }
    } while (true);
    process.stdout.write(`学习结果：${result.status}\n`);
  }
};

main()
  .catch(error => {
    process.stderr.write(`${error.code ? `[${error.code}] ` : ''}${redact(error.message)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child?.stdin.writable) child.stdin.end();
    setTimeout(() => child?.kill('SIGTERM'), 100).unref();
  });

import {
  ModuleError,
  invalid,
  loginExpired,
  rejected,
  unsupported,
} from './errors.mjs';
import { LoginFailure, QLTeacherClient, normalizeSettings } from './platform.mjs';
import { QLTeacherFixture } from './fixture.mjs';

const SUPPORTED_STUDY_TYPES = new Set(['video', 'teletext', 'txt', 'doc', 'link']);

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function checkpointObject(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('checkpoint 必须是 JSON 对象或 null');
  return value;
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function progressText(seconds, total) {
  const format = value => {
    const safe = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const rest = safe % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${minutes}:${String(rest).padStart(2, '0')}`;
  };
  return total > 0 ? `已学习 ${format(seconds)} / ${format(total)}` : `已学习 ${format(seconds)}`;
}

function activityType(state) {
  return String(state?.activity?.sessionType ?? state?.activity?.type ?? state?.type ?? '').toLowerCase();
}

function activityRequiredSeconds(activity, unit) {
  const ext = activity?.ext ?? {};
  for (const value of [ext.studyTime, activity?.standard, activity?.length, unit?.duration_seconds]) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 0;
}

function speedFactor(options) {
  const requested = options?.speedup === true ? Number(options.max_speed ?? 1.5) : 1;
  return Math.max(1, Math.min(1.5, Number.isFinite(requested) ? requested : 1));
}

function interactionAnswer(options, questionId) {
  const answers = options?.interaction_answers;
  if (!answers || typeof answers !== 'object') return [];
  const value = answers[questionId];
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function validPublicAnswer(question, values) {
  if (!Array.isArray(values) || !values.length) return false;
  if (question.kind === 'unsupported') return false;
  if (question.kind === 'single') return values.length === 1 && question.options.some(option => option.id === values[0]);
  if (question.kind === 'multiple') return values.length > 0 && values.every(value => question.options.some(option => option.id === value));
  if (question.kind === 'judge') return values.length === 1 && ['true', 'false'].includes(values[0]);
  return values.every(value => typeof value === 'string' && value.trim());
}

export class QLTeacherModule {
  constructor({ host, manifest, settings }) {
    this.host = host;
    this.manifest = manifest;
    this.settings = normalizeSettings(settings);
    this.client = new QLTeacherClient({ host, settings: this.settings });
    this.fixture = this.settings.source === 'fixture'
      ? new QLTeacherFixture({ host, settings: this.settings })
      : null;
    this.challenges = new Map();
    this.submitting = new Set();
  }

  async dispatch(method, params) {
    const input = params && typeof params === 'object' ? params : {};
    if (method === 'platform.describe') return this.describe();
    if (this.fixture) return this.fixture.dispatch(method, input);
    switch (method) {
      case 'auth.begin':
        return this.authBegin(input);
      case 'auth.submit':
        return this.authSubmit(input);
      case 'auth.poll':
        return this.authPoll(input);
      case 'auth.complete':
        return this.authComplete(input);
      case 'auth.verify':
        return this.authVerify(input);
      case 'auth.keepalive':
        return this.authKeepalive(input);
      case 'catalog.courses':
        return this.catalogCourses(input);
      case 'catalog.units':
        return this.catalogUnits(input);
      case 'catalog.papers':
        return this.catalogPapers(input);
      case 'study.step':
        return this.studyStep(input);
      case 'exam.open':
        return this.examOpen(input);
      case 'exam.review':
        return this.examReview(input);
      case 'exam.redo':
        throw unsupported('QLTeacher 课程测验暂不提供工作台重做；如需重考，请在官方页面操作');
      case 'exam.write':
        return this.examWrite(input);
      case 'exam.readback':
        return this.examReadback(input);
      case 'exam.heartbeat':
        return { ok: true };
      default:
        throw unsupported(`QLTeacher 模块没有实现 ${method}`);
    }
  }

  async describe() {
    return {
      module: {
        name: 'courseflow-qlteacher',
        version: this.manifest.version,
        module_api: 1,
      },
      platform: this.manifest.platform,
    };
  }

  async authBegin(params) {
    if (params.method !== 'password') {
      throw unsupported('QLTeacher 目前只提供账号密码登录');
    }
    const now = await this.client.now();
    const challenge = String(params.session ?? '');
    if (!challenge) throw invalid('登录挑战缺少会话编号');
    const expiresAt = now + 300;
    this.challenges.set(challenge, { state: 'waiting', expires_at: expiresAt, created_at: now });
    return {
      challenge: {
        id: challenge,
        kind: 'password',
        expires_at: expiresAt,
        fields: [
          {
            name: 'username',
            label: '账号',
            type: 'text',
            required: true,
            autocomplete: 'username',
          },
          {
            name: 'password',
            label: '密码',
            type: 'password',
            required: true,
            autocomplete: 'current-password',
          },
        ],
      },
    };
  }

  async authSubmit(params) {
    const challenge = String(params.challenge ?? '');
    const session = String(params.session ?? challenge);
    const fields = params.fields && typeof params.fields === 'object' ? params.fields : {};
    const username = String(fields.username ?? '').trim();
    const password = String(fields.password ?? '');
    if (!challenge || !session) throw invalid('登录挑战缺少会话编号');
    if (!username || !password) {
      const message = '请输入 QLTeacher 账号和密码';
      this.challenges.set(challenge, { state: 'failed', message, expires_at: 0 });
      await this.client.saveLoginFailure(session, { challenge, message, at: await this.client.now() });
      return { state: 'failed', message };
    }
    try {
      await this.client.login(session, username, password);
      await this.client.clearLoginFailure(session);
      this.challenges.set(challenge, { state: 'connected', expires_at: 0 });
      return { state: 'connected' };
    } catch (error) {
      if (error instanceof LoginFailure) {
        this.challenges.set(challenge, { state: 'failed', message: error.message, expires_at: 0 });
        await this.client.saveLoginFailure(session, { challenge, message: error.message, at: await this.client.now() });
        return { state: 'failed', message: error.message };
      }
      throw error;
    }
  }

  async authPoll(params) {
    const challenge = String(params.challenge ?? '');
    const session = String(params.session ?? challenge);
    const state = this.challenges.get(challenge);
    if (state?.state === 'failed') return { state: 'failed' };
    const failure = await this.client.loadLoginFailure(session);
    if (failure?.challenge === challenge) return { state: 'failed' };
    const auth = await this.client.loadAuth(session);
    if (auth) return { state: 'connected' };
    if (state?.expires_at && await this.client.now() >= state.expires_at) {
      this.challenges.delete(challenge);
      return { state: 'expired' };
    }
    return { state: 'waiting' };
  }

  async authComplete(params) {
    const session = String(params.session ?? '');
    const auth = await this.client.loadAuth(session);
    if (!auth) throw loginExpired();
    const identity = await this.client.identity(session);
    this.challenges.delete(String(params.challenge ?? session));
    return identity;
  }

  async authVerify(params) {
    return this.client.verify(String(params.session ?? ''));
  }

  async authKeepalive(params) {
    return this.client.keepalive(String(params.session ?? ''));
  }

  async catalogCourses(params) {
    const session = String(params.session ?? '');
    if (!session) throw invalid('缺少会话标识');
    return { courses: await this.client.listCourses(session) };
  }

  async catalogUnits(params) {
    const session = String(params.session ?? '');
    const course = params.course;
    if (!session || !course?.id) throw invalid('缺少课程或会话标识');
    return { units: await this.client.catalogUnits(session, course) };
  }

  async catalogPapers(params) {
    const session = String(params.session ?? '');
    const course = params.course;
    if (!session || !course?.id) throw invalid('缺少课程或会话标识');
    return { papers: await this.client.catalogPapers(session, course) };
  }

  async studyStep(params) {
    const session = String(params.session ?? '');
    const course = params.course;
    const unit = params.unit;
    const options = params.options && typeof params.options === 'object' ? params.options : {};
    const checkpoint = checkpointObject(params.checkpoint);
    if (!session || !course?.id || !unit?.id) throw invalid('学习步骤缺少课程或单元');
    const operation = String(options.operation ?? 'study');

    if (unit.state === 'completed' && !['review', 'trial'].includes(operation)) {
      return { status: 'completed', evidence: { already_completed: true } };
    }

    const state = await this.client.getActivity(session, course, unit.video_id || unit.id);
    const type = activityType(state);
    if (state.finished && operation !== 'review') {
      return {
        status: 'completed',
        evidence: { platform_confirmed: true },
        checkpoint: params.checkpoint ?? null,
      };
    }
    if (operation === 'review') {
      return this.reviewStep(state, unit, checkpoint, options);
    }
    if (operation === 'trial' && !SUPPORTED_STUDY_TYPES.has(type)) {
      return {
        status: 'blocked',
        reason: '该活动不支持短时试跑，请选择视频、图文或文档',
        checkpoint: params.checkpoint ?? null,
      };
    }
    if (type === 'exam') {
      // Kept for checkpoints created before exams were removed from the study
      // directory. New catalogs never expose exam units here.
      return this.studyExamStep(session, course, state, checkpoint, options);
    }
    if (type === 'homework' || type === 'assignment') {
      return {
        status: 'needs_human',
        reason: '平台作业/考试需要在官方页面完成，工作台不会代做',
        checkpoint: params.checkpoint ?? null,
      };
    }
    if (type === 'resource') {
      return this.resourceStep(session, course, state, checkpoint, options);
    }
    if (!SUPPORTED_STUDY_TYPES.has(type)) {
      return {
        status: 'blocked',
        reason: `暂不支持的学习活动类型：${type || '未知'}`,
        checkpoint: params.checkpoint ?? null,
      };
    }
    return this.timedStep(session, course, state, unit, checkpoint, options, type, operation);
  }

  async studyExamReadback(session, course, attempt, checkpoint) {
    const readbacks = Math.max(0, Math.floor(Number(checkpoint.exam_readbacks) || 0));
    if (readbacks >= 6) {
      return {
        status: 'needs_human',
        reason: '课程测验已提交，但平台尚未确认结果，请稍后回读或到官方页面核对',
        checkpoint: { ...checkpoint, exam_attempt_id: attempt.id, exam_readbacks: readbacks },
      };
    }
    try {
      const result = await this.examReadback({ session, course, attempt_id: attempt.id });
      if (result.confirmed && result.attempt_id === attempt.id) {
        return {
          status: 'completed',
          evidence: {
            platform_confirmed: true,
            ...(result.score == null ? {} : { score: result.score }),
          },
          checkpoint: { ...checkpoint, exam_attempt_id: attempt.id, exam_readbacks: 0 },
        };
      }
    } catch (error) {
      if (error instanceof ModuleError && ['platform_login_expired', 'platform_verification_required', 'task_cancelled', 'quiet_hours'].includes(error.code)) {
        throw error;
      }
      if (error instanceof ModuleError && error.code !== 'platform_unavailable') {
        return {
          status: 'needs_human',
          reason: `课程测验回读失败：${error.message}`,
          checkpoint: { ...checkpoint, exam_attempt_id: attempt.id, exam_readbacks: readbacks },
        };
      }
    }
    return {
      status: 'in_progress',
      detail: '正在回读课程测验提交结果',
      wait_ms: 1500,
      checkpoint: {
        ...checkpoint,
        exam_attempt_id: attempt.id,
        exam_readbacks: readbacks + 1,
      },
    };
  }

  async studyExamStep(session, course, state, checkpoint, options) {
    const paperId = String(state.activity.id);
    const attemptId = await this.client.attemptId(session, course, paperId);
    const previousSubmit = await this.client.loadSubmit(session, attemptId);
    let attempt;
    if (previousSubmit && ['pending', 'unknown', 'submitted'].includes(previousSubmit.state)) {
      const stored = await this.client.loadAttempt(session, attemptId);
      if (!stored?.questions?.length) {
        return {
          status: 'needs_human',
          reason: '课程测验存在待核对的交卷请求，但作答快照缺失，请到官方页面核对',
          checkpoint: { ...checkpoint, exam_attempt_id: attemptId },
        };
      }
      attempt = {
        id: attemptId,
        paper_id: paperId,
        name: String(state.activity?.title ?? '课程测验'),
        questions: stored.questions,
        expires_at: null,
      };
      return this.studyExamReadback(session, course, attempt, checkpoint);
    }

    let opened;
    try {
      opened = await this.client.openExam(session, course, paperId);
    } catch (error) {
      if (error instanceof ModuleError && error.code === 'no_questions') {
        return {
          status: 'needs_human',
          reason: '课程测验没有可读取的题目，请在官方页面核对',
          checkpoint,
        };
      }
      throw error;
    }
    attempt = opened.attempt;
    const unsupportedQuestion = attempt.questions.find(question => question.kind === 'unsupported');
    if (unsupportedQuestion) {
      return {
        status: 'needs_human',
        reason: '课程测验包含暂不支持的题型，请在官方页面完成',
        checkpoint: { ...checkpoint, exam_attempt_id: attempt.id },
      };
    }

    const answers = {};
    const missing = [];
    for (const question of attempt.questions) {
      const fromInteraction = interactionAnswer(options, question.id);
      const candidate = fromInteraction.length
        ? fromInteraction
        : question.answer?.length
          ? question.answer
          : question.correct_answer?.length
            ? question.correct_answer
            : [];
      if (validPublicAnswer(question, candidate)) answers[question.id] = candidate;
      else missing.push(question);
    }
    if (missing.length) {
      return {
        status: 'needs_ai',
        questions: missing,
        reason: '课程测验需要作答（使用工作台模型）',
        checkpoint: { ...checkpoint, exam_attempt_id: attempt.id },
      };
    }

    try {
      await this.examWrite({
        session,
        course,
        attempt_id: attempt.id,
        answers,
        phase: 'submit',
      });
    } catch (error) {
      if (error instanceof ModuleError && error.code === 'platform_rejected' && /已记录/.test(error.message)) {
        return this.studyExamReadback(session, course, attempt, checkpoint);
      }
      return {
        status: 'unknown',
        reason: `课程测验交卷结果未知：${error.message}；不会自动重交`,
        checkpoint: { ...checkpoint, exam_attempt_id: attempt.id, exam_readbacks: 0 },
      };
    }
    return this.studyExamReadback(session, course, attempt, checkpoint);
  }

  async reviewStep(state, unit, checkpoint, options) {
    const budget = Math.floor(clamp(
      options.review_seconds ?? unit.duration_seconds ?? 0,
      1,
      3600,
    ));
    const reviewed = Math.max(0, Math.floor(Number(checkpoint.reviewed) || 0));
    if (reviewed >= budget) {
      return {
        status: 'completed',
        evidence: { reviewed_seconds: reviewed, original_state_preserved: true },
        checkpoint: { ...checkpoint, reviewed },
      };
    }
    const chunk = Math.min(this.settings.chunk_seconds, budget - reviewed);
    const executionId = String(options.execution_id ?? '');
    const now = await this.client.now();
    const saveAfter = Number(checkpoint.save_after);
    if (checkpoint.execution_id !== executionId || !Number.isFinite(saveAfter)) {
      const wait = chunk;
      return {
        status: 'in_progress',
        progress: { watched_seconds: reviewed },
        detail: `每日复习：${Math.floor(reviewed / 60)} 分钟`,
        wait_ms: wait * 1000,
        checkpoint: {
          ...checkpoint,
          reviewed,
          execution_id: executionId,
          save_after: now + wait,
        },
      };
    }
    if (now < saveAfter) {
      return {
        status: 'in_progress',
        progress: { watched_seconds: reviewed },
        detail: `每日复习：${Math.floor(reviewed / 60)} 分钟`,
        wait_ms: Math.max(1, Math.min(60, saveAfter - now)) * 1000,
        checkpoint,
      };
    }
    const next = Math.min(budget, reviewed + chunk);
    if (next >= budget) {
      return {
        status: 'completed',
        evidence: { reviewed_seconds: next, original_state_preserved: true },
        checkpoint: { ...checkpoint, reviewed: next },
      };
    }
    return {
      status: 'in_progress',
      progress: { watched_seconds: next },
      detail: `每日复习：${Math.floor(next / 60)} 分钟`,
      wait_ms: chunk * 1000,
      checkpoint: {
        ...checkpoint,
        reviewed: next,
        execution_id: executionId,
        save_after: now + chunk,
      },
    };
  }

  async popupStep(session, state, checkpoint, options, targetSeconds) {
    const items = asList(state.activity?.ext?.examItems);
    if (!items.length) return { handled: false, checkpoint };
    const answered = new Set(Array.isArray(checkpoint.answered_ids) ? checkpoint.answered_ids.map(String) : []);
    const due = items.filter(item => {
      const id = String(item?.id ?? '');
      const at = Number(item?.workDuration);
      return id && Number.isFinite(at) && at > 0 && at <= targetSeconds && !answered.has(id);
    });
    if (!due.length) return { handled: false, checkpoint };
    const questions = await this.client.buildQuestions(session, due, null, { allowCorrect: true });
    if (!questions.length) {
      const ids = due.map(item => String(item?.id ?? '')).filter(Boolean);
      return {
        handled: true,
        checkpoint: {
          ...checkpoint,
          answered_ids: [...answered, ...ids],
        },
      };
    }
    const missing = questions.filter(question => interactionAnswer(options, question.id).length === 0);
    if (missing.length > 0) {
      return {
        handled: true,
        result: {
          status: 'needs_ai',
          questions: missing.map(question => this.client.stripPrivate(question)),
          reason: '视频弹题需要作答',
          checkpoint,
        },
      };
    }
    const ids = questions.map(question => question.id);
    return {
      handled: true,
      checkpoint: {
        ...checkpoint,
        answered_ids: [...answered, ...ids],
      },
    };
  }

  async timedStep(session, course, state, unit, checkpoint, options, type, operation) {
    const activity = state.activity;
    const required = activityRequiredSeconds(activity, unit);
    const current = Math.max(
      0,
      Math.floor(Number(state.duration) || 0),
      Math.floor(Number(checkpoint.seconds) || 0),
      Math.floor(Number(unit.watched_seconds) || 0),
    );
    const executionId = String(options.execution_id ?? '');
    const speed = speedFactor(options);
    const trial = operation === 'trial';
    const limit = Math.floor(clamp(options.limit_seconds ?? 60, 1, 180));
    const requestedTarget = trial
      ? Number.isFinite(checkpoint.trial_target_seconds) ? checkpoint.trial_target_seconds : current + limit
      : required;
    // QLTeacher rejects duration writes at exactly the study-time threshold. The
    // player sends -1 for completion instead, and trial must stop before that
    // threshold so it can never accidentally finish the platform unit.
    const target = trial
      ? Math.max(current, Math.min(requestedTarget, required - 1))
      : requestedTarget;
    if (trial) checkpoint = { ...checkpoint, trial_target_seconds: target };
    const verifyAttempts = Math.max(0, Math.floor(Number(checkpoint.verify_attempts) || 0));

    const finish = async lastCurrent => {
      if (verifyAttempts >= this.settings.study_verify_attempts) {
        return {
          status: 'needs_human',
          reason: required > 0
            ? '学习进度已保存，但平台尚未确认完成，请在官方页面核对后继续'
            : '平台没有提供学习时长，且完成请求未获确认，请到官方页面核对',
          checkpoint: {
            ...checkpoint,
            seconds: lastCurrent,
            execution_id: executionId,
            verify_attempts: verifyAttempts,
          },
        };
      }
      const response = await this.client.saveProgress(session, state.info, state, type, -1);
      const refreshed = await this.client.getActivity(session, course, activity.id);
      if (refreshed.finished) {
        return {
          status: 'completed',
          evidence: { platform_confirmed: true, watched_seconds: Math.max(lastCurrent, required) },
          checkpoint: {
            ...checkpoint,
            seconds: Math.max(lastCurrent, required),
            execution_id: executionId,
            verify_attempts: 0,
          },
        };
      }
      return {
        status: 'in_progress',
        progress: { watched_seconds: lastCurrent },
        detail: '正在回读平台完成状态',
        wait_ms: 2000,
        checkpoint: {
          ...checkpoint,
          seconds: lastCurrent,
          execution_id: executionId,
          save_after: (await this.client.now()) + 2,
          verify_attempts: verifyAttempts + 1,
          last_status: response?.actStatus ?? null,
        },
      };
    };

    if (required <= 0) {
      if (trial) {
        return {
          status: 'completed',
          evidence: { trial: true, watched_seconds: current },
          checkpoint: { ...checkpoint, seconds: current, execution_id: executionId },
        };
      }
      return finish(current);
    }

    const nextChunk = Math.min(this.settings.chunk_seconds, Math.max(1, target - current));
    const popupTarget = Math.min(target, current + nextChunk);
    const popup = await this.popupStep(session, state, checkpoint, options, popupTarget);
    if (popup.handled && popup.result) return popup.result;
    checkpoint = popup.checkpoint ?? checkpoint;

    if (current >= target) {
      if (trial) {
        return {
          status: 'completed',
          evidence: { trial: true, watched_seconds: current },
          checkpoint: { ...checkpoint, seconds: current },
        };
      }
      return finish(current);
    }

    const now = await this.client.now();
    const saveAfter = Number(checkpoint.save_after);
    const sameExecution = checkpoint.execution_id === executionId;
    const initialChunk = Math.min(this.settings.chunk_seconds, Math.max(1, target - current));
    const initialWait = Math.max(1, Math.min(60, Math.ceil(initialChunk / speed)));
    if (!sameExecution || !Number.isFinite(saveAfter)) {
      return {
        status: 'in_progress',
        progress: { watched_seconds: current },
        detail: progressText(current, required),
        wait_ms: initialWait * 1000,
        checkpoint: {
          ...checkpoint,
          seconds: current,
          execution_id: executionId,
          save_after: now + initialWait,
        },
      };
    }
    if (now < saveAfter) {
      return {
        status: 'in_progress',
        progress: { watched_seconds: current },
        detail: progressText(current, required),
        wait_ms: Math.max(1, Math.min(60, saveAfter - now)) * 1000,
        checkpoint,
      };
    }

    const chunk = Math.min(this.settings.chunk_seconds, Math.max(1, target - current));
    if (!trial && current + chunk >= target) {
      return finish(current);
    }
    const saveOffset = Math.min(target, current + chunk);
    const response = await this.client.saveProgress(session, state.info, state, type, saveOffset);
    if (trial && saveOffset >= target) {
      return {
        status: 'completed',
        evidence: { trial: true, watched_seconds: saveOffset },
        checkpoint: {
          ...checkpoint,
          seconds: saveOffset,
          execution_id: executionId,
          verify_attempts: 0,
        },
      };
    }
    if (Number(response?.actStatus) === 1) {
      const refreshed = await this.client.getActivity(session, course, activity.id);
      if (refreshed.finished) {
        return {
          status: 'completed',
          evidence: { platform_confirmed: true, watched_seconds: saveOffset },
          checkpoint: {
            ...checkpoint,
            seconds: saveOffset,
            execution_id: executionId,
            verify_attempts: 0,
          },
        };
      }
    }
    const remaining = Math.max(0, target - saveOffset);
    const nextWait = remaining <= 0
      ? 1
      : Math.max(1, Math.min(60, Math.ceil(Math.min(this.settings.chunk_seconds, remaining) / speed)));
    return {
      status: 'in_progress',
      progress: { watched_seconds: saveOffset },
      detail: progressText(saveOffset, required),
      wait_ms: nextWait * 1000,
      checkpoint: {
        ...checkpoint,
        seconds: saveOffset,
        execution_id: executionId,
        save_after: (await this.client.now()) + nextWait,
        verify_attempts: 0,
        last_status: response?.actStatus ?? null,
      },
    };
  }

  async resourceStep(session, course, state, checkpoint, options) {
    const activity = state.activity;
    const items = asList(activity?.ext?.resourceItems);
    if (!items.length) {
      return {
        status: 'needs_human',
        reason: '该资源活动没有可逐项打开的文件，请到官方页面核对',
        checkpoint,
      };
    }
    const executionId = String(options.execution_id ?? '');
    const index = Math.max(0, Math.floor(Number(checkpoint.resource_index) || 0));
    const attempts = Math.max(0, Math.floor(Number(checkpoint.verify_attempts) || 0));
    const now = await this.client.now();
    const saveAfter = Number(checkpoint.save_after);
    if (checkpoint.execution_id !== executionId || !Number.isFinite(saveAfter)) {
      return {
        status: 'in_progress',
        progress: { watched_seconds: Math.min(index, items.length) },
        detail: `资源活动：准备打开第 ${Math.min(index + 1, items.length)} / ${items.length} 项`,
        wait_ms: 1000,
        checkpoint: {
          ...checkpoint,
          resource_index: index,
          execution_id: executionId,
          save_after: now + 1,
        },
      };
    }
    if (now < saveAfter) {
      return {
        status: 'in_progress',
        progress: { watched_seconds: Math.min(index, items.length) },
        detail: `资源活动：已处理 ${Math.min(index, items.length)} / ${items.length} 项`,
        wait_ms: Math.max(1, Math.min(60, saveAfter - now)) * 1000,
        checkpoint,
      };
    }
    if (index >= items.length) {
      if (attempts >= this.settings.study_verify_attempts) {
        return {
          status: 'needs_human',
          reason: '资源活动已逐项打开，但平台仍未确认完成，请在官方页面核对',
          checkpoint,
        };
      }
      return {
        status: 'in_progress',
        progress: { watched_seconds: items.length },
        detail: '资源活动已逐项打开，正在回读平台完成状态',
        wait_ms: 2000,
        checkpoint: {
          ...checkpoint,
          resource_index: items.length,
          execution_id: executionId,
          save_after: now + 2,
          verify_attempts: attempts + 1,
        },
      };
    }
    const item = items[index];
    const itemId = String(item?.id ?? '');
    if (!itemId) {
      return {
        status: 'needs_human',
        reason: '平台资源条目缺少编号，请到官方页面核对',
        checkpoint,
      };
    }
    await this.client.saveResource(session, state.info, state, itemId);
    const refreshed = await this.client.getActivity(session, course, activity.id);
    if (refreshed.finished) {
      return {
        status: 'completed',
        evidence: { platform_confirmed: true, watched_seconds: items.length },
        checkpoint: {
          ...checkpoint,
          resource_index: items.length,
          execution_id: executionId,
          verify_attempts: 0,
        },
      };
    }
    return {
      status: 'in_progress',
      progress: { watched_seconds: index + 1 },
      detail: `资源活动：已处理 ${index + 1} / ${items.length} 项`,
      wait_ms: 1000,
      checkpoint: {
        ...checkpoint,
        resource_index: index + 1,
        execution_id: executionId,
        save_after: (await this.client.now()) + 1,
        verify_attempts: 0,
      },
    };
  }

  async examOpen(params) {
    const session = String(params.session ?? '');
    const course = params.course;
    const paperId = String(params.paper_id ?? '');
    if (!session || !course?.id || !paperId) throw invalid('开卷参数不完整');
    return this.client.openExam(session, course, paperId);
  }

  async examReview(params) {
    const session = String(params.session ?? '');
    const course = params.course;
    const paperId = String(params.paper_id ?? '');
    if (!session || !course?.id || !paperId) throw invalid('回看参数不完整');
    const papers = await this.client.catalogPapers(session, course);
    const paper = papers.find(item => item.id === paperId);
    if (!paper) throw rejected('该试卷已不在课程目录中');
    if (!paper.done) throw rejected('试卷尚未提交，不能查看解析');
    return this.client.openExam(session, course, paperId, { review: true });
  }

  async examWrite(params) {
    const session = String(params.session ?? '');
    const attemptId = String(params.attempt_id ?? '');
    const phase = String(params.phase ?? '');
    const answers = params.answers && typeof params.answers === 'object' ? params.answers : {};
    if (!session || !attemptId) throw invalid('交卷参数不完整');
    const stored = await this.client.loadAttempt(session, attemptId);
    if (!stored) throw invalid('找不到本次作答记录，请重新打开试卷');
    if (!this.client.matchesCourse(stored, params.course)) throw invalid('作答记录不属于当前课程或研修项目');
    if (phase === 'draft') {
      return { done: true, cursor: 0, draft_supported: false };
    }
    if (phase !== 'submit') throw invalid('phase 只能是 draft 或 submit');
    const auth = await this.client.ensureAuth(session);
    const key = JSON.stringify([auth.account_raw, attemptId]);
    if (this.submitting.has(key)) throw rejected('本次交卷请求已记录，不能重复提交；请使用回读确认结果');
    this.submitting.add(key);
    try {
      return await this.submitAttempt(session, attemptId, stored, answers);
    } finally {
      this.submitting.delete(key);
    }
  }

  async submitAttempt(session, attemptId, stored, answers) {
    const previous = await this.client.loadSubmit(session, attemptId);
    if (previous && ['pending', 'unknown', 'submitted'].includes(previous.state)) {
      throw rejected('本次交卷请求已记录，不能重复提交；请使用回读确认结果');
    }
    const attempt = {
      questions: Array.isArray(stored.questions) ? stored.questions : [],
      judge_map: stored.judge_map ?? {},
    };
    if (!attempt.questions.length) throw invalid('本次作答缺少题目快照，请重新打开试卷');
    const platformAnswers = this.client.buildPlatformAnswers(attempt, answers);
    // Resolve/refresh the login before recording a submission intent, so a token
    // problem that happens before any HTTP write cannot leave an ambiguous lock.
    await this.client.ensureAuth(session);
    const intent = {
      state: 'pending',
      at: await this.client.now(),
      activity_id: stored.activity_id,
    };
    await this.client.saveSubmit(session, attemptId, intent);
    try {
      const response = await this.client.submitExam(
        session,
        { token: stored.token },
        stored.activity_id,
        platformAnswers,
      );
      await this.client.saveSubmit(session, attemptId, {
        ...intent,
        state: 'submitted',
        at: await this.client.now(),
        response,
      });
      return { done: true, cursor: 0 };
    } catch (error) {
      const code = error instanceof ModuleError ? error.code : 'platform_unavailable';
      if (['quiet_hours', 'net_blocked', 'task_cancelled'].includes(code)) {
        // The host rejected the request before it was sent. Keep the submission
        // intent empty so the task can retry after the pause/cancel is resolved.
        await this.client.saveSubmit(session, attemptId, null);
      } else {
        await this.client.saveSubmit(session, attemptId, {
          ...intent,
          state: 'unknown',
          at: await this.client.now(),
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      throw error;
    }
  }

  async examReadback(params) {
    const session = String(params.session ?? '');
    const course = params.course;
    const attemptId = String(params.attempt_id ?? '');
    if (!session || !course?.id || !attemptId) throw invalid('回读参数不完整');
    return this.client.readbackExam(session, course, attemptId);
  }
}

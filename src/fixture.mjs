import { invalid, unsupported } from './errors.mjs';

const COURSE_A = {
  id: 'fixture-course',
  recruit_id: 'fixture-project',
  name: '离线自动完成课程',
  kind: 'shared',
  kind_label: '离线课程',
  family: 'shared',
  progress: null,
  outline_available: true,
};

const COURSE_B = {
  id: 'fixture-course-exam',
  recruit_id: 'fixture-project',
  name: '离线测验课程',
  kind: 'shared',
  kind_label: '离线课程',
  family: 'shared',
  progress: null,
  outline_available: true,
};

function question(withCorrect = false) {
  return {
    id: 'fixture-q1',
    kind: 'single',
    text: '离线验证：请选择 A。',
    options: [
      { id: 'A', text: '正确选项' },
      { id: 'B', text: '其他选项' },
    ],
    answer: [],
    ...(withCorrect ? { correct_answer: ['A'] } : {}),
    blanks: 0,
    images: [],
  };
}

function attempt(courseId) {
  return {
    id: `fixture-attempt-${courseId}`,
    paper_id: 'fixture-paper',
    name: '离线课程测验',
    expires_at: null,
    questions: [question()],
  };
}

/**
 * Explicit offline source for end-to-end Courseflow tests. It never calls
 * cw.net.fetch and never writes to the real platform.
 */
export class QLTeacherFixture {
  constructor({ host, settings }) {
    this.host = host;
    this.settings = settings;
  }

  async now() {
    const result = await this.host.call('cw.clock.now', {});
    const value = Number(result?.now);
    return Number.isFinite(value) ? value : Math.floor(Date.now() / 1000);
  }

  async loginState(session) {
    const result = await this.host.call('cw.state', {
      namespace: 'fixture',
      key: 'login',
      session,
    });
    return result?.value === true;
  }

  async setLoginState(session, value) {
    await this.host.call('cw.state', {
      namespace: 'fixture',
      key: 'login',
      value: Boolean(value),
      session,
    });
  }

  async submitted(session, course) {
    const result = await this.host.call('cw.state', {
      namespace: 'fixture',
      key: `submitted:${String(course?.id ?? '')}`,
      session,
    });
    return result?.value === true;
  }

  async setSubmitted(session, course, value) {
    await this.host.call('cw.state', {
      namespace: 'fixture',
      key: `submitted:${String(course?.id ?? '')}`,
      value: Boolean(value),
      session,
    });
  }

  async dispatch(method, params) {
    const session = String(params.session ?? '');
    const course = params.course;
    switch (method) {
      case 'auth.begin': {
        if (params.method !== 'password') throw unsupported('离线样例只支持密码登录');
        await this.setLoginState(session, false);
        const now = await this.now();
        return {
          challenge: {
            id: String(params.session ?? ''),
            kind: 'password',
            expires_at: now + 300,
            fields: [
              { name: 'username', label: '离线账号', type: 'text', required: true },
              { name: 'password', label: '离线密码', type: 'password', required: true },
            ],
          },
        };
      }
      case 'auth.submit':
        await this.setLoginState(session, true);
        return { state: 'waiting' };
      case 'auth.poll':
        return { state: await this.loginState(session) ? 'connected' : 'waiting' };
      case 'auth.complete':
      case 'auth.verify':
        return {
          display_name: '离线QLTeacher账号',
          account_raw: 'fixture-qlteacher-user',
          connected_at: await this.now(),
        };
      case 'auth.keepalive':
        return { ok: true, display_name: '离线QLTeacher账号', account_raw: 'fixture-qlteacher-user' };
      case 'catalog.courses':
        return { courses: [COURSE_A, COURSE_B] };
      case 'catalog.units': {
        if (!course?.id) throw invalid('缺少课程');
        const submitted = await this.submitted(session, course);
        const auto = this.settings.auto_finish_exams !== false;
        return {
          units: [
            {
              id: 'fixture-video',
              name: '离线视频',
              chapter_id: 'fixture-chapter-1',
              chapter_name: '离线第一章',
              lesson_id: String(course.id),
              kind: 'video',
              duration_seconds: 60,
              watched_seconds: 0,
              state: 'not_started',
              video_id: 'fixture-video',
              selectable: true,
            },
            {
              id: 'fixture-reading',
              name: '离线阅读',
              chapter_id: 'fixture-chapter-1',
              chapter_name: '离线第一章',
              lesson_id: String(course.id),
              kind: 'reading',
              duration_seconds: 0,
              watched_seconds: 0,
              state: 'not_started',
              video_id: null,
              selectable: true,
            },
            {
              id: 'fixture-exam',
              name: '离线课程测验',
              chapter_id: 'fixture-chapter-1',
              chapter_name: '离线第一章',
              lesson_id: String(course.id),
              kind: 'empty',
              duration_seconds: 0,
              watched_seconds: 0,
              state: submitted ? 'completed' : 'not_started',
              video_id: null,
              selectable: auto,
              ...(auto
                ? { selectable_note: '自动作答（使用工作台模型）' }
                : { selectable_note: '请在「课程测验」中完成' }),
            },
          ],
        };
      }
      case 'catalog.papers': {
        if (!course?.id) throw invalid('缺少课程');
        const submitted = await this.submitted(session, course);
        return {
          papers: [{
            id: 'fixture-paper',
            name: '离线课程测验',
            category: '离线章节',
            available: true,
            done: submitted,
            can_redo: true,
            can_review: submitted,
            score: submitted ? 100 : null,
            attempts_left: submitted ? 0 : 1,
          }],
        };
      }
      case 'study.step': {
        const unit = params.unit;
        if (!unit?.id) throw invalid('缺少单元');
        const isExam = unit.id === 'fixture-exam' || unit.kind === 'empty';
        if (isExam) {
          if (this.settings.auto_finish_exams === false) {
            return { status: 'blocked', reason: '离线样例已关闭课程测验自动完成', checkpoint: params.checkpoint ?? null };
          }
          const submitted = await this.submitted(session, course);
          if (submitted) {
            return {
              status: 'completed',
              evidence: { fixture: true, platform_confirmed: false, score: 100 },
              checkpoint: params.checkpoint ?? null,
            };
          }
          const answers = params.options?.interaction_answers;
          const answer = Array.isArray(answers?.['fixture-q1']) ? answers['fixture-q1'] : [];
          if (!answer.length) {
            return {
              status: 'needs_ai',
              questions: [question(true)],
              reason: '离线课程测验使用平台公布答案自动完成',
              checkpoint: params.checkpoint ?? null,
            };
          }
          await this.setSubmitted(session, course, true);
          return {
            status: 'completed',
            evidence: { fixture: true, platform_confirmed: false, score: 100 },
            checkpoint: params.checkpoint ?? null,
          };
        }
        return {
          status: 'completed',
          evidence: { fixture: true, platform_confirmed: false },
          checkpoint: params.checkpoint ?? null,
        };
      }
      case 'exam.open':
      case 'exam.review':
      case 'exam.redo': {
        if (!course?.id) throw invalid('缺少课程');
        if (method === 'exam.redo') await this.setSubmitted(session, course, false);
        const value = attempt(course.id);
        if (method === 'exam.review') {
          value.questions = [question(true)];
        }
        return { ready: true, attempt: value };
      }
      case 'exam.write': {
        if (!course?.id) throw invalid('缺少课程');
        if (params.phase === 'submit') await this.setSubmitted(session, course, true);
        return { done: true, cursor: 0, draft_supported: false };
      }
      case 'exam.readback': {
        if (!course?.id) throw invalid('缺少课程');
        const submitted = await this.submitted(session, course);
        const id = String(params.attempt_id ?? `fixture-attempt-${course.id}`);
        if (!submitted) return { confirmed: false, attempt_id: id };
        return {
          confirmed: true,
          attempt_id: id,
          score: 100,
          graded_answers: { 'fixture-q1': ['A'] },
          review: { questions: [question(true)] },
        };
      }
      case 'exam.heartbeat':
        return { ok: true };
      default:
        throw unsupported(`离线样例没有实现 ${method}`);
    }
  }
}

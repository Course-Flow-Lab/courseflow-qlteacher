import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, privateDecrypt, randomBytes } from 'node:crypto';
import {
  createKeyPair,
  envelope,
  json,
  jwt,
  startHarness,
} from './harness.mjs';

const keyPair = createKeyPair();
const password = `test-only-${randomBytes(12).toString('hex')}`;
const account = { sub: '10001', name: '测试教师' };

function makePlatform(overrides = {}) {
  return {
    videoProgress: 30,
    videoFinished: false,
    docProgress: 0,
    docFinished: false,
    popupProgress: 0,
    popupFinished: false,
    resourceIndex: 0,
    resourceFinished: false,
    examFinished: false,
    examAnswers: null,
    examRightCount: 0,
    password,
    ...overrides,
  };
}

function videoActivity(platform) {
  return {
    id: 'video-1',
    title: '视频一',
    sessionType: 'video',
    mustLearn: 1,
    status: platform.videoFinished ? 1 : 0,
    ext: {
      studyTime: 120,
      duration: platform.videoProgress,
      resourceItems: [],
    },
  };
}

function popupActivity(platform) {
  return {
    id: 'video-popup',
    title: '弹题视频',
    sessionType: 'video',
    mustLearn: 1,
    status: platform.popupFinished ? 1 : 0,
    ext: {
      studyTime: 60,
      duration: platform.popupProgress,
      examItems: [
        {
          id: 'popup-1',
          type: 'single',
          itemType: 'question',
          title: '视频弹题：2 + 2 = ?',
          workDuration: 10,
          options: [
            { id: 'p-a', title: '3', right: false },
            { id: 'p-b', title: '4', right: true },
          ],
        },
      ],
    },
  };
}

function courseData(platform) {
  return {
    course: { courseId: 'ct-1', courseName: '测试课程' },
    finished: false,
    sections: [
      {
        id: 'section-1',
        title: '第一章',
        courseSessions: [
          videoActivity(platform),
          popupActivity(platform),
          {
            id: 'doc-1',
            title: '讲义文档',
            sessionType: 'doc',
            mustLearn: 1,
            status: platform.docFinished ? 1 : 0,
            ext: { studyTime: 60, duration: platform.docProgress, resourceItems: [{ url: 'handout.pdf' }] },
          },
          {
            id: 'exam-1',
            title: '第一章测验',
            sessionType: 'exam',
            mustLearn: 1,
            status: platform.examFinished ? 1 : 0,
            rightCount: platform.examRightCount,
            ext: { examItems: examItems() },
          },
          {
            id: 'link-1',
            title: '拓展链接',
            sessionType: 'link',
            mustLearn: 0,
            status: 0,
            ext: { studyTime: 0, links: [{ title: '资源站', url: 'https://example.com' }] },
          },
          {
            id: 'resource-1',
            title: '资源下载',
            sessionType: 'resource',
            mustLearn: 1,
            status: platform.resourceFinished ? 1 : 0,
            ext: {
              studyTime: 2,
              duration: platform.resourceIndex,
              resourceItems: [
                { id: 'r-1', fileName: 'a.pdf', url: 'a.pdf' },
                { id: 'r-2', fileName: 'b.pdf', url: 'b.pdf' },
              ],
            },
          },
        ],
      },
      {
        id: 'extended',
        title: '扩展资源',
        extendedResource: true,
        courseSessions: [
          {
            id: 'extra-1',
            title: '扩展视频',
            sessionType: 'video',
            mustLearn: 1,
            status: 0,
            ext: { studyTime: 30, duration: 0 },
          },
        ],
      },
    ],
  };
}

function examItems() {
  return [
    {
      id: 'q1',
      type: 'single',
      itemType: 'question',
      title: '1 + 1 = ?',
      options: [
        { id: 'a', title: '1' },
        { id: 'b', title: '2' },
      ],
    },
    {
      id: 'q2',
      type: 'multiple',
      itemType: 'question',
      title: '选择偶数',
      options: [
        { id: 'a', title: '2' },
        { id: 'b', title: '3' },
        { id: 'c', title: '4' },
      ],
    },
    {
      id: 'q3',
      type: 'trueorfalse',
      itemType: 'question',
      title: '地球是圆的',
      options: [
        { id: 't', title: '正确' },
        { id: 'f', title: '错误' },
      ],
    },
  ];
}

function examActivity(platform) {
  return {
    id: 'exam-1',
    title: '第一章测验',
    sessionType: 'exam',
    mustLearn: 1,
    status: platform.examFinished ? 1 : 0,
    rightCount: platform.examRightCount,
    ext: { examItems: examItems() },
  };
}

function makeHandler(platform) {
  const state = { calls: [] };
  const handler = async request => {
    const url = new URL(request.url);
    state.calls.push(request);
    if (url.hostname === 'passport.qlteacher.com' && url.pathname === '/api/oauth2/public-key') {
      return envelope({ publicKey: keyPair.publicKey });
    }
    if (url.hostname === 'passport.qlteacher.com' && url.pathname === '/api/oauth2/token') {
      const form = new URLSearchParams(request.body || '');
      const grant = form.get('grant_type');
      if (grant === 'password') {
        let submitted = '';
        try {
          submitted = privateDecrypt(
            {
              key: keyPair.privateKey,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            Buffer.from(form.get('password'), 'base64'),
          ).toString('utf8');
        } catch {
          submitted = '';
        }
        if (form.get('username') !== 'tester' || submitted !== platform.password) {
          return json({ code: 23001, msg: '您的用户名或密码错误', data: null });
        }
        return tokenResponse('access-1', 'refresh-1');
      }
      if (grant === 'refresh_token' && form.get('refresh_token') === 'refresh-1') {
        return tokenResponse('access-2', 'refresh-2');
      }
      return json({ code: 23001, msg: 'refresh token 无效', data: null });
    }
    if (url.hostname === 'account.qlteacher.com' && url.pathname === '/api/me') {
      return json({ id: account.sub, name: account.name });
    }
    if (url.hostname === 'yxjc.qlteacher.com' && url.pathname === '/api/lesson/lessons/my') {
      assert.equal(url.searchParams.get('projectId'), 'cz2026');
      return envelope([
        {
          id: 'group-1',
          name: '小学语文',
          lessons: [
            {
              id: 'lesson-1',
              name: '测试课程',
              mustLearn: true,
              allowLearn: true,
              lessonLearnStatus: { status: 0 },
            },
            {
              id: 'lesson-2',
              name: '已完成课程',
              mustLearn: false,
              allowLearn: true,
              lessonLearnStatus: { status: 1 },
            },
          ],
        },
      ]);
    }
    if (url.hostname === 'yxjc.qlteacher.com' && url.pathname === '/api/lesson/learning/url') {
      assert.equal(url.searchParams.get('lessonId'), 'lesson-1');
      return envelope('https://player.qlteacher.com/learning/ct-1');
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/course') {
      return envelope(courseData(platform));
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/activity/video-1') {
      return envelope({
        activity: videoActivity(platform),
        status: platform.videoFinished ? 1 : 0,
        duration: platform.videoProgress,
        actToken: 'act-video',
        learnMode: 2,
        updateDurationInterval: 60,
      });
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/activity/video-popup') {
      return envelope({
        activity: popupActivity(platform),
        status: platform.popupFinished ? 1 : 0,
        duration: platform.popupProgress,
        actToken: 'act-popup',
        learnMode: 2,
        updateDurationInterval: 60,
      });
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/activity/doc-1') {
      return envelope({
        activity: {
          id: 'doc-1',
          title: '讲义文档',
          sessionType: 'doc',
          mustLearn: 1,
          status: platform.docFinished ? 1 : 0,
          ext: { studyTime: 60, duration: platform.docProgress, resourceItems: [{ url: 'handout.pdf' }] },
        },
        status: platform.docFinished ? 1 : 0,
        duration: platform.docProgress,
        actToken: 'act-doc',
        learnMode: 2,
        updateDurationInterval: 60,
      });
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/activity/exam-1') {
      return envelope({
        activity: examActivity(platform),
        status: platform.examFinished ? 1 : 0,
        userAnswers: platform.examAnswers,
        actToken: 'act-exam',
        learnMode: 2,
      });
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/activity/resource-1') {
      return envelope({
        activity: {
          id: 'resource-1',
          title: '资源下载',
          sessionType: 'resource',
          mustLearn: 1,
          status: platform.resourceFinished ? 1 : 0,
          ext: {
            studyTime: 2,
            duration: platform.resourceIndex,
            resourceItems: [
              { id: 'r-1', fileName: 'a.pdf', url: 'a.pdf' },
              { id: 'r-2', fileName: 'b.pdf', url: 'b.pdf' },
            ],
          },
        },
        status: platform.resourceFinished ? 1 : 0,
        duration: platform.resourceIndex,
        actToken: 'act-resource',
        learnMode: 2,
      });
    }
    const popupMatch = /^\/api\/learning\/ct-1\/duration\/video\/video-popup\/[^/]+\/(-?\d+)$/.exec(url.pathname);
    if (popupMatch) {
      const offset = Number(popupMatch[1]);
      platform.popupProgress = offset < 0 ? platform.popupProgress : Math.max(platform.popupProgress, offset);
      if (offset < 0) platform.popupFinished = true;
      return envelope({ actStatus: offset < 0 ? 1 : 0 });
    }
    const videoMatch = /^\/api\/learning\/ct-1\/duration\/video\/[^/]+\/[^/]+\/(-?\d+)$/.exec(url.pathname);
    if (videoMatch) {
      const offset = Number(videoMatch[1]);
      if (offset >= 120) return json({ code: 400, msg: '学习进度不能等于完成阈值', data: null });
      if (offset < 0) {
        platform.videoProgress = 120;
        platform.videoFinished = true;
      } else {
        platform.videoProgress = Math.max(platform.videoProgress, offset);
      }
      return envelope({ actStatus: offset < 0 ? 1 : 0 });
    }
    const docMatch = /^\/api\/learning\/ct-1\/duration\/doc\/[^/]+\/[^/]+\/(-?\d+)$/.exec(url.pathname);
    if (docMatch) {
      const offset = Number(docMatch[1]);
      if (offset >= 60) return json({ code: 400, msg: '学习进度不能等于完成阈值', data: null });
      if (offset < 0) {
        platform.docProgress = 60;
        platform.docFinished = true;
      } else {
        platform.docProgress = Math.max(platform.docProgress, offset);
      }
      return envelope({ actStatus: platform.docFinished ? 1 : 0 });
    }
    const resourceMatch = /^\/api\/learning\/ct-1\/duration\/resource\/resource-1\/([^/]+)$/.exec(url.pathname);
    if (resourceMatch) {
      platform.resourceIndex += 1;
      if (platform.resourceIndex >= 2) platform.resourceFinished = true;
      return envelope({ actStatus: platform.resourceFinished ? 1 : 0 });
    }
    if (url.hostname === 'player.qlteacher.com' && url.pathname === '/api/learning/ct-1/test') {
      const body = JSON.parse(request.body || '{}');
      state.examSubmit = body;
      platform.examFinished = true;
      platform.examRightCount = 2;
      platform.examAnswers = body.answers.map(row => {
        const id = row.questionId;
        if (id === 'q1') return { questionId: id, answer: 'b', correct: true, rightAnswer: 'b' };
        if (id === 'q2') return { questionId: id, answer: 'a,c', correct: true, rightAnswer: 'a,c' };
        return { questionId: id, answer: 't', correct: false, rightAnswer: 'f' };
      });
      return envelope({
        actStatus: 1,
        answers: {
          q1: { userAnswer: 'b', correct: true, rightAnswer: 'b' },
          q2: { userAnswer: 'a,c', correct: true, rightAnswer: 'a,c' },
          q3: { userAnswer: 't', correct: false, rightAnswer: 'f' },
        },
      });
    }
    throw new Error(`unexpected request ${request.method} ${request.url}`);
  };
  handler.state = state;
  return handler;
}

function tokenResponse(access, refresh) {
  const exp = Math.floor(Date.now() / 1000) + 7200;
  return envelope({
    access_token: jwt({ sub: account.sub, name: account.name, exp, jti: access }),
    refresh_token: refresh,
    expires_in: 7200,
    token_type: 'Bearer',
  });
}

async function login(harness) {
  const begin = await harness.call('auth.begin', { method: 'password', session: 'ch_login' });
  assert.equal(begin.challenge.kind, 'password');
  assert.equal(begin.challenge.fields[0].name, 'username');
  const submitted = await harness.call('auth.submit', {
    challenge: 'ch_login',
    session: 'ch_login',
    fields: { username: 'tester', password },
  });
  assert.equal(submitted.state, 'connected');
  const polled = await harness.call('auth.poll', { challenge: 'ch_login', session: 'ch_login' });
  assert.equal(polled.state, 'connected');
  const identity = await harness.call('auth.complete', { challenge: 'ch_login', session: 'ch_login' });
  assert.equal(identity.account_raw, account.sub);
  assert.equal(identity.display_name, account.name);
  return 's_test';
}

test('describe matches the installed manifest', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    const result = await h.call('platform.describe', {
      module_api: 1,
      framework_version: '0.1.13',
      limits: { call_timeout_ms: 30_000 },
    });
    assert.equal(result.module.name, 'courseflow-qlteacher');
    assert.equal(result.platform.id, 'qlteacher');
    assert.deepEqual(result.platform.login, ['password']);
  } finally {
    await h.close();
  }
});

test('password login uses RSA-OAEP, exports identity and survives refresh', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const verify = await h.call('auth.verify', { session });
    assert.equal(verify.account_raw, account.sub);
    const key = 'auth\u0000token';
    const auth = h.state.get(key);
    auth.expires_at = h.clock + 60;
    h.state.set(key, auth);
    const keep = await h.call('auth.keepalive', { session });
    assert.equal(keep.ok, true);
    const refreshed = JSON.parse(Buffer.from(h.state.get(key).access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(refreshed.jti, 'access-2');
    assert.equal(h.fetchCalls.some(call => call.url.includes('grant_type=refresh_token') || call.body?.includes('refresh_token')), true);
  } finally {
    await h.close();
  }
});

test('wrong password is reported as a login failure without throwing', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    await h.call('auth.begin', { method: 'password', session: 'ch_bad' });
    const result = await h.call('auth.submit', {
      challenge: 'ch_bad',
      session: 'ch_bad',
      fields: { username: 'tester', password: 'wrong' },
    });
    assert.equal(result.state, 'failed');
    assert.match(result.message, /账号|密码/);
    const poll = await h.call('auth.poll', { challenge: 'ch_bad', session: 'ch_bad' });
    assert.equal(poll.state, 'failed');
  } finally {
    await h.close();
  }
});

test('a failed re-login is not masked by an old token in state', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    await login(h);
    await h.call('auth.begin', { method: 'password', session: 'ch_relogin' });
    const result = await h.call('auth.submit', {
      challenge: 'ch_relogin',
      session: 'ch_relogin',
      fields: { username: 'tester', password: 'wrong' },
    });
    assert.equal(result.state, 'failed');
    const poll = await h.call('auth.poll', { challenge: 'ch_relogin', session: 'ch_relogin' });
    assert.equal(poll.state, 'failed');
  } finally {
    await h.close();
  }
});

test('catalog maps lessons, chapters, activity kinds and exam selectability', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    assert.equal(courses.length, 2);
    assert.equal(courses[0].id, 'lesson-1');
    assert.equal(courses[0].recruit_id, 'cz2026');
    assert.equal(courses[1].progress, 100);
    const { units } = await h.call('catalog.units', { session, course: courses[0] });
    const byId = new Map(units.map(unit => [unit.id, unit]));
    assert.equal(byId.get('video-1').kind, 'video');
    assert.equal(byId.get('doc-1').kind, 'document');
    assert.equal(byId.get('exam-1').kind, 'empty');
    assert.equal(byId.get('exam-1').selectable, false);
    assert.equal(byId.get('link-1').selectable, false);
    assert.equal(byId.get('extra-1').selectable, false);
    assert.equal(byId.get('video-1').chapter_name, '第一章');
    assert.equal(byId.get('video-1').duration_seconds, 120);
    assert.equal(byId.get('video-1').state, 'in_progress');
    const { papers } = await h.call('catalog.papers', { session, course: courses[0] });
    assert.equal(papers.length, 1);
    assert.equal(papers[0].id, 'exam-1');
    assert.equal(papers[0].done, false);
    assert.equal(papers[0].can_review, false);
  } finally {
    await h.close();
  }
});

test('video study waits, saves offsets and confirms completion by readback', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026', chunk_seconds: 60 }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'video-1');
    const options = { operation: 'study', execution_id: 'task/1', speedup: false, max_speed: 1 };

    let result = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(result.status, 'in_progress');
    assert.equal(result.wait_ms, 60_000);
    assert.equal(platform.videoProgress, 30);
    assert.equal(h.fetchCalls.some(call => call.method === 'PUT'), false);

    h.advance(60);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.status, 'in_progress');
    assert.equal(platform.videoProgress, 90);
    assert.equal(result.wait_ms, 30_000);

    h.advance(30);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.status, 'completed');
    assert.equal(result.evidence.platform_confirmed, true);
    assert.equal(platform.videoProgress, 120);
    assert.equal(platform.videoFinished, true);
    const offsets = h.fetchCalls
      .filter(call => call.method === 'PUT' && call.url.includes('/duration/video/video-1/'))
      .map(call => Number(call.url.match(/\/(-?\d+)(?:\?|$)/)?.[1]));
    assert.deepEqual(offsets, [90, -1]);
  } finally {
    await h.close();
  }
});

test('1.5x speed shortens the wait but never the content offset', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026', chunk_seconds: 60 }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'video-1');
    const options = { operation: 'study', execution_id: 'task/speed', speedup: true, max_speed: 1.5 };
    let result = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(result.wait_ms, 40_000);
    h.advance(40);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(platform.videoProgress, 90);
    assert.equal(result.status, 'in_progress');
  } finally {
    await h.close();
  }
});

test('trial advances only the requested window and never finishes the platform unit', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026', chunk_seconds: 60 }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'video-1');
    const options = { operation: 'trial', execution_id: 'task/trial', speedup: false, limit_seconds: 30 };
    let result = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(result.status, 'in_progress');
    h.advance(30);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.status, 'completed');
    assert.equal(result.evidence.trial, true);
    assert.equal(platform.videoProgress, 60);
    assert.equal(platform.videoFinished, false);
    assert.equal(h.fetchCalls.some(call => call.method === 'PUT' && call.url.endsWith('/-1')), false);
  } finally {
    await h.close();
  }
});

test('review spends the requested time without writing platform progress', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026', chunk_seconds: 60 }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'video-1');
    const options = { operation: 'review', execution_id: 'task/review', review_seconds: 30 };
    let result = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(result.status, 'in_progress');
    assert.equal(result.wait_ms, 30_000);
    assert.equal(h.fetchCalls.some(call => call.method === 'PUT'), false);
    h.advance(30);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.status, 'completed');
    assert.equal(result.evidence.reviewed_seconds, 30);
    assert.equal(platform.videoProgress, 30);
    assert.equal(h.fetchCalls.some(call => call.method === 'PUT'), false);
  } finally {
    await h.close();
  }
});

test('video popup questions return needs_ai and are skipped after answers arrive', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026', chunk_seconds: 60 }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'video-popup');
    const options = { operation: 'study', execution_id: 'task/popup', speedup: false, max_speed: 1 };
    const first = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(first.status, 'needs_ai');
    assert.equal(first.questions[0].kind, 'single');
    assert.deepEqual(first.questions[0].correct_answer, ['p-b']);
    const second = await h.call('study.step', {
      session,
      course,
      unit,
      checkpoint: first.checkpoint,
      options: { ...options, interaction_answers: { 'popup-1': ['p-b'] } },
    });
    assert.equal(second.status, 'in_progress');
    assert.equal(second.checkpoint.answered_ids.includes('popup-1'), true);
  } finally {
    await h.close();
  }
});

test('document study uses the doc duration endpoint and confirms completion', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026', chunk_seconds: 60 }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'doc-1');
    const options = { operation: 'study', execution_id: 'task/doc', speedup: false };
    let result = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(result.status, 'in_progress');
    h.advance(60);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.status, 'completed');
    assert.equal(platform.docProgress, 60);
    assert.equal(h.fetchCalls.some(call => call.method === 'PUT' && call.url.includes('/duration/doc/doc-1/')), true);
  } finally {
    await h.close();
  }
});

test('resource activities are opened item by item until readback confirms completion', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { units } = await h.call('catalog.units', { session, course });
    const unit = units.find(item => item.id === 'resource-1');
    const options = { operation: 'study', execution_id: 'task/resource', speedup: false };
    let result = await h.call('study.step', { session, course, unit, checkpoint: null, options });
    assert.equal(result.status, 'in_progress');
    h.advance(1);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.checkpoint.resource_index, 1);
    h.advance(1);
    result = await h.call('study.step', { session, course, unit, checkpoint: result.checkpoint, options });
    assert.equal(result.status, 'completed');
    assert.equal(platform.resourceFinished, true);
  } finally {
    await h.close();
  }
});

test('exam opens, drafts locally, submits real platform answers and reads back confirmed results', async () => {
  const platform = makePlatform();
  const handler = makeHandler(platform);
  const h = await startHarness({
    settings: { project_id: 'cz2026' },
    fetch: handler,
    questionBank: {
      lookup: () => ({ correct: null, wrong: [], updated_at: null }),
    },
  });
  try {
    const session = await login(h);
    const { courses } = await h.call('catalog.courses', { session });
    const course = courses[0];
    const { papers } = await h.call('catalog.papers', { session, course });
    const paper = papers[0];
    const opened = await h.call('exam.open', {
      session,
      course,
      paper_id: paper.id,
      request_id: 'task/exam/0',
    });
    assert.equal(opened.ready, true);
    assert.equal(opened.attempt.questions.length, 3);
    assert.deepEqual(opened.attempt.questions.map(q => q.kind), ['single', 'multiple', 'judge']);
    assert.deepEqual(opened.attempt.questions[2].options.map(o => o.id), ['true', 'false']);

    const attemptId = opened.attempt.id;
    const answers = {
      q1: ['b'],
      q2: ['a', 'c'],
      q3: ['true'],
    };
    const draft = await h.call('exam.write', { session, course, attempt_id: attemptId, answers, phase: 'draft' });
    assert.equal(draft.done, true);
    assert.equal(draft.draft_supported, false);
    assert.equal(handler.state.examSubmit, undefined);

    const submitted = await h.call('exam.write', { session, course, attempt_id: attemptId, answers, phase: 'submit' });
    assert.equal(submitted.done, true);
    assert.deepEqual(handler.state.examSubmit.answers, [
      { questionId: 'q1', answer: 'b' },
      { questionId: 'q2', answer: 'a,c' },
      { questionId: 'q3', answer: 't' },
    ]);
    const duplicate = await h.call('exam.write', { session, course, attempt_id: attemptId, answers, phase: 'submit' }).catch(error => error);
    assert.equal(duplicate.code, 'platform_rejected');
    assert.equal(handler.state.calls.filter(call => call.url.endsWith('/test')).length, 1);

    const readback = await h.call('exam.readback', { session, course, attempt_id: attemptId });
    assert.equal(readback.confirmed, true);
    assert.equal(readback.attempt_id, attemptId);
    assert.equal(readback.score, 67);
    assert.deepEqual(readback.graded_answers.q1, ['b']);
    assert.deepEqual(readback.graded_answers.q2, ['a', 'c']);
    assert.deepEqual(readback.review.questions[2].correct_answer, ['false']);
    assert.equal(h.bankCalls.filter(call => call.method === 'cw.question_bank.confirm').length >= 2, true);
    assert.equal(h.bankCalls.filter(call => call.method === 'cw.question_bank.record').length, 1);
  } finally {
    await h.close();
  }
});

test('unknown methods and unsupported redo return stable errors', async () => {
  const platform = makePlatform();
  const h = await startHarness({ settings: { project_id: 'cz2026' }, fetch: makeHandler(platform) });
  try {
    const session = await login(h);
    const unknown = await h.call('catalog.unknown', { session }).catch(error => error);
    assert.equal(unknown.code, 'unsupported_operation');
    const redo = await h.call('exam.redo', { session, course: { id: 'lesson-1', recruit_id: 'cz2026' }, paper_id: 'exam-1' }).catch(error => error);
    assert.equal(redo.code, 'unsupported_operation');
  } finally {
    await h.close();
  }
});

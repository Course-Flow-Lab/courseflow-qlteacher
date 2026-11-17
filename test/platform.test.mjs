import test from 'node:test';
import assert from 'node:assert/strict';
import { QLTeacherClient } from '../src/platform.mjs';

function client(resources = {}) {
  const value = new QLTeacherClient({ host: {}, settings: {} });
  value.getText = async (_session, path) => {
    assert.ok(Object.hasOwn(resources, path), `unexpected resource: ${path}`);
    return resources[path];
  };
  return value;
}

test('FastDFS judge options retain their meaning when the correct answer is false', async () => {
  const api = client({
    'question.txt': '<p>1 + 1 = 3</p>',
    'true.txt': '<p>正确</p>',
    'false.txt': '<p>错误</p>',
  });
  const raw = {
    id: 'judge', type: 'trueorfalse', title: 'question.txt', ext: { titleType: 'fastdfs' },
    options: [{ id: 'yes-id', title: 'true.txt', right: false }, { id: 'no-id', title: 'false.txt', right: true }],
  };
  const question = await api.question('session', raw, { answer: 'no-id' });
  assert.deepEqual(question._judge_map, { true: 'yes-id', false: 'no-id' });
  assert.deepEqual(question.answer, ['false']);
  assert.deepEqual(question.correct_answer, ['false']);
  const [readback] = await api.buildQuestions('session', [raw], null, {
    allowCorrect: true,
    submitResponse: { answers: { judge: { userAnswer: 'no-id', rightAnswer: 'no-id', correct: true } } },
  });
  assert.deepEqual(readback.answer, ['false']);
  assert.deepEqual(readback.correct_answer, ['false']);
  assert.deepEqual(api.buildPlatformAnswers({ questions: [question], judge_map: { judge: question._judge_map } }, { judge: ['false'] }),
    [{ questionId: 'judge', answer: 'no-id' }]);
});

test('judge labels take precedence over numeric option IDs and answer correctness flags', async () => {
  const api = client();
  const question = await api.question('session', {
    id: 'judge', type: 'trueorfalse', title: '判断题',
    options: [{ id: '0', title: '<p>正确</p>' }, { id: '1', title: '<p>错误</p>', right: true }],
  }, { answer: '1' });
  assert.deepEqual(question._judge_map, { true: '0', false: '1' });
  assert.deepEqual(question.answer, ['false']);
  assert.deepEqual(question.correct_answer, ['false']);
});

test('an unlabeled judge cannot infer truth from which answer was marked correct', async () => {
  await assert.rejects(client().question('session', {
    id: 'judge', type: 'trueorfalse', title: '判断题',
    options: [{ id: 'x', title: '选项甲', right: false }, { id: 'y', title: '选项乙', right: true }],
  }), { code: 'platform_protocol_changed' });
});

test('invalid or unsupported answers are rejected before they reach the platform', () => {
  const api = client();
  const question = { id: 'q', kind: 'single', options: [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }] };
  for (const answers of [['missing'], ['a', 'b'], ['a', 'a']]) {
    assert.throws(() => api.buildPlatformAnswers({ questions: [question] }, { q: answers }), { code: 'invalid_params' });
  }
  assert.throws(() => api.buildPlatformAnswers({ questions: [{ ...question, kind: 'unsupported' }] }, { q: ['a'] }),
    { code: 'unsupported_operation' });
});

test('FastDFS answer explanations are resolved to content', async () => {
  const question = await client({ 'explanation.txt': '<p>因为 1 + 1 = 2。</p>' }).question('session', {
    id: 'q', type: 'single', title: '1 + 1 = ?', options: [{ id: 'a', title: '2', right: true }],
    answerDesc: 'explanation.txt', ext: { answerDescType: 'fastdfs' },
  });
  assert.equal(question.explanation, '因为 1 + 1 = 2。');
});

test('nullable duration and score fields do not hide the platform fallback values', async () => {
  const api = client();
  api.getCourseData = async () => ({ data: { sections: [{ id: 'chapter', courseSessions: [
    { id: 'video', sessionType: 'video', standard: 120, ext: { studyTime: null } },
    { id: 'exam', sessionType: 'exam', score: 75, ext: { score: null } },
    { id: 'ungraded', sessionType: 'exam', score: null, ext: { score: null } },
  ] }] } });
  const units = await api.catalogUnits('session', { id: 'course' });
  assert.equal(units[0].duration_seconds, 120);
  const papers = await api.catalogPapers('session', { id: 'course' });
  assert.equal(papers[0].score, 75);
  assert.equal(papers[1].score, null);
});

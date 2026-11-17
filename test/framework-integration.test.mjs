import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleRoot = path.resolve(here, '..');
const frameworkRoot = path.resolve(here, '..', '..', 'courseflow-framework');
const frameworkHarness = path.join(frameworkRoot, 'test', 'support', 'harness.ts');
const available = fs.existsSync(frameworkHarness);

test(
  'fixture source autocompletes a course, then an exam answer task uses framework LLM with no platform writes',
  { skip: available ? false : 'courseflow-framework is not present next to this repo' },
  async t => {
    const { boot, call, setupAdmin, waitFor } = await import(pathToFileURL(frameworkHarness).href);
    const { runtime } = await boot('courseflow-qlteacher-integration-');
    t.after(async () => runtime.close());

    runtime.manager.install(process.env.QLTEACHER_MODULE_PACKAGE || moduleRoot);
    runtime.manager.configure('qlteacher', { source: 'fixture' });

    const session = await setupAdmin(runtime);
    const login = await call(runtime, {
      method: 'POST',
      url: '/api/platforms/qlteacher/login',
      session,
      body: { method: 'password' },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const challenge = login.body.challenge.id;
    const submitted = await call(runtime, {
      method: 'POST',
      url: `/api/platforms/qlteacher/login/${encodeURIComponent(challenge)}/submit`,
      session,
      body: { fields: { username: 'fixture', password: 'fixture' } },
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const polled = await call(runtime, {
      method: 'POST',
      url: `/api/platforms/qlteacher/login/${encodeURIComponent(challenge)}/poll`,
      session,
    });
    assert.equal(polled.body.state, 'connected');

    const courses = (await call(runtime, { url: '/api/platforms/qlteacher/courses', session })).body.courses;
    assert.equal(courses.length, 2);
    const course = courses.find(item => item.id === 'fixture-course');
    const courseRoot = `/api/platforms/qlteacher/courses/${encodeURIComponent(course.id)}/${encodeURIComponent(course.recruit_id)}`;
    const units = (await call(runtime, { url: `${courseRoot}/units`, session })).body.units;
    assert.equal(units.length, 2);
    assert.deepEqual(units.map(unit => unit.id).sort(), ['fixture-reading', 'fixture-video']);

    let generations = 0;
    runtime.ai.generate = async () => {
      generations += 1;
      return '{"answer":["A"],"explanation":"fixture answer"}';
    };

    const study = await call(runtime, {
      method: 'POST',
      url: `${courseRoot}/study`,
      session,
      body: { unit_ids: units.map(unit => unit.id) },
    });
    assert.equal(study.status, 200, JSON.stringify(study.body));
    const studyTask = await waitFor(runtime, session, study.body.task.id, 'completed', 20_000);
    assert.equal(studyTask.progress, 100);
    assert.deepEqual((studyTask.completed ?? []).sort(), ['fixture-reading', 'fixture-video']);
    assert.equal(generations, 0, 'the playable fixture course does not need the LLM');

    const second = courses.find(item => item.id === 'fixture-course-exam');
    const secondRoot = `/api/platforms/qlteacher/courses/${encodeURIComponent(second.id)}/${encodeURIComponent(second.recruit_id)}`;
    const papers = (await call(runtime, { url: `${secondRoot}/catalog/papers`, session })).body.papers;
    assert.equal(papers.length, 1);
    assert.equal(papers[0].done, false);

    const answer = await call(runtime, {
      method: 'POST',
      url: `${secondRoot}/jobs`,
      session,
      body: {
        operation: 'answer',
        item_ids: ['fixture-paper'],
        options: { use_ai: true, auto_submit: true },
      },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await waitFor(runtime, session, answer.body.task.id, 'completed', 20_000);
    const detail = await call(runtime, { url: `/api/tasks/${encodeURIComponent(answer.body.task.id)}`, session });
    assert.equal(detail.body.workflow.records[0].confirmed, true);
    assert.equal(detail.body.workflow.records[0].score, 100);
    assert.ok(generations >= 1, 'the standalone answer task should use the framework LLM');

    const writes = runtime.db.get('SELECT COUNT(*) AS n FROM write_ledger').n;
    assert.equal(writes, 0, 'fixture source must not issue platform write requests');
  },
);

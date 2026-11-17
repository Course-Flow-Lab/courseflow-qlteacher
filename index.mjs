import { readFileSync } from 'node:fs';
import { HostBridge } from './src/rpc.mjs';
import { QLTeacherModule } from './src/module.mjs';

const manifest = JSON.parse(readFileSync(new URL('./courseflow.module.json', import.meta.url), 'utf8'));

let settings = {};
try {
  settings = JSON.parse(process.env.CF_MODULE_SETTINGS || '{}');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings must be an object');
} catch {
  process.stderr.write('QLTeacher 模块设置必须是 JSON 对象\n');
  process.exit(2);
}

const host = new HostBridge();
const module = new QLTeacherModule({ host, manifest, settings });
host.start((method, params) => module.dispatch(method, params));

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function safeLog(value) {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token]')
    .replace(/(authorization|password|access_token|refresh_token|cookie)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(-2000);
}

export function createKeyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.test`;
}

export function envelope(data, code = 200, msg = '操作成功') {
  return {
    status: 200,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ code, msg, data }),
  };
}

export function json(value, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
    body: JSON.stringify(value),
  };
}

export function text(body, status = 200, contentType = 'text/html;charset=utf-8') {
  return {
    status,
    headers: { 'content-type': contentType },
    body: String(body),
  };
}

export function empty(status = 200) {
  return { status, headers: {}, body: '' };
}

export class ModuleHarness {
  constructor({ settings = {}, fetch, questionBank, now = Math.floor(Date.now() / 1000) }) {
    this.settings = settings;
    this.fetchHandler = fetch;
    this.questionBank = questionBank ?? {};
    this.clock = now;
    this.state = new Map();
    this.fetchCalls = [];
    this.bankCalls = [];
    this.pending = new Map();
    this.nextId = 1;
    this.child = null;
    this.closed = false;
    this.stderr = '';
  }

  advance(seconds) {
    this.clock += seconds;
  }

  async start() {
    this.child = spawn(process.execPath, [path.join(root, 'index.mjs')], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TZ: 'UTC',
        CF_MODULE_SETTINGS: JSON.stringify(this.settings),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => this.onLine(line));
    this.child.once('exit', (code, signal) => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`module exited code=${code} signal=${signal}\n${safeLog(this.stderr)}`));
      }
      this.pending.clear();
    });
    return this;
  }

  onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try { message = JSON.parse(trimmed); } catch { return; }
    if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
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
      void this.handleHostCall(message);
    }
  }

  async handleHostCall(message) {
    let result;
    try {
      result = await this.hostCall(message.method, message.params ?? {});
      this.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error.code || 'test_host_error', message: error.message || String(error) },
      });
    }
  }

  write(message) {
    if (this.closed || !this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async hostCall(method, params) {
    switch (method) {
      case 'cw.clock.now':
        return { now: this.clock };
      case 'cw.state': {
        const key = `${params.namespace}\u0000${params.key}`;
        if (Object.hasOwn(params, 'value')) {
          this.state.set(key, structuredClone(params.value));
          return {};
        }
        return { value: this.state.has(key) ? structuredClone(this.state.get(key)) : null };
      }
      case 'cw.net.fetch':
        return this.netFetch(params);
      case 'cw.question_bank.lookup': {
        this.bankCalls.push({ method, params });
        const handler = this.questionBank.lookup;
        return handler ? handler(params) : { correct: null, wrong: [], updated_at: null };
      }
      case 'cw.question_bank.confirm': {
        this.bankCalls.push({ method, params });
        const handler = this.questionBank.confirm;
        return handler ? handler(params) : { ok: true };
      }
      case 'cw.question_bank.record': {
        this.bankCalls.push({ method, params });
        const handler = this.questionBank.record;
        return handler ? handler(params) : { ok: true };
      }
      case 'cw.log':
        return {};
      default:
        throw Object.assign(new Error(`unsupported host method ${method}`), { code: 'unsupported_operation' });
    }
  }

  encodeBody(request) {
    const { body, encoding = 'raw' } = request;
    if (body === undefined) return undefined;
    if (encoding === 'json') return JSON.stringify(body);
    if (encoding === 'form') return new URLSearchParams(body).toString();
    if (encoding === 'query') return undefined;
    return typeof body === 'string' ? body : JSON.stringify(body);
  }

  async netFetch(params) {
    let url = String(params.url);
    if (params.encoding === 'query' && params.body) {
      const query = new URLSearchParams(params.body).toString();
      url += `${url.includes('?') ? '&' : '?'}${query}`;
    }
    const request = {
      session: params.session,
      method: String(params.method || 'GET').toUpperCase(),
      url,
      headers: params.headers || {},
      body: this.encodeBody(params),
      stage: params.stage || 'read',
      commit: params.commit === true,
    };
    this.fetchCalls.push(request);
    return this.fetchHandler(request, this);
  }

  call(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`module call ${method} timed out\n${safeLog(this.stderr)}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async close() {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function startHarness(options) {
  return new ModuleHarness(options).start();
}

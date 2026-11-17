import { createInterface } from 'node:readline';
import { ModuleError, asModuleError } from './errors.mjs';

const MAX_HOST_CALL_MS = 28_000;

/**
 * One NDJSON JSON-RPC channel. stdout is protocol-only; diagnostics go to stderr.
 * Host calls are multiplexed with framework calls, exactly as the module API requires.
 */
export class HostBridge {
  constructor({ input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
    this.input = input;
    this.output = output;
    this.error = error;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.lines = createInterface({ input });
  }

  write(message) {
    if (this.closed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  log(level, message, fields) {
    const suffix = fields && typeof fields === 'object' ? ` ${JSON.stringify(fields)}` : '';
    this.error.write(`[qlteacher] ${level} ${message}${suffix}\n`);
  }

  call(method, params = {}, { timeoutMs = MAX_HOST_CALL_MS } = {}) {
    if (this.closed) return Promise.reject(new ModuleError('module_unavailable', '模块正在退出'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ModuleError('platform_unavailable', `宿主调用 ${method} 超时`));
      }, Math.max(1, Math.min(MAX_HOST_CALL_MS, Number(timeoutMs) || MAX_HOST_CALL_MS)));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  start(onRequest) {
    this.lines.on('line', line => {
      const text = line.trim();
      if (!text) return;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        this.log('warn', '忽略无效 JSON 协议行');
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
        this.receive(message);
        return;
      }
      if (typeof message.method !== 'string' || message.id === undefined) return;
      void this.respond(message, onRequest);
    });
    this.lines.on('close', () => this.shutdown(0));
    process.once('SIGTERM', () => this.shutdown(0));
    process.once('SIGINT', () => this.shutdown(0));
  }

  receive(message) {
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new ModuleError(
        typeof message.error.code === 'string' ? message.error.code : 'host_error',
        typeof message.error.message === 'string' ? message.error.message : '宿主调用失败',
      ));
    } else {
      waiter.resolve(message.result);
    }
  }

  async respond(request, onRequest) {
    try {
      const result = await onRequest(request.method, request.params ?? {});
      this.write({ jsonrpc: '2.0', id: request.id, result: result ?? {} });
    } catch (error) {
      const failure = asModuleError(error);
      if (!(error instanceof ModuleError)) this.log('warn', `调用 ${request.method} 失败：${failure.code}`);
      this.write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: failure.code, message: failure.message },
      });
    }
  }

  shutdown(code = 0) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new ModuleError('module_unavailable', '模块已停止'));
    }
    this.pending.clear();
    this.lines.close();
    process.exit(code);
  }
}

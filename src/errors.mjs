/** Stable module errors from the Courseflow module API v1 contract. */
export class ModuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModuleError';
    this.code = code;
  }
}

export const loginExpired = () =>
  new ModuleError('platform_login_expired', 'QLTeacher 登录已过期，请重新连接账号');

export const verificationRequired = (message = '平台要求额外验证，请在官方页面完成后再继续') =>
  new ModuleError('platform_verification_required', message);

export const protocolChanged = (message = '平台返回值无法识别，请核对官方页面') =>
  new ModuleError('platform_protocol_changed', message);

export const rejected = (message = '平台拒绝了本次操作') =>
  new ModuleError('platform_rejected', message);

export const invalid = (message = '参数不完整或格式不正确') =>
  new ModuleError('invalid_params', message);

export const unsupported = (message = '当前模块没有实现这个操作') =>
  new ModuleError('unsupported_operation', message);

export function asModuleError(error, fallbackCode = 'platform_protocol_changed') {
  if (error instanceof ModuleError) return error;
  if (error && typeof error === 'object' && typeof error.code === 'string') {
    return new ModuleError(error.code, error.message || String(error));
  }
  return new ModuleError(fallbackCode, error instanceof Error ? error.message : String(error));
}

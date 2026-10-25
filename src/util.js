import crypto from 'node:crypto';

/** 带状态码的业务异常 */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

export const badRequest = (msg, code) => new HttpError(400, msg, code);
export const unauthorized = (msg = '请先登录') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = '没有权限执行该操作') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = '资源不存在') => new HttpError(404, msg, 'NOT_FOUND');

/** 包装异步路由，统一交给错误中间件 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export const newId = () => crypto.randomUUID();

export const now = () => new Date().toISOString();

/** 校验并清洗字符串字段 */
export function text(value, { name = '内容', min = 1, max = 20000, required = true } = {}) {
  const v = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!v) {
    if (required) throw badRequest(`${name}不能为空`);
    return '';
  }
  if (v.length < min) throw badRequest(`${name}至少需要 ${min} 个字符`);
  if (v.length > max) throw badRequest(`${name}不能超过 ${max} 个字符`);
  return v;
}

/** 校验用户名：字母、数字、下划线、点、@、连字符 */
export function username(value, { name = '用户名' } = {}) {
  const v = text(value, { name, min: 3, max: 32 });
  if (!/^[A-Za-z0-9_.@\-\u4e00-\u9fa5]+$/.test(v)) {
    throw badRequest(`${name}只能包含中英文、数字、下划线、点、@ 或连字符`);
  }
  return v;
}

export function password(value, { name = '密码' } = {}) {
  const v = typeof value === 'string' ? value : '';
  if (v.length < 6) throw badRequest(`${name}至少 6 位`);
  if (v.length > 128) throw badRequest(`${name}不能超过 128 位`);
  return v;
}

/** 解析可选的时间（ISO 字符串 / datetime-local） */
export function optionalDate(value, { name = '时间' } = {}) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw badRequest(`${name}格式不正确`);
  return d.toISOString();
}

export function optionalBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function score(value, max, { name = '分数', allowEmpty = true } = {}) {
  if (value == null || value === '') {
    if (allowEmpty) return null;
    throw badRequest(`${name}不能为空`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${name}必须是数字`);
  if (n < 0) throw badRequest(`${name}不能为负数`);
  if (Number.isFinite(max) && n > max) throw badRequest(`${name}不能超过满分 ${max}`);
  return Math.round(n * 100) / 100;
}

/** 分页参数 */
export function pagination(query = {}) {
  let page = parseInt(query.page, 10);
  let size = parseInt(query.size, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(size) || size < 1) size = 20;
  if (size > 100) size = 100;
  return { page, size, skip: (page - 1) * size, take: size };
}

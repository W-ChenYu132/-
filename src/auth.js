import crypto from 'node:crypto';
import { appSecret, data } from './db.js';
import { forbidden, unauthorized } from './util.js';

const SECRET = appSecret();
const COOKIE_NAME = 'hw_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

/* ------------------------------ 密码 ------------------------------ */

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${KEY_LEN}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const keyLen = Number(parts[1]);
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    const key = crypto.scryptSync(plain, salt, keyLen || KEY_LEN, SCRYPT_OPTS);
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/* ------------------------------ 会话令牌 ------------------------------ */

const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (str) => Buffer.from(str, 'base64url'),
};

export function signSession(userId, ttlMs = SESSION_TTL_MS) {
  const payload = { uid: userId, exp: Date.now() + ttlMs };
  const body = b64u.enc(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64u.dec(body).toString('utf8'));
    if (!payload?.uid || !payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------------ Cookie ------------------------------ */

export function readCookie(req, name = COOKIE_NAME) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(req, res, userId) {
  const token = signSession(userId);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

/* ------------------------------ 中间件 ------------------------------ */

/** 把当前用户挂到 req.user（未登录则为 null） */
export function attachUser(req, _res, next) {
  req.user = null;
  const token = readCookie(req);
  const payload = verifySession(token);
  if (payload) {
    const user = data().users.find((u) => u.id === payload.uid);
    if (user && user.active !== false) req.user = user;
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** 管理员（超级管理员）：拥有全部权限 */
export function requireAdmin(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('仅管理员可执行该操作'));
  next();
}

/** 教职工：管理员或老师 */
export function requireStaff(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!isStaff(req.user)) return next(forbidden('仅老师或管理员可执行该操作'));
  next();
}

export const isStaff = (user) => user?.role === 'admin' || user?.role === 'teacher';
export const isAdmin = (user) => user?.role === 'admin';
export const isTeacher = (user) => user?.role === 'teacher';
export const isStudent = (user) => user?.role === 'student';

export const ROLE_TEXT = { admin: '管理员', teacher: '老师', student: '学生' };

/** 对外暴露的用户信息（不含密码） */
export function publicUser(user, classes = []) {
  if (!user) return null;
  const classIds = user.classIds || [];
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    roleText: ROLE_TEXT[user.role] || user.role,
    active: user.active !== false,
    classIds,
    classNames: classes.filter((c) => classIds.includes(c.id)).map((c) => c.name),
    createdAt: user.createdAt,
  };
}

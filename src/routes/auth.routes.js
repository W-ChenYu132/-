import { Router } from 'express';
import { data, mutate } from '../db.js';
import {
  clearSessionCookie,
  hashPassword,
  publicUser,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';
import * as rateLimit from '../rateLimit.js';
import {
  asyncHandler,
  badRequest,
  newId,
  now,
  password as validPassword,
  text,
  unauthorized,
  username as validUsername,
} from '../util.js';

const router = Router();
const ALLOW_REGISTER = process.env.ALLOW_REGISTER !== '0';

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const limit = rateLimit.hit(req, { suffix: 'login', limit: 10, windowMs: 5 * 60 * 1000 });
    if (!limit.ok) {
      res.set('Retry-After', String(limit.retryAfter));
      throw badRequest(`登录尝试过于频繁，请 ${limit.retryAfter} 秒后再试`);
    }

    const name = String(req.body?.username || '').trim();
    const pass = String(req.body?.password || '');
    if (!name || !pass) throw badRequest('请输入用户名和密码');

    const user = data().users.find((u) => u.username.toLowerCase() === name.toLowerCase());
    if (!user || !verifyPassword(pass, user.password)) {
      throw unauthorized('用户名或密码错误');
    }
    if (user.active === false) throw unauthorized('该账号已被停用，请联系管理员');

    rateLimit.reset(req, { suffix: 'login' });
    setSessionCookie(req, res, user.id);
    res.json({ user: publicUser(user, data().classes) });
  }),
);

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user, data().classes) });
});

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    if (!ALLOW_REGISTER) throw badRequest('本系统已关闭自助注册，请联系管理员开通账号');
    if (data().settings?.registerEnabled === false) {
      throw badRequest('管理员已关闭自助注册，请联系老师开通账号');
    }
    const limit = rateLimit.hit(req, { suffix: 'register', limit: 8, windowMs: 30 * 60 * 1000 });
    if (!limit.ok) throw badRequest(`注册过于频繁，请 ${limit.retryAfter} 秒后再试`);

    const name = validUsername(req.body?.username);
    const displayName = text(req.body?.name || name, { name: '姓名', min: 1, max: 32 });
    const pass = validPassword(req.body?.password, { name: '密码' });

    const exists = data().users.some((u) => u.username.toLowerCase() === name.toLowerCase());
    if (exists) throw badRequest('该用户名已被占用');

    // 允许学生自选班级时，注册可带上班级（支持多选）
    let classIds = [];
    if (data().settings?.selfClassSelect === true) {
      const raw = req.body?.classIds ?? (req.body?.classId ? [req.body.classId] : []);
      if (Array.isArray(raw)) {
        for (const item of raw.slice(0, 20)) {
          const classId = String(item);
          if (!data().classes.some((c) => c.id === classId)) throw badRequest('所选班级不存在');
          if (!classIds.includes(classId)) classIds.push(classId);
        }
      }
    }

    const user = await mutate((db) => {
      const u = {
        id: newId(),
        username: name,
        name: displayName,
        password: hashPassword(pass),
        role: 'student',
        classIds,
        active: true,
        createdAt: now(),
        updatedAt: now(),
      };
      db.users.push(u);
      return u;
    });

    setSessionCookie(req, res, user.id);
    res.status(201).json({ user: publicUser(user, data().classes) });
  }),
);

router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const oldPass = String(req.body?.oldPassword || '');
    const newPass = validPassword(req.body?.newPassword, { name: '新密码' });
    if (!verifyPassword(oldPass, req.user.password)) throw badRequest('原密码不正确');
    await mutate((db) => {
      const u = db.users.find((x) => x.id === req.user.id);
      if (u) {
        u.password = hashPassword(newPass);
        u.updatedAt = now();
      }
    });
    res.json({ ok: true });
  }),
);

/** 学生自己选择 / 切换班级（支持多选，需管理员开启「允许学生自选班级」） */
router.post(
  '/class',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'student') throw badRequest('只有学生账号可以设置班级');
    if (data().settings?.selfClassSelect !== true) {
      throw badRequest('管理员未开启「允许学生自选班级」，请联系老师分配班级');
    }

    // 兼容两种入参：classIds: [] 或 classId: ''
    const raw = req.body?.classIds ?? (req.body?.classId ? [req.body.classId] : []);
    if (!Array.isArray(raw)) throw badRequest('班级参数格式不正确');
    if (raw.length > 20) throw badRequest('最多选择 20 个班级');

    const classIds = [];
    for (const item of raw) {
      const classId = String(item);
      if (!data().classes.some((c) => c.id === classId)) throw badRequest('所选班级不存在');
      if (!classIds.includes(classId)) classIds.push(classId);
    }

    const updated = await mutate((db) => {
      const u = db.users.find((x) => x.id === req.user.id);
      u.classIds = classIds;
      u.updatedAt = now();
      return u;
    });
    res.json({ user: publicUser(updated, data().classes) });
  }),
);

export default router;

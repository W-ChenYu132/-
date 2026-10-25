import { Router } from 'express';
import { hashPassword, publicUser, requireAdmin } from '../auth.js';
import { data, mutate } from '../db.js';
import {
  asyncHandler,
  badRequest,
  newId,
  notFound,
  now,
  optionalBool,
  password as validPassword,
  text,
  username as validUsername,
} from '../util.js';

const router = Router();
router.use(requireAdmin);

const ROLES = ['admin', 'teacher', 'student'];

function parseClassIds(input) {
  if (input == null) return undefined;
  if (!Array.isArray(input)) throw badRequest('班级格式不正确');
  const d = data();
  const ids = [];
  for (const raw of input.slice(0, 50)) {
    const id = String(raw);
    if (!d.classes.some((c) => c.id === id)) throw badRequest('所选班级不存在');
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function userWithStats(u) {
  const d = data();
  const subs = d.submissions.filter((s) => s.studentId === u.id);
  return {
    ...publicUser(u, d.classes),
    stats: {
      submitted: subs.length,
      pending: subs.filter((s) => s.status === 'pending').length,
      approved: subs.filter((s) => s.status === 'approved').length,
      rejected: subs.filter((s) => s.status === 'rejected').length,
    },
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const d = data();
    const role = String(req.query.role || '');
    let list = d.users.slice();
    if (ROLES.includes(role)) list = list.filter((u) => u.role === role);
    const classId = req.query.classId ? String(req.query.classId) : '';
    if (classId) list = list.filter((u) => (u.classIds || []).includes(classId));
    const keyword = String(req.query.q || '').trim().toLowerCase();
    if (keyword) {
      list = list.filter(
        (u) =>
          u.username.toLowerCase().includes(keyword) || (u.name || '').toLowerCase().includes(keyword),
      );
    }

    list.sort((a, b) => {
      const order = { admin: 0, teacher: 1, student: 2 };
      if (order[a.role] !== order[b.role]) return order[a.role] - order[b.role];
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({ users: list.map(userWithStats) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = validUsername(req.body?.username);
    const displayName = text(req.body?.name || name, { name: '姓名', max: 32 });
    const pass = validPassword(req.body?.password, { name: '密码' });
    const role = ROLES.includes(req.body?.role) ? req.body.role : 'student';
    const classIds = parseClassIds(req.body?.classIds) || [];

    if (data().users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
      throw badRequest('该用户名已存在');
    }

    const user = await mutate((db) => {
      const u = {
        id: newId(),
        username: name,
        name: displayName,
        password: hashPassword(pass),
        role,
        classIds: role === 'student' ? classIds : [],
        active: true,
        createdAt: now(),
        updatedAt: now(),
      };
      db.users.push(u);
      return u;
    });
    res.status(201).json({ user: userWithStats(user) });
  }),
);

/** 批量添加学生：每行「用户名,姓名」（也支持 空格 / Tab 分隔） */
router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const raw = String(req.body?.text || '');
    const defaultPassword = req.body?.password ? validPassword(req.body.password, { name: '初始密码' }) : '123456';
    const classIds = parseClassIds(req.body?.classIds) || [];
    if (!raw.trim()) throw badRequest('请粘贴学生名单');

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 300) throw badRequest('单次最多导入 300 个学生');

    const d = data();
    const existing = new Set(d.users.map((u) => u.username.toLowerCase()));
    const created = [];
    const skipped = [];

    await mutate((db) => {
      for (const line of lines) {
        const parts = line.split(/[,，\t]|\s{2,}/).map((s) => s.trim()).filter(Boolean);
        const uname = parts[0];
        const displayName = parts[1] || parts[0];
        if (!uname || !/^[A-Za-z0-9_.@\-\u4e00-\u9fa5]{3,32}$/.test(uname)) {
          skipped.push(`${line}（用户名不合法）`);
          continue;
        }
        if (existing.has(uname.toLowerCase())) {
          skipped.push(`${line}（用户名已存在）`);
          continue;
        }
        existing.add(uname.toLowerCase());
        const u = {
          id: newId(),
          username: uname,
          name: displayName.slice(0, 32),
          password: hashPassword(defaultPassword),
          role: 'student',
          classIds,
          active: true,
          createdAt: now(),
          updatedAt: now(),
        };
        db.users.push(u);
        created.push({ username: u.username, name: u.name });
      }
    });

    res.status(201).json({ created, skipped, defaultPassword });
  }),
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const target = data().users.find((u) => u.id === req.params.id);
    if (!target) throw notFound('用户不存在');

    const patch = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'name')) {
      patch.name = text(req.body.name, { name: '姓名', max: 32 });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'password') && req.body.password) {
      patch.password = hashPassword(validPassword(req.body.password, { name: '新密码' }));
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'active')) {
      patch.active = optionalBool(req.body.active, true);
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'classIds')) {
      patch.classIds = parseClassIds(req.body.classIds) || [];
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'role')) {
      const role = ROLES.includes(req.body.role) ? req.body.role : 'student';
      if (role !== target.role) {
        const adminCount = data().users.filter((u) => u.role === 'admin').length;
        if (target.role === 'admin' && adminCount <= 1) {
          throw badRequest('系统至少需要保留一名管理员');
        }
        if (target.id === req.user.id) throw badRequest('不能修改自己的角色');
        patch.role = role;
      }
    }
    if (target.id === req.user.id && patch.active === false) {
      throw badRequest('不能停用自己的账号');
    }

    const updated = await mutate((db) => {
      const u = db.users.find((x) => x.id === target.id);
      Object.assign(u, patch, { updatedAt: now() });
      return u;
    });
    res.json({ user: userWithStats(updated) });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const target = data().users.find((u) => u.id === req.params.id);
    if (!target) throw notFound('用户不存在');
    if (target.id === req.user.id) throw badRequest('不能删除自己的账号');
    if (target.role === 'admin' && data().users.filter((u) => u.role === 'admin').length <= 1) {
      throw badRequest('系统至少需要保留一名管理员');
    }
    await mutate((db) => {
      db.users = db.users.filter((u) => u.id !== target.id);
      db.submissions = db.submissions.filter((s) => s.studentId !== target.id);
    });
    res.json({ ok: true });
  }),
);

export default router;

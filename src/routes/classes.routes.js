import { Router } from 'express';
import { requireAdmin, requireStaff } from '../auth.js';
import { data, mutate } from '../db.js';
import { asyncHandler, badRequest, newId, notFound, now, text } from '../util.js';

const router = Router();

const classView = (c) => {
  const d = data();
  const members = d.users.filter((u) => u.role === 'student' && (u.classIds || []).includes(c.id));
  const assignments = d.assignments.filter((a) => (a.classIds || []).includes(c.id));
  return {
    id: c.id,
    name: c.name,
    note: c.note || '',
    createdAt: c.createdAt,
    memberCount: members.length,
    assignmentCount: assignments.length,
    members: members.map((u) => ({ id: u.id, username: u.username, name: u.name })),
  };
};

/** 班级列表：管理员与老师均可查看 */
router.get(
  '/',
  requireStaff,
  asyncHandler(async (_req, res) => {
    const list = data().classes
      .slice()
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(classView);
    res.json({ classes: list });
  }),
);

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const name = text(req.body?.name, { name: '班级名称', min: 1, max: 40 });
    const note = text(req.body?.note, { name: '备注', min: 0, max: 100, required: false });
    if (data().classes.some((c) => c.name === name)) throw badRequest('已存在同名班级');
    const created = await mutate((db) => {
      const c = { id: newId(), name, note, createdBy: req.user.id, createdAt: now() };
      db.classes.push(c);
      return c;
    });
    res.status(201).json({ class: classView(created) });
  }),
);

router.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const target = data().classes.find((c) => c.id === req.params.id);
    if (!target) throw notFound('班级不存在');
    const patch = {};
    if (req.body?.name !== undefined) {
      patch.name = text(req.body.name, { name: '班级名称', min: 1, max: 40 });
      if (data().classes.some((c) => c.name === patch.name && c.id !== target.id)) {
        throw badRequest('已存在同名班级');
      }
    }
    if (req.body?.note !== undefined) {
      patch.note = text(req.body.note, { name: '备注', min: 0, max: 100, required: false });
    }
    const updated = await mutate((db) => {
      const c = db.classes.find((x) => x.id === target.id);
      Object.assign(c, patch);
      return c;
    });
    res.json({ class: classView(updated) });
  }),
);

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const target = data().classes.find((c) => c.id === req.params.id);
    if (!target) throw notFound('班级不存在');
    await mutate((db) => {
      db.classes = db.classes.filter((c) => c.id !== target.id);
      for (const u of db.users) {
        u.classIds = (u.classIds || []).filter((id) => id !== target.id);
      }
      for (const a of db.assignments) {
        a.classIds = (a.classIds || []).filter((id) => id !== target.id);
      }
    });
    res.json({ ok: true });
  }),
);

export default router;

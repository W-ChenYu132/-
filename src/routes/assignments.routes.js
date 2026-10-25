import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { requireAdmin, requireAuth, requireStaff } from '../auth.js';
import { data, mutate, paths } from '../db.js';
import { assignmentView } from '../views.js';
import {
  asyncHandler,
  badRequest,
  forbidden,
  newId,
  notFound,
  now,
  optionalBool,
  optionalDate,
  text,
} from '../util.js';

const router = Router();

/** 参考答案对学生可见的时机 */
export const ANSWER_VISIBILITY = ['afterSubmit', 'afterReview', 'afterDeadline', 'never'];

/** 学生是否属于作业目标班级（classIds 为空表示面向全体学生） */
export function targetsStudent(assignment, student) {
  const target = assignment.classIds || [];
  if (target.length === 0) return true;
  const mine = student.classIds || [];
  return target.some((id) => mine.includes(id));
}

/** 是否能管理某份作业：管理员全部、老师仅自己的 */
export function canManage(user, assignment) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'teacher') return assignment.createdBy === user.id;
  return false;
}

function parseFileIds(input) {
  if (input == null) return undefined;
  if (!Array.isArray(input)) throw badRequest('附件格式不正确');
  const d = data();
  const ids = [];
  for (const raw of input.slice(0, 10)) {
    const id = String(raw);
    if (!d.files.some((f) => f.id === id)) throw badRequest('附件不存在或已删除');
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

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

function readPayload(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body != null && Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('title')) out.title = text(body?.title, { name: '作业标题', min: 2, max: 120 });
  if (!partial || has('content')) {
    out.content = text(body?.content, { name: '题目内容', min: 2, max: 20000 });
  }
  if (!partial || has('answer')) {
    out.answer = text(body?.answer, { name: '参考答案', min: 0, max: 20000, required: false });
  }
  if (!partial || has('answerVisibility')) {
    const vis = String(body?.answerVisibility || 'afterSubmit');
    out.answerVisibility = ANSWER_VISIBILITY.includes(vis) ? vis : 'afterSubmit';
  }
  if (!partial || has('deadline')) out.deadline = optionalDate(body?.deadline, { name: '截止时间' });
  if (!partial || has('maxScore')) {
    const n = body?.maxScore === '' || body?.maxScore == null ? 100 : Number(body.maxScore);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw badRequest('满分需在 1 ~ 1000 之间');
    out.maxScore = n;
  }
  if (!partial || has('allowLate')) out.allowLate = optionalBool(body?.allowLate, true);
  if (!partial || has('published')) out.published = optionalBool(body?.published, true);
  const files = parseFileIds(body?.files);
  if (files !== undefined) out.files = files;
  const classIds = parseClassIds(body?.classIds);
  if (classIds !== undefined) out.classIds = classIds;
  return out;
}

function findAssignment(req) {
  const a = data().assignments.find((x) => x.id === req.params.id);
  if (!a) throw notFound('作业不存在或已被删除');
  return a;
}

function removeFilesSafely(fileIds) {
  const d = data();
  for (const id of fileIds) {
    const file = d.files.find((f) => f.id === id);
    if (!file) continue;
    const stillUsed =
      d.assignments.some((a) => (a.files || []).includes(id)) ||
      d.submissions.some((s) => (s.files || []).includes(id));
    if (stillUsed) continue;
    const full = path.join(paths.UPLOAD_DIR, file.storedName);
    fs.promises.unlink(full).catch(() => {});
  }
}

/** 作业列表：管理员看全部，老师看自己的，学生看已发布且面向自己班级的 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const d = data();
    const role = req.user.role;

    let list = d.assignments.slice();
    if (role === 'teacher') {
      list = list.filter((a) => a.createdBy === req.user.id);
    } else if (role === 'student') {
      list = list.filter((a) => a.published !== false && targetsStudent(a, req.user));
    }

    const keyword = String(req.query.q || '').trim().toLowerCase();
    if (keyword) {
      list = list.filter(
        (a) =>
          a.title.toLowerCase().includes(keyword) || (a.content || '').toLowerCase().includes(keyword),
      );
    }
    if (role !== 'student' && req.query.published === '0') {
      list = list.filter((a) => a.published === false);
    }
    if (role !== 'student' && req.query.published === '1') {
      list = list.filter((a) => a.published !== false);
    }

    const views = list.map((a) => assignmentView(a, { viewer: req.user }));

    if (role === 'student') {
      views.sort((x, y) => {
        if (!x.deadline && !y.deadline) return new Date(y.createdAt) - new Date(x.createdAt);
        if (!x.deadline) return 1;
        if (!y.deadline) return -1;
        return new Date(x.deadline) - new Date(y.deadline);
      });
    } else {
      views.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
    }

    res.json({ assignments: views, serverTime: now() });
  }),
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const a = findAssignment(req);
    const role = req.user.role;

    if (role === 'student') {
      if (a.published === false) throw notFound('作业不存在或未发布');
      if (!targetsStudent(a, req.user)) throw forbidden('该作业不在你的班级范围内');
    } else if (role === 'teacher' && a.createdBy !== req.user.id) {
      throw forbidden('只能查看自己发布的作业');
    }

    res.json({ assignment: assignmentView(a, { viewer: req.user, includeAnswer: true }) });
  }),
);

router.post(
  '/',
  requireStaff,
  asyncHandler(async (req, res) => {
    const payload = readPayload(req.body);
    const assignment = await mutate((db) => {
      const a = {
        id: newId(),
        ...payload,
        classIds: payload.classIds || [],
        files: payload.files || [],
        createdBy: req.user.id,
        createdAt: now(),
        updatedAt: now(),
      };
      db.assignments.push(a);
      for (const fid of a.files) {
        const f = db.files.find((x) => x.id === fid);
        if (f) f.used = true;
      }
      return a;
    });
    res.status(201).json({ assignment: assignmentView(assignment, { viewer: req.user }) });
  }),
);

router.patch(
  '/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const existing = findAssignment(req);
    if (!canManage(req.user, existing)) throw forbidden('只能修改自己发布的作业');
    const payload = readPayload(req.body, { partial: true });
    const removedFiles = [];
    const updated = await mutate((db) => {
      const a = db.assignments.find((x) => x.id === existing.id);
      if (payload.files) {
        removedFiles.push(...(a.files || []).filter((id) => !payload.files.includes(id)));
      }
      Object.assign(a, payload, { updatedAt: now() });
      for (const fid of a.files || []) {
        const f = db.files.find((x) => x.id === fid);
        if (f) f.used = true;
      }
      return a;
    });
    removeFilesSafely(removedFiles);
    res.json({ assignment: assignmentView(updated, { viewer: req.user }) });
  }),
);

router.delete(
  '/:id',
  requireStaff,
  asyncHandler(async (req, res) => {
    const existing = findAssignment(req);
    if (!canManage(req.user, existing)) throw forbidden('只能删除自己发布的作业');
    const orphanFiles = [];
    await mutate((db) => {
      db.assignments = db.assignments.filter((a) => a.id !== existing.id);
      const removed = db.submissions.filter((s) => s.assignmentId === existing.id);
      for (const s of removed) orphanFiles.push(...(s.files || []));
      orphanFiles.push(...(existing.files || []));
      db.submissions = db.submissions.filter((s) => s.assignmentId !== existing.id);
    });
    removeFilesSafely(orphanFiles);
    res.json({ ok: true });
  }),
);

export default router;

import { Router } from 'express';
import { requireAdmin, requireAuth, requireStaff } from '../auth.js';
import { data, mutate } from '../db.js';
import { isExpired, submissionView } from '../views.js';
import { targetsStudent } from './assignments.routes.js';
import {
  asyncHandler,
  badRequest,
  forbidden,
  newId,
  notFound,
  now,
  pagination,
  score as validScore,
  text,
} from '../util.js';

const router = Router();

function parseFileIds(input) {
  if (input == null) return [];
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

/** 当前老师是否有权处理该提交（管理员全部、老师仅自己作业的提交） */
function canReview(user, submission) {
  if (user.role === 'admin') return true;
  if (user.role !== 'teacher') return false;
  const assignment = data().assignments.find((a) => a.id === submission.assignmentId);
  return !!assignment && assignment.createdBy === user.id;
}

/** 审批列表：管理员看全部，老师看自己作业的提交 */
router.get(
  '/',
  requireStaff,
  asyncHandler(async (req, res) => {
    const d = data();
    const status = String(req.query.status || 'all');
    const assignmentId = req.query.assignmentId ? String(req.query.assignmentId) : null;
    const keyword = String(req.query.q || '').trim().toLowerCase();

    let list = d.submissions.slice();

    if (req.user.role === 'teacher') {
      const myAssignmentIds = new Set(
        d.assignments.filter((a) => a.createdBy === req.user.id).map((a) => a.id),
      );
      list = list.filter((s) => myAssignmentIds.has(s.assignmentId));
    }

    const baseCounts = {
      all: list.length,
      pending: list.filter((s) => s.status === 'pending').length,
      approved: list.filter((s) => s.status === 'approved').length,
      rejected: list.filter((s) => s.status === 'rejected').length,
    };

    if (['pending', 'approved', 'rejected'].includes(status)) {
      list = list.filter((s) => s.status === status);
    }
    if (assignmentId) list = list.filter((s) => s.assignmentId === assignmentId);
    if (keyword) {
      list = list.filter((s) => {
        const student = d.users.find((u) => u.id === s.studentId);
        const assignment = d.assignments.find((a) => a.id === s.assignmentId);
        return (
          (student?.name || '').toLowerCase().includes(keyword) ||
          (student?.username || '').toLowerCase().includes(keyword) ||
          (assignment?.title || '').toLowerCase().includes(keyword) ||
          (s.content || '').toLowerCase().includes(keyword)
        );
      });
    }

    const rank = { pending: 0, rejected: 1, approved: 2 };
    list.sort((a, b) => {
      const diff = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
      if (diff !== 0) return diff;
      return new Date(b.submittedAt) - new Date(a.submittedAt);
    });

    const { page, size, skip } = pagination(req.query);
    const items = list
      .slice(skip, skip + size)
      .map((s) => submissionView(s, { withStudent: true, withAssignment: true }));

    res.json({ submissions: items, total: list.length, page, size, counts: baseCounts });
  }),
);

/** 学生：我的全部提交 */
router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const d = data();
    const list = d.submissions
      .filter((s) => s.studentId === req.user.id)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
      .map((s) => submissionView(s, { withAssignment: true }));
    res.json({ submissions: list });
  }),
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sub = data().submissions.find((s) => s.id === req.params.id);
    if (!sub) throw notFound('提交记录不存在');
    if (req.user.role === 'student' && sub.studentId !== req.user.id) throw forbidden();
    if (req.user.role === 'teacher' && !canReview(req.user, sub)) {
      throw forbidden('只能查看自己作业的提交');
    }
    res.status(200).json({
      submission: submissionView(sub, {
        withStudent: req.user.role !== 'student',
        withAssignment: true,
        // 参考答案只给老师/管理员，学生走作业详情接口（受可见时机控制）
        includeAnswer: req.user.role !== 'student',
      }),
    });
  }),
);

/** 学生：提交 / 重新提交作业 */
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'student') throw forbidden('老师账号不能提交作业');
    const d = data();
    const assignmentId = String(req.body?.assignmentId || '');
    const assignment = d.assignments.find((a) => a.id === assignmentId);
    if (!assignment || assignment.published === false) throw notFound('作业不存在或未发布');
    if (!targetsStudent(assignment, req.user)) throw forbidden('该作业不在你的班级范围内');

    if (isExpired(assignment) && assignment.allowLate === false) {
      throw badRequest('该作业已过截止时间，不再接受提交');
    }

    const content = text(req.body?.content, {
      name: '作业内容',
      min: 0,
      max: 20000,
      required: false,
    });
    const files = parseFileIds(req.body?.files);
    if (!content && files.length === 0) throw badRequest('请填写作业内容或上传附件');

    const existing = d.submissions.find(
      (s) => s.assignmentId === assignmentId && s.studentId === req.user.id,
    );
    if (existing && existing.status === 'approved') {
      throw badRequest('该作业已通过审批，如需重新提交请联系老师');
    }

    const saved = await mutate((db) => {
      for (const fid of files) {
        const f = db.files.find((x) => x.id === fid);
        if (f) f.used = true;
      }
      const stamp = now();
      const idx = db.submissions.findIndex(
        (s) => s.assignmentId === assignmentId && s.studentId === req.user.id,
      );
      if (idx >= 0) {
        const s = db.submissions[idx];
        Object.assign(s, {
          content,
          files,
          status: 'pending',
          score: null,
          feedback: '',
          reviewedBy: null,
          reviewedAt: null,
          updatedAt: stamp,
          revision: (s.revision || 1) + 1,
        });
        return s;
      }
      const s = {
        id: newId(),
        assignmentId,
        studentId: req.user.id,
        content,
        files,
        status: 'pending',
        score: null,
        feedback: '',
        reviewedBy: null,
        reviewedAt: null,
        submittedAt: stamp,
        updatedAt: stamp,
        revision: 1,
      };
      db.submissions.push(s);
      return s;
    });

    res.status(201).json({ submission: submissionView(saved, { withAssignment: true }) });
  }),
);

/** 学生：撤回自己待审批的提交 */
router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sub = data().submissions.find((s) => s.id === req.params.id);
    if (!sub) throw notFound('提交记录不存在');
    const isOwner = sub.studentId === req.user.id;
    const isStaffAllowed = req.user.role === 'admin' || (req.user.role === 'teacher' && canReview(req.user, sub));
    if (!isOwner && !isStaffAllowed) throw forbidden();
    if (isOwner && sub.status === 'approved') {
      throw badRequest('已通过审批的作业不能撤回，请联系老师');
    }
    await mutate((db) => {
      db.submissions = db.submissions.filter((s) => s.id !== sub.id);
    });
    res.json({ ok: true });
  }),
);

/** 老师 / 管理员：批阅（通过 / 驳回，可给分与评语） */
router.post(
  '/:id/review',
  requireStaff,
  asyncHandler(async (req, res) => {
    const sub = data().submissions.find((s) => s.id === req.params.id);
    if (!sub) throw notFound('提交记录不存在');
    if (!canReview(req.user, sub)) throw forbidden('只能批阅自己作业的提交');

    const action = String(req.body?.action || '').toLowerCase();
    if (!['approve', 'reject'].includes(action)) {
      throw badRequest('审批动作只能是 approve（通过）或 reject（驳回）');
    }
    const assignment = data().assignments.find((a) => a.id === sub.assignmentId);
    const maxScore = assignment?.maxScore ?? 100;
    const finalScore = validScore(req.body?.score, maxScore, { name: '分数' });
    const feedback = text(req.body?.feedback, {
      name: '评语',
      min: 0,
      max: 2000,
      required: false,
    });

    const updated = await mutate((db) => {
      const s = db.submissions.find((x) => x.id === sub.id);
      s.status = action === 'approve' ? 'approved' : 'rejected';
      s.score = finalScore;
      s.feedback = feedback;
      s.reviewedBy = req.user.id;
      s.reviewedAt = now();
      return s;
    });

    res.json({ submission: submissionView(updated, { withStudent: true, withAssignment: true }) });
  }),
);

export default router;

export { canReview };

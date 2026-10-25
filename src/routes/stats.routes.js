import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { data } from '../db.js';
import { isExpired, submissionView } from '../views.js';
import { targetsStudent } from './assignments.routes.js';
import { asyncHandler } from '../util.js';

const router = Router();

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const d = data();
    const role = req.user.role;

    /* ---------------- 管理员 / 老师 ---------------- */
    if (role === 'admin' || role === 'teacher') {
      const myAssignments =
        role === 'admin'
          ? d.assignments
          : d.assignments.filter((a) => a.createdBy === req.user.id);
      const ids = new Set(myAssignments.map((a) => a.id));
      const subs = d.submissions.filter((s) => ids.has(s.assignmentId));

      const studentCount =
        role === 'admin'
          ? d.users.filter((u) => u.role === 'student').length
          : new Set(
              subs.map((s) => s.studentId),
            ).size;

      const recent = subs
        .slice()
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
        .slice(0, 8)
        .map((s) => submissionView(s, { withStudent: true, withAssignment: true }));

      res.json({
        role,
        stats: {
          assignmentCount: myAssignments.length,
          publishedCount: myAssignments.filter((a) => a.published !== false).length,
          studentCount,
          classCount: role === 'admin' ? d.classes.length : undefined,
          submissionCount: subs.length,
          pending: subs.filter((s) => s.status === 'pending').length,
          approved: subs.filter((s) => s.status === 'approved').length,
          rejected: subs.filter((s) => s.status === 'rejected').length,
        },
        recent,
      });
      return;
    }

    /* ---------------- 学生 ---------------- */
    const published = d.assignments.filter(
      (a) => a.published !== false && targetsStudent(a, req.user),
    );
    const mine = d.submissions.filter((s) => s.studentId === req.user.id);
    const approved = mine.filter((s) => s.status === 'approved');
    const scores = approved.map((s) => s.score).filter((n) => typeof n === 'number');
    const submittedIds = new Set(mine.map((s) => s.assignmentId));
    const todo = published.filter((a) => !submittedIds.has(a.id) && !isExpired(a));

    res.json({
      role,
      stats: {
        assignmentCount: published.length,
        todo: todo.length,
        submitted: mine.length,
        pending: mine.filter((s) => s.status === 'pending').length,
        approved: approved.length,
        rejected: mine.filter((s) => s.status === 'rejected').length,
        averageScore: scores.length
          ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
          : null,
      },
      recent: mine
        .slice()
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
        .slice(0, 5)
        .map((s) => submissionView(s, { withAssignment: true })),
    });
  }),
);

export default router;

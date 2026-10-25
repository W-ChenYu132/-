import { data } from './db.js';

export const SUB_STATUS = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
};

export function fileView(file) {
  if (!file) return null;
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime: file.mime,
    createdAt: file.createdAt,
  };
}

export const fileById = (id) => fileView(data().files.find((f) => f.id === id));
const filesByIds = (ids) => (ids || []).map(fileById).filter(Boolean);

export function isExpired(assignment) {
  if (!assignment.deadline) return false;
  const t = new Date(assignment.deadline).getTime();
  return Number.isFinite(t) && Date.now() > t;
}

export function submissionView(sub, { withStudent = false, withAssignment = false } = {}) {
  if (!sub) return null;
  const d = data();
  const reviewer = sub.reviewedBy ? d.users.find((u) => u.id === sub.reviewedBy) : null;
  const out = {
    id: sub.id,
    assignmentId: sub.assignmentId,
    studentId: sub.studentId,
    content: sub.content || '',
    files: filesByIds(sub.files),
    submittedAt: sub.submittedAt,
    updatedAt: sub.updatedAt,
    status: sub.status,
    statusText: SUB_STATUS[sub.status] || sub.status,
    score: sub.score ?? null,
    feedback: sub.feedback || '',
    reviewedAt: sub.reviewedAt || null,
    reviewerName: reviewer ? reviewer.name : null,
    revision: sub.revision || 0,
  };
  if (withStudent) {
    const u = d.users.find((x) => x.id === sub.studentId);
    out.student = u
      ? { id: u.id, username: u.username, name: u.name }
      : { id: sub.studentId, username: '（已删除）', name: '（已删除用户）' };
  }
  if (withAssignment) {
    const a = d.assignments.find((x) => x.id === sub.assignmentId);
    out.assignment = a
      ? { id: a.id, title: a.title, maxScore: a.maxScore, deadline: a.deadline }
      : { id: sub.assignmentId, title: '（作业已删除）', maxScore: null, deadline: null };
  }
  return out;
}

export function assignmentView(a, { viewer = null } = {}) {
  const d = data();
  const subs = d.submissions.filter((s) => s.assignmentId === a.id);
  const creator = d.users.find((u) => u.id === a.createdBy);
  const classIds = a.classIds || [];
  const out = {
    id: a.id,
    title: a.title,
    content: a.content || '',
    deadline: a.deadline || null,
    maxScore: a.maxScore ?? 100,
    allowLate: a.allowLate !== false,
    published: a.published !== false,
    files: filesByIds(a.files),
    classIds,
    classNames: d.classes.filter((c) => classIds.includes(c.id)).map((c) => c.name),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    creatorName: creator ? creator.name : null,
    expired: isExpired(a),
    stats: {
      submissionCount: subs.length,
      pendingCount: subs.filter((s) => s.status === 'pending').length,
      approvedCount: subs.filter((s) => s.status === 'approved').length,
      rejectedCount: subs.filter((s) => s.status === 'rejected').length,
    },
  };

  if (viewer && viewer.role === 'student') {
    const mine = subs.find((s) => s.studentId === viewer.id) || null;
    out.mySubmission = mine ? submissionView(mine) : null;
    out.canSubmit = !out.expired || out.allowLate;
  } else if (viewer && (viewer.role === 'admin' || (viewer.role === 'teacher' && a.createdBy === viewer.id))) {
    out.submissions = subs.map((s) => submissionView(s, { withStudent: true }));
  }
  return out;
}

/** 学生端作业状态：未提交 / 待审批 / 已通过 / 已驳回 / 已截止 */
export function studentAssignmentState(assignment, submission) {
  if (submission) return submission.status;
  return isExpired(assignment) ? 'expired' : 'todo';
}

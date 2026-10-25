/**
 * 端到端冒烟测试：覆盖三种角色、班级隔离、提交审批、文件权限、注册开关等。
 * 用法（服务需已启动）：node scripts/smoke-test.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function client(label) {
  let cookie = '';
  return {
    label,
    get cookie() {
      return cookie;
    },
    async req(path, { method = 'GET', body, form, raw = false } = {}) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      let payload;
      if (form) payload = form;
      else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(BASE + path, { method, headers, body: payload, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() || []) {
        const pair = c.split(';')[0];
        if (pair.startsWith('hw_session=')) cookie = pair;
      }
      if (raw) return { status: res.status, res, data: null };
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
      return { status: res.status, data, res };
    },
  };
}

const admin = client('admin');
const teacher = client('teacher');
const stuA = client('student');
const stuB = client('wang');
const anon = client('anon');

function section(title) {
  console.log(`\n[${title}]`);
}

async function main() {
  section('基础健康检查');
  const health = await anon.req('/healthz');
  check('GET /healthz 返回 200', health.status === 200 && health.data?.ok === true);
  const page = await anon.req('/', { raw: true });
  check('首页 HTML 可访问', page.status === 200 && (page.res.headers.get('content-type') || '').includes('text/html'));
  const pub = await anon.req('/api/settings/public');
  check('公开设置包含 registerEnabled', typeof pub.data?.registerEnabled === 'boolean');

  section('鉴权');
  const badLogin = await anon.req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  check('错误密码登录返回 401', badLogin.status === 401);
  const noAuth = await anon.req('/api/assignments');
  check('未登录访问作业列表返回 401', noAuth.status === 401);

  const loginAdmin = await admin.req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123456' } });
  check('管理员登录成功', loginAdmin.status === 200 && loginAdmin.data?.user?.role === 'admin');
  const loginTeacher = await teacher.req('/api/auth/login', { method: 'POST', body: { username: 'teacher', password: '123456' } });
  check('老师登录成功', loginTeacher.status === 200 && loginTeacher.data?.user?.role === 'teacher');
  const loginA = await stuA.req('/api/auth/login', { method: 'POST', body: { username: 'student', password: '123456' } });
  check('学生 A 登录成功', loginA.status === 200);
  const loginB = await stuB.req('/api/auth/login', { method: 'POST', body: { username: 'wang', password: '123456' } });
  check('学生 B 登录成功', loginB.status === 200);

  section('班级与作业发布');
  const classes = await admin.req('/api/classes');
  check('管理员可读取班级列表', classes.status === 200 && Array.isArray(classes.data?.classes));
  const classA = classes.data.classes[0];
  const classB = classes.data.classes[1];

  const newClass = await admin.req('/api/classes', { method: 'POST', body: { name: `测试班级-${Date.now()}`, note: '自动化测试' } });
  check('管理员可新建班级', newClass.status === 201 && !!newClass.data?.class?.id);
  const createdClassId = newClass.data?.class?.id;

  const teacherClassTry = await teacher.req('/api/classes', { method: 'POST', body: { name: '老师越权班级' } });
  check('老师不能创建班级（403）', teacherClassTry.status === 403);

  const assignment = await admin.req('/api/assignments', {
    method: 'POST',
    body: {
      title: `A班专属作业-${Date.now()}`,
      content: '请提交一份自我介绍。',
      deadline: new Date(Date.now() + 3600 * 1000).toISOString(),
      maxScore: 100,
      classIds: [classA.id],
      published: true,
      allowLate: true,
    },
  });
  check('管理员发布作业成功', assignment.status === 201 && !!assignment.data?.assignment?.id);
  const assignmentId = assignment.data?.assignment?.id;
  check('作业面向班级已保存', JSON.stringify(assignment.data?.assignment?.classIds) === JSON.stringify([classA.id]));

  const stuCreateTry = await stuA.req('/api/assignments', { method: 'POST', body: { title: '学生越权', content: '内容内容' } });
  check('学生不能发布作业（403）', stuCreateTry.status === 403);

  section('班级可见性隔离');
  const listA = await stuA.req('/api/assignments');
  check('A 班学生能看到 A 班作业', listA.data?.assignments?.some((a) => a.id === assignmentId));
  const listB = await stuB.req('/api/assignments');
  check('B 班学生看不到 A 班作业', !listB.data?.assignments?.some((a) => a.id === assignmentId));
  const detailB = await stuB.req(`/api/assignments/${assignmentId}`);
  check('B 班学生直接访问详情被拒绝（403）', detailB.status === 403);

  const teacherList = await teacher.req('/api/assignments');
  check('老师看不到管理员发布的作业', !teacherList.data?.assignments?.some((a) => a.id === assignmentId));

  section('作业提交');
  const submitEmpty = await stuA.req('/api/submissions', { method: 'POST', body: { assignmentId, content: '   ', files: [] } });
  check('空内容提交被拒绝（400）', submitEmpty.status === 400);

  const submit = await stuA.req('/api/submissions', {
    method: 'POST',
    body: { assignmentId, content: '老师好，我是张三，我的答案是……', files: [] },
  });
  check('学生提交作业成功', submit.status === 201 && submit.data?.submission?.status === 'pending');
  const submissionId = submit.data?.submission?.id;

  const submitB = await stuB.req('/api/submissions', { method: 'POST', body: { assignmentId, content: '越权提交', files: [] } });
  check('非本班学生无法提交（403）', submitB.status === 403);

  const mine = await stuA.req('/api/submissions/mine');
  check('学生可查看自己的提交', mine.data?.submissions?.length === 1);

  section('权限越权测试');
  check('学生访问账号列表被拒绝（403）', (await stuA.req('/api/users')).status === 403);
  check('学生访问审批列表被拒绝（403）', (await stuA.req('/api/submissions')).status === 403);
  check('学生访问系统设置被拒绝（403）', (await stuA.req('/api/settings')).status === 403);
  check('学生修改设置被拒绝（403）', (await stuA.req('/api/settings', { method: 'PATCH', body: { registerEnabled: false } })).status === 403);
  check('老师访问账号列表被拒绝（403）', (await teacher.req('/api/users')).status === 403);
  const otherSubmission = await stuB.req(`/api/submissions/${submissionId}`);
  check('学生不能查看他人提交（403）', otherSubmission.status === 403);
  const teacherReviewOther = await teacher.req(`/api/submissions/${submissionId}/review`, {
    method: 'POST',
    body: { action: 'approve', score: 100 },
  });
  check('老师不能批阅他人作业的提交（403）', teacherReviewOther.status === 403);

  section('审批流程');
  const pending = await admin.req('/api/submissions?status=pending');
  check('管理员待审批列表包含该提交', pending.data?.submissions?.some((s) => s.id === submissionId));
  check('待审批数量统计正确', pending.data?.counts?.pending >= 1);

  const badScore = await admin.req(`/api/submissions/${submissionId}/review`, {
    method: 'POST',
    body: { action: 'approve', score: 500 },
  });
  check('超满分被拒绝（400）', badScore.status === 400);

  const approve = await admin.req(`/api/submissions/${submissionId}/review`, {
    method: 'POST',
    body: { action: 'approve', score: 88, feedback: '写得很完整，继续保持。' },
  });
  check('审批通过成功', approve.status === 200 && approve.data?.submission?.status === 'approved');
  check('分数与评语已保存', approve.data?.submission?.score === 88 && approve.data?.submission?.feedback.includes('完整'));

  const stuDetail = await stuA.req(`/api/assignments/${assignmentId}`);
  check('学生能看到审批结果', stuDetail.data?.assignment?.mySubmission?.status === 'approved');
  check('学生能看到分数', stuDetail.data?.assignment?.mySubmission?.score === 88);

  const resubmit = await stuA.req('/api/submissions', { method: 'POST', body: { assignmentId, content: '改一下', files: [] } });
  check('已通过的作业禁止重新提交（400）', resubmit.status === 400);

  const statsA = await stuA.req('/api/stats');
  check('学生统计包含已通过数', statsA.data?.stats?.approved >= 1);

  section('老师独立作业闭环');
  const teacherAssignment = await teacher.req('/api/assignments', {
    method: 'POST',
    body: { title: `王老师的作业-${Date.now()}`, content: '请说明你的学习计划。', maxScore: 60, classIds: [classA.id], published: true },
  });
  check('老师可发布自己的作业', teacherAssignment.status === 201);
  const teacherAssignmentId = teacherAssignment.data?.assignment?.id;

  const teacherStats = await teacher.req('/api/stats');
  check('老师统计只算自己的作业', teacherStats.data?.stats?.assignmentCount === 1);

  const s2 = await stuA.req('/api/submissions', {
    method: 'POST',
    body: { assignmentId: teacherAssignmentId, content: '我的学习计划是……', files: [] },
  });
  check('学生可提交老师发布的作业', s2.status === 201);

  const tReview = await teacher.req(`/api/submissions/${s2.data.submission.id}/review`, {
    method: 'POST',
    body: { action: 'reject', score: 30, feedback: '请补充细节。' },
  });
  check('老师可批阅自己作业的提交', tReview.status === 200 && tReview.data?.submission?.status === 'rejected');

  const adminDeleteTeacher = await admin.req(`/api/assignments/${teacherAssignmentId}`, { method: 'DELETE' });
  check('管理员可删除老师作业', adminDeleteTeacher.status === 200);

  section('文件上传与权限');
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('hello homework')], { type: 'text/plain' }), '答案说明.txt');
  const upload = await stuA.req('/api/files', { method: 'POST', form });
  check('学生上传文件成功', upload.status === 201 && !!upload.data?.file?.id);
  const fileId = upload.data?.file?.id;
  check('中文文件名正确保存', upload.data?.file?.name === '答案说明.txt');

  const dlOwner = await stuA.req(`/api/files/${fileId}/download`, { raw: true });
  check('上传者可下载自己的文件', dlOwner.status === 200);
  const dlOther = await stuB.req(`/api/files/${fileId}/download`, { raw: true });
  check('其他学生不能下载（403）', dlOther.status === 403);
  const dlAdmin = await admin.req(`/api/files/${fileId}/download`, { raw: true });
  check('管理员可下载任意文件', dlAdmin.status === 200);

  const badType = new FormData();
  badType.append('file', new Blob([Buffer.from('x')], { type: 'application/x-msdownload' }), 'evil.exe');
  const uploadBad = await stuA.req('/api/files', { method: 'POST', form: badType });
  check('危险扩展名被拒绝（400）', uploadBad.status === 400);

  section('注册开关');
  const off = await admin.req('/api/settings', { method: 'PATCH', body: { registerEnabled: false } });
  check('管理员可关闭注册', off.status === 200 && off.data?.settings?.registerEnabled === false);
  const regBlocked = await anon.req('/api/auth/register', {
    method: 'POST',
    body: { username: `reg${Date.now()}`, name: '注册测试', password: '123456' },
  });
  check('关闭后注册被拒绝（400）', regBlocked.status === 400);
  await admin.req('/api/settings', { method: 'PATCH', body: { registerEnabled: true } });
  const regOk = await anon.req('/api/auth/register', {
    method: 'POST',
    body: { username: `reg${Date.now()}`, name: '注册测试', password: '123456' },
  });
  check('开启后可自助注册', regOk.status === 201 && regOk.data?.user?.role === 'student');

  section('批量导入学生');
  const stamp = Date.now().toString().slice(-6);
  const bulk = await admin.req('/api/users/bulk', {
    method: 'POST',
    body: { text: `s${stamp}a,学生甲\ns${stamp}b,学生乙\ns${stamp}a,重复学号`, password: '123456', classIds: [createdClassId] },
  });
  check('批量导入成功 2 人', bulk.status === 201 && bulk.data?.created?.length === 2);
  check('重复学号被跳过', bulk.data?.skipped?.length === 1);

  const studentLogin = await client('newstu').req('/api/auth/login', {
    method: 'POST',
    body: { username: `s${stamp}a`, password: '123456' },
  });
  check('导入的学生可登录且已分班', studentLogin.status === 200 && studentLogin.data?.user?.classNames?.length === 1);

  section('收尾');
  await admin.req(`/api/classes/${createdClassId}`, { method: 'DELETE' });
  await admin.req(`/api/assignments/${assignmentId}`, { method: 'DELETE' });
  const backup = await admin.req('/api/settings/backup', { raw: true });
  check('管理员可下载数据备份', backup.status === 200);

  console.log(`\n${'='.repeat(48)}`);
  console.log(`测试结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(48));
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(1);
});

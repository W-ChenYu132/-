/**
 * 远程部署验证脚本：对一个已上线的实例做端到端自检，跑完自动清理测试数据
 *
 * 用法：
 *   node scripts/verify-deploy.mjs https://xxx.onrender.com [管理员用户名] [管理员密码]
 */

const BASE = (process.argv[2] || '').replace(/\/+$/, '');
const ADMIN_USER = process.argv[3] || 'admin';
const ADMIN_PASS = process.argv[4] || 'admin123456';

if (!BASE) {
  console.log('用法：node scripts/verify-deploy.mjs https://xxx.onrender.com [用户名] [密码]');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];
const cleanup = { assignmentId: null, classId: null, userIds: [] };

const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  [OK]   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name} ${extra}`);
    console.log(`  [FAIL] ${name} ${extra}`);
  }
};

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const pair = c.split(';')[0];
      if (pair.startsWith('hw_session=')) cookie = pair;
    }
    const ct = res.headers.get('content-type') || '';
    let data = null;
    if (ct.includes('json')) data = await res.json().catch(() => null);
    else data = await res.text().catch(() => null);
    return { status: res.status, data, headers: res.headers };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = Date.now().toString(36).slice(-5);

async function warmUp() {
  // Render 免费实例休眠后首次访问需要约 30 秒唤醒
  for (let i = 1; i <= 6; i += 1) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(45000) });
      const ms = Date.now() - t0;
      if (res.ok) {
        console.log(`  唤醒完成：第 ${i} 次请求，耗时 ${(ms / 1000).toFixed(1)} 秒`);
        return true;
      }
      console.log(`  第 ${i} 次请求返回 HTTP ${res.status}，重试中…`);
    } catch (err) {
      console.log(`  第 ${i} 次请求失败（${err.name}），重试中…`);
    }
    await sleep(4000);
  }
  return false;
}

async function main() {
  console.log(`\n目标实例：${BASE}`);
  console.log(`管理员账号：${ADMIN_USER}\n`);

  console.log('[1] 服务可达性');
  const awake = await warmUp();
  check('站点能唤醒并响应 /healthz', awake);
  if (!awake) throw new Error('站点无法访问，后续检查跳过');

  const anon = client();
  const health = await anon('/healthz');
  check('健康检查返回 ok:true', health.status === 200 && health.data?.ok === true);

  const home = await anon('/');
  const homeHtml = typeof home.data === 'string' ? home.data : '';
  check('首页返回 HTML', home.status === 200 && homeHtml.includes('<title>'));
  check('页面标题含「云作业」', /云作业/.test(homeHtml));
  check('已配置安全响应头（CSP / nosniff）', Boolean(health.headers.get('content-security-policy')) && health.headers.get('x-content-type-options') === 'nosniff');
  check('登录页不再暴露初始密码', !(await (async () => {
    const js = await anon('/app.js');
    return typeof js.data === 'string' && js.data.includes('admin123456');
  })()));

  console.log('\n[2] 公开配置');
  const pub = await anon('/api/settings/public');
  check('可读取公开设置', pub.status === 200 && typeof pub.data?.registerEnabled === 'boolean');
  console.log(`         站点名称：${pub.data?.siteName}　自助注册：${pub.data?.registerEnabled ? '开启' : '关闭'}`);

  console.log('\n[3] 管理员登录');
  const admin = client();
  const bad = await admin('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: 'wrong-password' } });
  check('错误密码被拒绝（401）', bad.status === 401);

  const login = await admin('/api/auth/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
  if (login.status !== 200) {
    check(`管理员登录（${ADMIN_USER}）`, false, `HTTP ${login.status}：${login.data?.error?.message || ''}`);
    throw new Error(
      `管理员登录失败。如果部署时改过 ADMIN_PASSWORD，请这样运行：\n  node scripts/verify-deploy.mjs ${BASE} ${ADMIN_USER} 你的密码`,
    );
  }
  check(`管理员登录成功（${login.data?.user?.name}）`, login.data?.user?.role === 'admin');

  const me = await admin('/api/auth/me');
  check('会话 Cookie 可保持登录', me.status === 200 && me.data?.user?.username === ADMIN_USER);

  console.log('\n[4] 建班级 / 导入学生');
  const cls = await admin('/api/classes', {
    method: 'POST',
    body: { name: `部署自检班-${suffix}`, note: '由验证脚本创建，结束会自动删除' },
  });
  check('新建班级成功', cls.status === 201 && !!cls.data?.class?.id);
  cleanup.classId = cls.data?.class?.id;

  const s1 = `t${suffix}a`;
  const s2 = `t${suffix}b`;
  const bulk = await admin('/api/users/bulk', {
    method: 'POST',
    body: { text: `${s1},自检甲\n${s2},自检乙`, password: '123456', classIds: [cleanup.classId] },
  });
  check('批量导入 2 名学生', bulk.status === 201 && bulk.data?.created?.length === 2);

  const users = await admin('/api/users');
  for (const u of users.data?.users || []) {
    if ([s1, s2].includes(u.username)) cleanup.userIds.push(u.id);
  }
  check('学生已分配到班级', (users.data?.users || []).some((u) => u.username === s1 && u.classNames?.length === 1));

  console.log('\n[5] 发布作业 / 学生提交');
  const assignment = await admin('/api/assignments', {
    method: 'POST',
    body: {
      title: `[自检] 部署验证作业-${suffix}`,
      content: '这是部署自检脚本创建的作业，验证完成后会被自动删除。\n\n请随便写一句答案。',
      maxScore: 100,
      allowLate: true,
      published: true,
      classIds: [cleanup.classId],
    },
  });
  check('管理员发布作业成功', assignment.status === 201 && !!assignment.data?.assignment?.id);
  cleanup.assignmentId = assignment.data?.assignment?.id;

  const student = client();
  const sLogin = await student('/api/auth/login', { method: 'POST', body: { username: s1, password: '123456' } });
  check('学生用初始密码登录成功', sLogin.status === 200 && sLogin.data?.user?.role === 'student');

  const list = await student('/api/assignments');
  check('学生能看到本班作业', (list.data?.assignments || []).some((a) => a.id === cleanup.assignmentId));

  const submit = await student('/api/submissions', {
    method: 'POST',
    body: { assignmentId: cleanup.assignmentId, content: '自检答案：一切正常。', files: [] },
  });
  check('学生提交作业成功', submit.status === 201 && submit.data?.submission?.status === 'pending');

  console.log('\n[6] 管理员批阅 / 学生查看结果');
  const pendingList = await admin('/api/submissions?status=pending');
  const target = (pendingList.data?.submissions || []).find((s) => s.assignmentId === cleanup.assignmentId);
  check('审批列表出现该提交', Boolean(target));

  if (target) {
    const review = await admin(`/api/submissions/${target.id}/review`, {
      method: 'POST',
      body: { action: 'approve', score: 88, feedback: '部署自检通过：批阅链路正常。' },
    });
    check('批阅通过并打分成功', review.status === 200 && review.data?.submission?.status === 'approved');

    const detail = await student(`/api/assignments/${cleanup.assignmentId}`);
    const mine = detail.data?.assignment?.mySubmission;
    check('学生端看到「已通过」', mine?.status === 'approved');
    check('学生端看到分数 88 与评语', mine?.score === 88 && (mine?.feedback || '').includes('自检'));
  }

  console.log('\n[7] 权限隔离');
  const studentUsers = await student('/api/users');
  check('学生访问账号管理被拒绝（403）', studentUsers.status === 403);
  const studentSettings = await student('/api/settings');
  check('学生读取系统设置被拒绝（403）', studentSettings.status === 403);
  const anonAssignments = await anon('/api/assignments');
  check('未登录访问作业列表返回 401', anonAssignments.status === 401);
  const anonUsers = await anon('/api/users');
  check('未登录访问账号列表返回 401', anonUsers.status === 401);

  console.log('\n[8] 清理测试数据');
  if (cleanup.assignmentId) {
    const del = await admin(`/api/assignments/${cleanup.assignmentId}`, { method: 'DELETE' });
    check('删除自检作业', del.status === 200);
  }
  for (const id of cleanup.userIds) {
    await admin(`/api/users/${id}`, { method: 'DELETE' });
  }
  check(`删除 ${cleanup.userIds.length} 个自检学生`, cleanup.userIds.length === 2);
  if (cleanup.classId) {
    const del = await admin(`/api/classes/${cleanup.classId}`, { method: 'DELETE' });
    check('删除自检班级', del.status === 200);
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`验证结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(52));
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n验证中断：${err.message}`);
  process.exitCode = 1;
});

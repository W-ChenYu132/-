/**
 * 把备份文件（data/db.json 或后台下载的 backup json）恢复到某个已部署实例
 *
 * 典型场景：Render 免费实例重新部署后数据被重置，用之前下载的备份恢复。
 *
 * 用法：
 *   node scripts/restore-deploy.mjs <站点地址> <管理员用户名> <管理员密码> <备份文件> [--password=123456]
 *
 * 例：
 *   node scripts/restore-deploy.mjs https://homework-platform-t6zs.onrender.com admin 你的密码 data/homework-backup-xxx.json
 *
 * 说明：
 *   - 班级、账号、作业、提交、分数与评语都会按原样重建
 *   - 账号密码无法从备份里还原（备份只存哈希），统一重置为 --password（默认 123456）
 *   - 附件本体在重新部署后已丢失，只能恢复文字内容（会在结果里提示）
 */

import fs from 'node:fs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    }),
);

const [BASE, ADMIN_USER, ADMIN_PASS, BACKUP_PATH] = positional;
const TEMP_PASS = flags.password || '123456';

if (!BASE || !ADMIN_USER || !ADMIN_PASS || !BACKUP_PATH) {
  console.log(`
恢复备份到线上实例

用法：
  node scripts/restore-deploy.mjs <站点地址> <管理员用户名> <管理员密码> <备份文件> [--password=初始密码]

示例：
  node scripts/restore-deploy.mjs https://homework-platform-t6zs.onrender.com admin 你的密码 data/homework-backup-2026-10-25-12-53-29.json
`);
  process.exit(1);
}

const ROOT = BASE.replace(/\/+$/, '');
const backup = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));

const stat = { classes: 0, users: 0, assignments: 0, submissions: 0, skipped: 0 };
const createdAccounts = [];
const warnings = [];
const classMap = new Map(); // 旧班级 id -> 新班级 id
const assignmentMap = new Map(); // 旧作业 id -> 新作业 id
const userMap = new Map(); // 旧用户 id -> { username, name, role, password }

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(ROOT + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const pair = c.split(';')[0];
      if (pair.startsWith('hw_session=')) cookie = pair;
    }
    const ct = res.headers.get('content-type') || '';
    return {
      status: res.status,
      data: ct.includes('json') ? await res.json().catch(() => null) : await res.text().catch(() => null),
    };
  };
}

const admin = client();
console.log(`目标实例：${ROOT}`);
console.log(`备份文件：${BACKUP_PATH}`);
console.log(
  `备份内容：班级 ${backup.classes?.length || 0} 个、账号 ${backup.users?.length || 0} 个、` +
    `作业 ${backup.assignments?.length || 0} 份、提交 ${backup.submissions?.length || 0} 条\n`,
);

const login = await admin('/api/auth/login', {
  method: 'POST',
  body: { username: ADMIN_USER, password: ADMIN_PASS },
});
if (login.status !== 200) {
  console.error(`✗ 管理员登录失败（HTTP ${login.status}）：${login.data?.error?.message || ''}`);
  process.exit(1);
}
console.log(`✓ 已登录：${login.data.user.name}\n`);

/* ----------------------------- 1. 系统设置 ----------------------------- */
if (backup.settings) {
  const s = backup.settings;
  const res = await admin('/api/settings', {
    method: 'PATCH',
    body: {
      siteName: s.siteName || '云作业',
      registerEnabled: s.registerEnabled !== false,
      registerNote: s.registerNote || '',
    },
  });
  console.log(`  ${res.status === 200 ? '✓' : '✗'} 恢复系统设置（站点名称、注册开关）`);
}

/* ------------------------------ 2. 班级 ------------------------------ */
const existingClasses = (await admin('/api/classes')).data?.classes || [];
for (const c of backup.classes || []) {
  const dup = existingClasses.find((x) => x.name === c.name);
  if (dup) {
    classMap.set(c.id, dup.id);
    console.log(`  – 班级已存在，沿用：${c.name}`);
    continue;
  }
  const res = await admin('/api/classes', {
    method: 'POST',
    body: { name: c.name, note: c.note || '' },
  });
  if (res.status === 201) {
    classMap.set(c.id, res.data.class.id);
    stat.classes += 1;
    console.log(`  ✓ 班级：${c.name}`);
  } else {
    stat.skipped += 1;
    console.log(`  ✗ 班级 ${c.name}：${res.data?.error?.message || res.status}`);
  }
}

/* ------------------------------ 3. 账号 ------------------------------ */
const existingUsers = (await admin('/api/users')).data?.users || [];
const takenNames = new Set(existingUsers.map((u) => u.username.toLowerCase()));

for (const u of backup.users || []) {
  if (u.role === 'admin') {
    console.log(`  – 跳过管理员账号：${u.username}（密码保持你当前使用的不变）`);
    userMap.set(u.id, { username: u.username, name: u.name, role: 'admin', password: ADMIN_PASS });
    continue;
  }
  if (takenNames.has(u.username.toLowerCase())) {
    const found = existingUsers.find((x) => x.username.toLowerCase() === u.username.toLowerCase());
    userMap.set(u.id, { username: found.username, name: found.name, role: found.role, password: TEMP_PASS });
    console.log(`  – 账号已存在，沿用：${u.username}`);
    continue;
  }
  const classIds = (u.classIds || []).map((id) => classMap.get(id)).filter(Boolean);
  const res = await admin('/api/users', {
    method: 'POST',
    body: {
      username: u.username,
      name: u.name,
      password: TEMP_PASS,
      role: u.role === 'teacher' ? 'teacher' : 'student',
      classIds,
    },
  });
  if (res.status === 201) {
    takenNames.add(u.username.toLowerCase());
    userMap.set(u.id, { username: u.username, name: u.name, role: u.role, password: TEMP_PASS });
    stat.users += 1;
    if (u.role !== 'admin') createdAccounts.push({ username: u.username, name: u.name, role: u.role });
    console.log(`  ✓ 账号：${u.name}（${u.username}，${u.role === 'teacher' ? '老师' : '学生'}）`);
  } else {
    stat.skipped += 1;
    console.log(`  ✗ 账号 ${u.username}：${res.data?.error?.message || res.status}`);
  }
}

/* ------------------------------ 4. 作业 ------------------------------ */
const accountClients = new Map();
/** 用某个账号登录（带缓存），用于以原作者身份创建作业 / 以学生身份提交 */
async function asUser(info) {
  if (!info) return { client: admin, ok: true };
  if (accountClients.has(info.username)) return accountClients.get(info.username);
  const c = client();
  const res = await c('/api/auth/login', {
    method: 'POST',
    body: { username: info.username, password: info.password },
  });
  const entry = { client: c, ok: res.status === 200 };
  accountClients.set(info.username, entry);
  return entry;
}

let ownerRestored = 0;
for (const a of backup.assignments || []) {
  const creator = userMap.get(a.createdBy);
  // 老师发布的作业用老师自己的账号创建，这样老师仍能在「我的作业」里看到并批阅
  const { client: publisher, ok } = creator && creator.role === 'teacher' ? await asUser(creator) : { client: admin, ok: true };
  const res = await publisher('/api/assignments', {
    method: 'POST',
    body: {
      title: a.title,
      content: a.content || '（原作业内容为空）',
      answer: a.answer || '',
      answerVisibility: a.answerVisibility || 'afterSubmit',
      deadline: a.deadline || null,
      maxScore: a.maxScore || 100,
      allowLate: a.allowLate !== false,
      published: a.published !== false,
      classIds: (a.classIds || []).map((id) => classMap.get(id)).filter(Boolean),
      files: [],
    },
  });
  if (res.status === 201) {
    assignmentMap.set(a.id, res.data.assignment.id);
    stat.assignments += 1;
    if (creator && creator.role === 'teacher' && ok) ownerRestored += 1;
    const owner = creator && creator.role === 'teacher' && ok ? creator.name : '管理员';
    console.log(`  ✓ 作业：${a.title}（发布人：${owner}）`);
    if (creator && creator.role === 'teacher' && !ok) {
      warnings.push(`老师 ${creator.name} 登录失败，作业「${a.title}」已恢复为管理员发布`);
    }
  } else {
    stat.skipped += 1;
    console.log(`  ✗ 作业 ${a.title}：${res.data?.error?.message || res.status}`);
  }
  if ((a.files || []).length) {
    warnings.push(`作业「${a.title}」原有 ${a.files.length} 个附件，重新部署后附件文件已丢失，需要重新上传`);
  }
}

/* ------------------------------ 5. 提交 ------------------------------ */
for (const s of backup.submissions || []) {
  const assignmentId = assignmentMap.get(s.assignmentId);
  const student = userMap.get(s.studentId);
  if (!assignmentId || !student) {
    stat.skipped += 1;
    continue;
  }
  const { client: stu, ok } = await asUser(student);
  if (!ok) {
    stat.skipped += 1;
    warnings.push(`学生 ${student.name} 登录失败，其提交未能恢复`);
    continue;
  }
  const submit = await stu('/api/submissions', {
    method: 'POST',
    body: { assignmentId, content: s.content || '', files: [] },
  });
  if (submit.status !== 201) {
    stat.skipped += 1;
    console.log(`  ✗ 提交（${student.name}）：${submit.data?.error?.message || submit.status}`);
    continue;
  }
  stat.submissions += 1;

  if (s.status === 'approved' || s.status === 'rejected') {
    await admin(`/api/submissions/${submit.data.submission.id}/review`, {
      method: 'POST',
      body: {
        action: s.status === 'approved' ? 'approve' : 'reject',
        score: s.score ?? null,
        feedback: s.feedback || '',
      },
    });
    console.log(`  ✓ 提交：${student.name} → ${s.status === 'approved' ? '已通过' : '已驳回'}（${s.score ?? '-'} 分）`);
  } else {
    console.log(`  ✓ 提交：${student.name} → 待审批`);
  }
  if ((s.files || []).length) {
    warnings.push(`学生 ${student.name} 原有 ${s.files.length} 个附件，需重新上传`);
  }
}

/* ------------------------------- 汇总 ------------------------------- */
console.log(`\n${'='.repeat(52)}`);
console.log(`恢复完成：班级 ${stat.classes}、账号 ${stat.users}、作业 ${stat.assignments}、提交 ${stat.submissions}`);
if (stat.skipped) console.log(`跳过 ${stat.skipped} 项`);
console.log(`\n所有恢复的账号（学生/老师）密码统一重置为：${TEMP_PASS}`);
for (const a of createdAccounts) {
  console.log(`  ${a.role === 'teacher' ? '老师' : '学生'}　${a.name}　用户名：${a.username}`);
}
if (warnings.length) {
  console.log('\n需要注意：');
  for (const w of warnings) console.log(`  ! ${w}`);
}
console.log('='.repeat(52));

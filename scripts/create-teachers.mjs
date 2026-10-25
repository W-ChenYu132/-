/**
 * 批量创建老师（或管理员）账号
 *
 * 用法：
 *   node scripts/create-teachers.mjs <站点地址> <管理员用户名> <管理员密码> [--role=teacher] <"用户名,姓名" ...>
 *
 * 例：
 *   node scripts/create-teachers.mjs https://homework-platform-t6zs.onrender.com admin admin123456 \
 *        "wangls,王老师" "lils,李老师" "zhangls,张老师" --password=teacher123
 *
 * 说明：
 *   --password=xxx   统一初始密码（默认 123456）
 *   --role=xxx       teacher（默认）或 admin
 *   老师/管理员的用户名建议用拼音或工号，学生看不到这些账号
 */

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const [BASE, ADMIN_USER, ADMIN_PASS, ...entries] = positional;
const ROLE = flags.role === 'admin' ? 'admin' : 'teacher';
const DEFAULT_PASS = flags.password || '123456';

if (!BASE || !ADMIN_USER || !ADMIN_PASS || entries.length === 0) {
  console.log(`
批量创建${ROLE === 'admin' ? '管理员' : '老师'}账号

用法：
  node scripts/create-teachers.mjs <站点地址> <管理员用户名> <管理员密码> <"用户名,姓名" ...> [--password=初始密码] [--role=teacher|admin]

示例：
  node scripts/create-teachers.mjs https://homework-platform-t6zs.onrender.com admin admin123456 "wangls,王老师" "lils,李老师"
`);
  process.exit(1);
}

let cookie = '';
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE.replace(/\/+$/, '') + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
}

const login = await api('/api/auth/login', {
  method: 'POST',
  body: { username: ADMIN_USER, password: ADMIN_PASS },
});

if (login.status !== 200) {
  console.error(`✗ 管理员登录失败（HTTP ${login.status}）：${login.data?.error?.message || ''}`);
  console.error('  请确认管理员用户名/密码，以及站点地址是否正确。');
  process.exit(1);
}
console.log(`✓ 已登录：${login.data.user.name}（${login.data.user.roleText || login.data.user.role}）`);
console.log(`  目标站点：${BASE}\n`);

let ok = 0;
let skip = 0;
const created = [];

for (const entry of entries) {
  const [username, name] = entry.split(/[,，]/).map((s) => s.trim());
  if (!username) continue;
  const displayName = name || username;

  const res = await api('/api/users', {
    method: 'POST',
    body: { username, name: displayName, password: DEFAULT_PASS, role: ROLE, classIds: [] },
  });

  if (res.status === 201) {
    ok += 1;
    created.push({ username, name: displayName });
    console.log(`  ✓ ${username.padEnd(16)} ${displayName}`);
  } else {
    skip += 1;
    console.log(`  ✗ ${username.padEnd(16)} ${res.data?.error?.message || `HTTP ${res.status}`}`);
  }
}

console.log(`\n完成：新建 ${ok} 个，失败/跳过 ${skip} 个。初始密码：${DEFAULT_PASS}`);
if (created.length) {
  console.log('\n请把下面这些发给老师（登录后建议各自修改密码）：');
  for (const c of created) {
    console.log(`  ${c.name}　用户名：${c.username}　密码：${DEFAULT_PASS}`);
  }
}
console.log('\n提示：老师在「我的作业」里发布作业，在「提交审批」里批阅自己作业的提交；');
console.log('      他们看不到账号管理、系统设置，也看不到别人发布的作业。');

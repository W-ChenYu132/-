/**
 * 用 Chrome Headless + CDP 真实渲染页面并截图，用于人工核对界面效果。
 * 用法：node scripts/screenshots.mjs [baseUrl] [outDir]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const OUT = path.resolve(process.argv[3] || 'shots');
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------- 可选：先制造一点演示数据 ---------------------- */
async function apiClient() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, {
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
      data: ct.includes('json') ? await res.json().catch(() => null) : null,
    };
  };
}

async function seedDemoActivity() {
  const admin = await apiClient();
  await admin('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123456' } });
  const list = await admin('/api/assignments');
  const assignment = list.data?.assignments?.find((a) => a.classIds?.length) || list.data?.assignments?.[0];
  if (!assignment) return console.log('  （没有作业，跳过演示数据）');

  const submit = async (username, content) => {
    const c = await apiClient();
    await c('/api/auth/login', { method: 'POST', body: { username, password: '123456' } });
    const res = await c('/api/submissions', { method: 'POST', body: { assignmentId: assignment.id, content, files: [] } });
    return res.data?.submission?.id;
  };

  const first = await submit(
    'student',
    '老师好，我是张三。\n\n我来自高一(1)班，平时喜欢打篮球和研究电脑。\n希望在这门课里学会把复杂问题拆解成可执行的小步骤，也期待能有动手实践的机会。',
  );
  await submit('li', '老师好，我是李四，我的兴趣是画画和看纪录片，希望本学期能提升自己整理笔记的能力。');

  if (first) {
    await admin(`/api/submissions/${first}/review`, {
      method: 'POST',
      body: { action: 'approve', score: 92, feedback: '内容完整、条理清晰，如果能补充一个具体的学习目标会更好。' },
    });
  }
  console.log('  ✓ 已生成演示提交与批阅记录');
}

if (process.argv.includes('--with-demo-activity')) {
  console.log('准备演示数据…');
  await seedDemoActivity();
}


const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-shots-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1500,1000',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let seq = 0;
const pending = new Map();
let ws = null;

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }
    }, 25000);
  });
}

async function waitForEndpoint(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* 等待 Chrome 启动 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function main() {
  await waitForEndpoint(`http://127.0.0.1:${PORT}/json/version`);
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
    method: 'PUT',
  }).then((r) => r.json());

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const shot = async (name, wait = 900) => {
    await sleep(wait);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  📸 ${name}.png`);
  };

  const goto = async (url) => {
    await send('Page.navigate', { url });
    await sleep(700);
  };

  console.log('渲染登录页…');
  await goto(`${BASE}/`);
  await shot('01-login');

  const login = async (username, password) => {
    const res = await send('Runtime.evaluate', {
      expression: `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:${JSON.stringify(username)},password:${JSON.stringify(password)}})}).then(r=>r.status)`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.result?.value !== 200) throw new Error(`${username} 登录失败: ${res.result?.value}`);
  };

  const nav = async (hash, wait = 1100) => {
    await send('Runtime.evaluate', { expression: `location.hash=${JSON.stringify(hash)}` });
    await sleep(wait);
    const info = await send('Runtime.evaluate', {
      expression: `JSON.stringify({href: location.hash, title: document.querySelector('.topbar h1')?.textContent || document.querySelector('.auth-card h2')?.textContent || ''})`,
      returnByValue: true,
    });
    console.log(`     → ${info.result.value}`);
  };

  console.log('渲染管理员界面…');
  await login('admin', 'admin123456');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1600);
  await nav('#/overview');
  await shot('02-admin-overview', 1200);
  await nav('#/manage');
  await shot('03-admin-manage');
  await nav('#/reviews');
  await shot('04-admin-reviews');
  await nav('#/classes');
  await shot('05-admin-classes');
  await nav('#/users');
  await shot('06-admin-users');
  await nav('#/settings');
  await shot('07-admin-settings');

  // 发布作业弹窗
  await nav('#/manage');
  await send('Runtime.evaluate', {
    expression: `document.querySelector('[data-act="new-assignment"]').click()`,
  });
  await shot('08-admin-new-assignment', 1200);
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-act="close-modal"]').click()` });

  console.log('渲染学生界面…');
  await send('Runtime.evaluate', {
    expression: `fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'})`,
    awaitPromise: true,
  });
  await sleep(300);
  await login('student', '123456');
  await send('Page.reload', { ignoreCache: true });
  await sleep(1600);
  await nav('#/home');
  await shot('09-student-home', 1200);

  // 打开第一份作业详情
  const firstId = await send('Runtime.evaluate', {
    expression: `fetch('/api/assignments',{credentials:'same-origin'}).then(r=>r.json()).then(d=>d.assignments[0].id)`,
    awaitPromise: true,
    returnByValue: true,
  });
  const id = firstId.result.value;
  await nav(`#/assignment/${id}`);
  await shot('10-student-assignment', 1400);
  await nav('#/scores');
  await shot('11-student-scores');

  console.log(`\n截图已保存到 ${OUT}`);
}

main()
  .catch((err) => {
    console.error('截图失败:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
    await sleep(400);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

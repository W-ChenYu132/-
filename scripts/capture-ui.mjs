/**
 * 抓取图文教程用的界面截图，并自动在图上叠加编号标注。
 *
 * 用法：
 *   node scripts/capture-ui.mjs                       抓全部
 *   node scripts/capture-ui.mjs --only=step-login      只抓指定步骤（逗号分隔）
 *
 * 产出：shots/steps/*.png（带编号标注的成品图）+ legends.json（编号说明）
 *
 * 说明：本机需安装 Chrome；服务需先启动（npm start）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:3000';
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
const W = 1500;
const H = 1040;
const OUT = path.resolve('shots/steps');

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-ui-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${W},${H}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--disable-features=Translate',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/* ============================== CDP 连接 ============================== */

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Conn(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'page script failed');
    }
    return res.result?.value;
  }

  /** 截图（带重试：headless 下 captureScreenshot 偶发卡住） */
  async shot(file, clip) {
    let lastErr;
    for (const extra of [{}, { fromSurface: false }, {}]) {
      try {
        const { data } = await this.send('Page.captureScreenshot', {
          format: 'png',
          ...extra,
          ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
        });
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        return;
      } catch (err) {
        lastErr = err;
        await sleep(900);
      }
    }
    throw lastErr;
  }
}

async function waitEndpoint(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 等待 Chrome 启动 */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

/** 弹窗的毛玻璃在 headless 下容易导致截图卡住，截图前先关掉 */
const NO_BLUR_CSS = `(() => {
  if (document.getElementById('__noblur')) return true;
  const s = document.createElement('style');
  s.id = '__noblur';
  s.textContent = '.modal-overlay{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}';
  document.head.appendChild(s);
  return true;
})()`;

/* ============================ 演示数据准备 ============================ */

async function apiClient() {
  let cookie = '';
  return async (p, { method = 'GET', body } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const pair = c.split(';')[0];
      if (pair.startsWith('hw_session=')) cookie = pair;
    }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json().catch(() => null) : null };
  };
}

async function prepareDemoData() {
  const admin = await apiClient();
  const login = await admin('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'admin123456' },
  });
  if (login.status !== 200) throw new Error('管理员登录失败，请确认服务已启动并已初始化演示数据');

  const classes = (await admin('/api/classes')).data?.classes || [];
  if (!classes.length) throw new Error('没有班级数据，请删除 data/ 后用 SEED_DEMO=1 重启服务');
  const classA = classes[0];

  const tail = String(Date.now()).slice(-3);
  await admin('/api/users/bulk', {
    method: 'POST',
    body: {
      text: `2026${tail}1,赵一\n2026${tail}2,钱二\n2026${tail}3,孙三`,
      password: '123456',
      classIds: [classA.id],
    },
  });

  const assignments = (await admin('/api/assignments')).data?.assignments || [];
  const target = assignments.find((a) => (a.classIds || []).length) || assignments[0];
  if (!target) throw new Error('没有作业数据');

  const submitAs = async (username, content) => {
    const c = await apiClient();
    await c('/api/auth/login', { method: 'POST', body: { username, password: '123456' } });
    const res = await c('/api/submissions', {
      method: 'POST',
      body: { assignmentId: target.id, content, files: [] },
    });
    return res.data?.submission?.id;
  };

  const zhangId = await submitAs(
    'student',
    '老师好，我是张三。\n\n我来自高一(1)班，平时喜欢打篮球，也对计算机很感兴趣。\n希望在课程中学会把复杂问题拆解成可执行的小步骤，并期待更多动手实践的机会。',
  );
  if (zhangId) {
    await admin(`/api/submissions/${zhangId}/review`, {
      method: 'POST',
      body: {
        action: 'approve',
        score: 92,
        feedback: '内容完整、条理清晰。如果能补充一个具体的学习目标，会更具体。',
      },
    });
  }

  const liId = await submitAs('li', '老师好，我是李四。我的兴趣是画画和看纪录片。');
  if (liId) {
    await admin(`/api/submissions/${liId}/review`, {
      method: 'POST',
      body: { action: 'reject', score: 60, feedback: '请补充第 2、3 点内容后重新提交。' },
    });
    await submitAs(
      'li',
      '老师好，我是李四。\n\n1. 我来自高一(1)班；\n2. 兴趣是画画和看纪录片，喜欢把知识整理成图表；\n3. 希望这个学期能提升归纳重点、独立完成长作业的能力。',
    );
  }

  const wang = await apiClient();
  await wang('/api/auth/login', { method: 'POST', body: { username: 'wang', password: '123456' } });
  const wangList = (await wang('/api/assignments')).data?.assignments || [];
  if (wangList.length) {
    await wang('/api/submissions', {
      method: 'POST',
      body: {
        assignmentId: wangList[0].id,
        content: '老师好，我是王五。我对这门课最想弄清楚的问题是：怎样才能把学到的知识真正用起来？',
        files: [],
      },
    });
  }

  const counts = (await admin('/api/submissions?status=pending')).data?.counts || {};
  console.log(`  演示数据：作业 ${assignments.length} 份，待审批 ${counts.pending ?? 0} 条`);
}

/* ============================== 截图步骤 ============================== */

const steps = [
  {
    name: 'step-login',
    user: null,
    hash: '#/login',
    legend: ['用户名输入框', '密码输入框', '登录按钮', '自助注册标签（管理员开启时才显示）'],
    marks: [
      { label: '1', sel: '#login-username' },
      { label: '2', sel: '#login-password' },
      { label: '3', sel: 'form[data-form="login"] button[type="submit"]' },
      { label: '4', sel: '[data-act="auth-tab"][data-tab="register"]' },
    ],
  },
  {
    name: 'admin-overview',
    user: 'admin',
    hash: '#/overview',
    legend: ['左侧功能菜单', '待审批提交', '作业总数', '提交总数', '提交审批入口（红点＝待办数量）'],
    marks: [
      { label: '1', sel: 'a.nav-item[href="#/overview"]' },
      { label: '2', sel: '.stat-grid .stat-card:nth-child(1)' },
      { label: '3', sel: '.stat-grid .stat-card:nth-child(2)' },
      { label: '4', sel: '.stat-grid .stat-card:nth-child(4)' },
      { label: '5', sel: 'a.nav-item[href="#/reviews"]' },
    ],
  },
  {
    name: 'admin-manage',
    user: 'admin',
    hash: '#/manage',
    legend: ['发布作业按钮', '面向班级列', '状态列（已发布／草稿）', '提交情况列', '编辑作业', '发布／撤回切换'],
    marks: [
      { label: '1', sel: '[data-act="new-assignment"]' },
      { label: '2', sel: 'table.data thead th:nth-child(3)' },
      { label: '3', sel: 'table.data thead th:nth-child(4)' },
      { label: '4', sel: 'table.data thead th:nth-child(6)' },
      { label: '5', sel: '[data-act="edit-assignment"]' },
      { label: '6', sel: '[data-act="toggle-publish"]' },
    ],
  },
  {
    name: 'admin-assign-modal',
    user: 'admin',
    hash: '#/manage',
    before: `document.querySelector('[data-act="new-assignment"]').click()`,
    wait: 1300,
    legend: ['作业标题', '题目内容', '面向班级（不勾＝全体学生）', '截止时间', '满分', '题目附件', '发布按钮'],
    marks: [
      { label: '1', sel: '#hw-title' },
      { label: '2', sel: '#hw-content' },
      { label: '3', sel: 'input[data-cls="cls"]' },
      { label: '4', sel: '#hw-deadline' },
      { label: '5', sel: '#hw-maxscore' },
      { label: '6', sel: '#upload-zone' },
      { label: '7', sel: '[data-act="save-assignment"]' },
    ],
  },
  {
    name: 'admin-assign-filled',
    user: 'admin',
    hash: '#/manage',
    before: `(() => {
      document.querySelector('[data-act="new-assignment"]').click();
      return new Promise((r) => setTimeout(() => {
        document.querySelector('#hw-title').value = '第 3 次作业：一元二次方程练习';
        document.querySelector('#hw-content').value = '请完成课本 P42 习题 1~6，要求：\\n\\n1. 写出完整的解题步骤；\\n2. 拍照或整理成 Word 上传；\\n3. 有疑问的题目可以一并写下来。';
        const boxes = document.querySelectorAll('input[data-cls="cls"]');
        if (boxes[0]) boxes[0].checked = true;
        document.querySelector('#hw-deadline').value = '2026-11-08T22:00';
        r(true);
      }, 1000));
    })()`,
    awaitBefore: true,
    legend: ['填写标题', '粘贴题目要求（换行会被保留）', '勾选目标班级', '设置截止时间', '点发布作业'],
    marks: [
      { label: '1', sel: '#hw-title' },
      { label: '2', sel: '#hw-content' },
      { label: '3', sel: 'input[data-cls="cls"]' },
      { label: '4', sel: '#hw-deadline' },
      { label: '5', sel: '[data-act="save-assignment"]' },
    ],
  },
  {
    name: 'admin-reviews',
    user: 'admin',
    hash: '#/reviews',
    legend: ['待审批标签（数字＝待办数）', '搜索学生／作业', '状态列', '批阅按钮'],
    marks: [
      { label: '1', sel: '[data-act="review-filter"][data-status="pending"]' },
      { label: '2', sel: '#review-search' },
      { label: '3', sel: 'table.data thead th:nth-child(5)' },
      { label: '4', sel: '[data-act="review"]' },
    ],
  },
  {
    name: 'admin-review-modal',
    user: 'admin',
    hash: '#/reviews',
    before: `document.querySelector('[data-act="review"]').click()`,
    wait: 1500,
    legend: ['学生作答全文', '分数输入框', '评语输入框', '通过并保存', '驳回'],
    marks: [
      { label: '1', sel: '.modal-body .prose' },
      { label: '2', sel: '#review-score' },
      { label: '3', sel: '#review-feedback' },
      { label: '4', sel: '[data-act="do-review"][data-action="approve"]' },
      { label: '5', sel: '[data-act="do-review"][data-action="reject"]' },
    ],
  },
  {
    name: 'admin-classes',
    user: 'admin',
    hash: '#/classes',
    legend: ['新建班级', '班级学生名单', '编辑班级', '删除班级'],
    marks: [
      { label: '1', sel: '[data-act="new-class"]' },
      { label: '2', sel: '.grid-cards .card .chips' },
      { label: '3', sel: '[data-act="edit-class"]' },
      { label: '4', sel: '[data-act="delete-class"]' },
    ],
  },
  {
    name: 'admin-class-modal',
    user: 'admin',
    hash: '#/classes',
    before: `document.querySelector('[data-act="new-class"]').click()`,
    wait: 1000,
    legend: ['班级名称', '备注（可留空）', '保存'],
    marks: [
      { label: '1', sel: '#class-name' },
      { label: '2', sel: '#class-note' },
      { label: '3', sel: '[data-act="save-class"]' },
    ],
  },
  {
    name: 'admin-users',
    user: 'admin',
    hash: '#/users',
    legend: ['批量添加学生', '新增单个账号', '按角色筛选', '按班级筛选', '编辑／重置密码', '停用／启用'],
    marks: [
      { label: '1', sel: '[data-act="bulk-user"]' },
      { label: '2', sel: '[data-act="new-user"]' },
      { label: '3', sel: '[data-act="user-role-filter"][data-role="student"]' },
      { label: '4', sel: '#user-class-filter' },
      { label: '5', sel: '[data-act="edit-user"]' },
      { label: '6', sel: '[data-act="toggle-user"]' },
    ],
  },
  {
    name: 'admin-user-modal',
    user: 'admin',
    hash: '#/users',
    before: `document.querySelector('[data-act="new-user"]').click()`,
    wait: 1300,
    legend: ['用户名（建议用学号）', '姓名', '初始密码', '角色（学生／老师／管理员）', '所属班级', '保存'],
    marks: [
      { label: '1', sel: '#user-username' },
      { label: '2', sel: '#user-name' },
      { label: '3', sel: '#user-password' },
      { label: '4', sel: '#user-role' },
      { label: '5', sel: 'input[data-cls="user"]' },
      { label: '6', sel: '[data-act="save-user"]' },
    ],
  },
  {
    name: 'admin-bulk-modal',
    user: 'admin',
    hash: '#/users',
    before: `(() => {
      document.querySelector('[data-act="bulk-user"]').click();
      return new Promise((r) => setTimeout(() => {
        document.querySelector('#bulk-text').value = '2026010,周宁\\n2026011,吴迪\\n2026012,郑好';
        const boxes = document.querySelectorAll('input[data-cls="bulk"]');
        if (boxes[0]) boxes[0].checked = true;
        r(true);
      }, 1000));
    })()`,
    awaitBefore: true,
    legend: ['学生名单（每行「用户名,姓名」）', '统一初始密码', '分配班级', '开始导入'],
    marks: [
      { label: '1', sel: '#bulk-text' },
      { label: '2', sel: '#bulk-password' },
      { label: '3', sel: 'input[data-cls="bulk"]' },
      { label: '4', sel: '[data-act="do-bulk-user"]' },
    ],
  },
  {
    name: 'admin-settings',
    user: 'admin',
    hash: '#/settings',
    legend: ['站点名称', '自助注册开关', '注册页提示语', '保存设置', '下载数据备份'],
    marks: [
      { label: '1', sel: '#set-site' },
      { label: '2', sel: '#set-register' },
      { label: '3', sel: '#set-register-note' },
      { label: '4', sel: '[data-act="save-settings"]' },
      { label: '5', sel: 'a[href="/api/settings/backup"]' },
    ],
  },
  {
    name: 'admin-password',
    user: 'admin',
    hash: '#/overview',
    before: `document.querySelector('[data-act="open-password"]').click()`,
    wait: 1000,
    legend: ['当前密码', '新密码', '确认新密码', '确认修改'],
    marks: [
      { label: '1', sel: '#pw-old' },
      { label: '2', sel: '#pw-new' },
      { label: '3', sel: '#pw-confirm' },
      { label: '4', sel: '[data-act="save-password"]' },
    ],
  },
  {
    name: 'student-home',
    user: 'student',
    hash: '#/home',
    legend: ['待完成作业数', '状态筛选标签', '作业卡片（点开看题目）', '当前状态'],
    marks: [
      { label: '1', sel: '.stat-grid .stat-card:nth-child(1)' },
      { label: '2', sel: '[data-act="home-filter"][data-filter="all"]' },
      { label: '3', sel: '.hw-card' },
      { label: '4', sel: '.hw-card .badge' },
    ],
  },
  {
    name: 'student-detail-approved',
    user: 'student',
    hash: '#/home',
    before: `(async () => {
      const r = await fetch('/api/assignments', { credentials: 'same-origin' });
      const d = await r.json();
      const item = d.assignments.find((a) => a.mySubmission && a.mySubmission.status === 'approved')
        || d.assignments.find((a) => a.mySubmission) || d.assignments[0];
      location.hash = '#/assignment/' + item.id;
      return true;
    })()`,
    awaitBefore: true,
    wait: 1700,
    legend: ['当前状态', '作业要求（截止时间／满分等）', '我的作答与批阅结果', '得分'],
    marks: [
      { label: '1', sel: '.card-head .badge' },
      { label: '2', sel: '.kv' },
      { label: '3', sel: '.review-result' },
      { label: '4', sel: '.review-result .rr-score' },
    ],
  },
  {
    name: 'student-detail-todo',
    user: 'student',
    hash: '#/home',
    before: `(async () => {
      const r = await fetch('/api/assignments', { credentials: 'same-origin' });
      const d = await r.json();
      const item = d.assignments.find((a) => !a.mySubmission) || d.assignments[d.assignments.length - 1];
      location.hash = '#/assignment/' + item.id;
      return true;
    })()`,
    awaitBefore: true,
    wait: 1700,
    legend: ['题目内容', '截止时间与要求', '在这里输入答案', '上传附件区域', '提交作业按钮'],
    marks: [
      { label: '1', sel: '.card .prose' },
      { label: '2', sel: '.kv' },
      { label: '3', sel: '#answer-content' },
      { label: '4', sel: '#upload-zone' },
      { label: '5', sel: 'form[data-form="submit-assignment"] button[type="submit"]' },
    ],
  },
  {
    name: 'student-scores',
    user: 'student',
    hash: '#/scores',
    legend: ['提交状态', '老师给的分数', '老师评语', '查看作业详情'],
    marks: [
      { label: '1', sel: 'table.data thead th:nth-child(3)' },
      { label: '2', sel: 'table.data thead th:nth-child(4)' },
      { label: '3', sel: 'table.data thead th:nth-child(5)' },
      { label: '4', sel: 'table.data tbody tr:first-child a.btn' },
    ],
  },
];

/* ============================== 流程图 ============================== */

const diagrams = [
  {
    name: 'diagram-flow',
    width: 1500,
    height: 440,
    html: `
      <h1>作业全流程</h1>
      <div class="row">
        ${[
          ['1', '发布作业', '管理员或老师选题、<br/>指定班级、设置截止时间'],
          ['2', '学生提交', '在线文字作答，<br/>可同时上传附件'],
          ['3', '在线批阅', '通过或驳回，<br/>给分数、写评语'],
          ['4', '结果反馈', '学生即时看到<br/>成绩与评语'],
        ]
          .map(([n, t, d]) => `<div class="card"><div class="num">${n}</div><h3>${t}</h3><p>${d}</p></div>`)
          .join('<div class="arrow">→</div>')}
      </div>`,
  },
  {
    name: 'diagram-deploy',
    width: 1500,
    height: 500,
    html: `
      <h1>Render 免费部署四步走</h1>
      <div class="row">
        ${[
          ['1', '代码推到 GitHub', 'git push'],
          ['2', 'Render 建 Blueprint', '选择仓库'],
          ['3', '填写管理员密码', 'ADMIN_PASSWORD'],
          ['4', '得到公网网址', 'https://xxx.onrender.com'],
        ]
          .map(([n, t, d]) => `<div class="card"><div class="num">${n}</div><h3>${t}</h3><p class="mono">${d}</p></div>`)
          .join('<div class="arrow">→</div>')}
      </div>
      <div class="foot">完成后把网址发给老师和学生，手机、电脑打开就能直接用</div>`,
  },
  {
    name: 'diagram-status',
    width: 1500,
    height: 470,
    html: `
      <h1>学生看到的作业状态怎么变</h1>
      <div class="row">
        <div class="card gray"><h3>未提交</h3><p>还没交作业</p></div>
        <div class="arrow">提交 →</div>
        <div class="card amber"><h3>待审批</h3><p>已提交，等老师批阅</p></div>
        <div class="arrow">老师批阅 →</div>
        <div class="card green"><h3>已通过</h3><p>有分数和评语，不能再改</p></div>
      </div>
      <div class="row2">
        <div class="card red"><h3>已驳回</h3><p>按评语修改后可重新提交</p></div>
        <div class="arrow">← 驳回</div>
        <div class="note">被驳回后重新提交，状态会自动回到「待审批」，老师会重新批阅</div>
      </div>`,
  },
  {
    name: 'diagram-roles',
    width: 1500,
    height: 500,
    html: `
      <h1>三种角色各能做什么</h1>
      <div class="row">
        <div class="card blue"><h3>管理员</h3><p>发布和管理全部作业<br/>批阅全部提交<br/>班级与账号管理<br/>系统设置与数据备份</p></div>
        <div class="card indigo"><h3>老师</h3><p>发布自己的作业<br/>批阅自己作业的提交<br/>查看自己的数据统计<br/>看不到别人的作业</p></div>
        <div class="card green"><h3>学生</h3><p>查看本班作业<br/>在线作答 + 上传附件<br/>查看分数与评语<br/>驳回后可重新提交</p></div>
      </div>`,
  },
];

const DIAGRAM_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 40px;
    font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    background: #f6f8fc; color: #16233d; overflow: hidden;
  }
  h1 { font-size: 29px; margin: 0 0 24px; color: #122c58; }
  .row { display: flex; align-items: stretch; gap: 4px; }
  .row2 { display: flex; align-items: center; gap: 4px; margin-top: 20px; }
  .card {
    flex: 1; background: #fff; border: 1px solid #dbe3f0; border-radius: 16px;
    padding: 20px 20px 18px; box-shadow: 0 8px 24px rgba(24,46,92,.07);
  }
  .card .num {
    width: 32px; height: 32px; border-radius: 50%; background: #2b6cf6; color: #fff;
    font-weight: 700; font-size: 16px; display: grid; place-items: center; margin-bottom: 10px;
  }
  .card h3 { font-size: 20px; margin: 0 0 8px; color: #122c58; }
  .card p { font-size: 15px; line-height: 1.7; color: #4a5872; margin: 0; }
  .mono { font-family: Consolas, monospace; font-size: 13.5px !important; color: #b03a5b !important; }
  .arrow { align-self: center; font-size: 24px; color: #9fb3d1; font-weight: 700; padding: 0 2px; white-space: nowrap; }
  .foot { margin-top: 22px; font-size: 15.5px; color: #1b3a7a; background: #eaf1ff;
          border: 1px solid #2b6cf6; border-radius: 12px; padding: 13px 18px; }
  .card.gray { background: #f1f4fa; }
  .card.amber { background: #fdf6e8; border-color: #f3d9a4; }
  .card.green { background: #eef9f1; border-color: #bfe8cf; }
  .card.red { background: #fdeeee; border-color: #f6cccc; flex: 0 0 330px; }
  .card.blue { border-top: 5px solid #2b6cf6; }
  .card.indigo { border-top: 5px solid #6b5ce7; }
  .note { font-size: 15px; color: #4a5872; padding-left: 6px; }
`;

/* ============================== 主流程 ============================== */

async function main() {
  await waitEndpoint(`http://127.0.0.1:${PORT}/json/version`);

  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;
  const activeSteps = only ? steps.filter((s) => only.includes(s.name)) : steps;
  if (!activeSteps.length) throw new Error(`没有匹配的步骤: ${only.join(', ')}`);
  const activeDiagrams = only ? diagrams.filter((d) => only.includes(d.name)) : diagrams;

  if (activeSteps.some((s) => s.user)) {
    console.log('准备演示数据…');
    await prepareDemoData();
  }

  /* ---- 阶段一：只开一个页面，逐一截图原图 ---- */
  const appTarget = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const app = await Conn.open(appTarget.webSocketDebuggerUrl);
  await app.send('Page.enable');
  await app.send('Runtime.enable');
  await app.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const records = [];
  let currentUser = '__none__';

  for (const s of activeSteps) {
    if (currentUser !== s.user) {
      await app.send('Page.navigate', { url: `${BASE}/#/login` });
      await sleep(700);
      if (s.user) {
        const creds =
          s.user === 'admin'
            ? { username: 'admin', password: 'admin123456' }
            : { username: 'student', password: '123456' };
        const status = await app.evaluate(
          `fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(${JSON.stringify(
            creds,
          )})}).then(r=>r.status)`,
          true,
        );
        if (status !== 200) throw new Error(`登录失败：${s.user}（HTTP ${status}）`);
      } else {
        await app.evaluate(`fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'})`, true);
      }
      await app.send('Page.reload', { ignoreCache: true });
      await sleep(1800);
      currentUser = s.user;
    }

    await app.evaluate(`location.hash = ${JSON.stringify(s.hash)}`);
    await sleep(1400);

    if (s.before) {
      await app.evaluate(s.before, Boolean(s.awaitBefore));
      await sleep(s.wait || 900);
    }
    await app.evaluate(NO_BLUR_CSS);
    await sleep(500);

    const coords = await app.evaluate(`(() => {
      const marks = ${JSON.stringify(s.marks || [])};
      return marks.map((m) => {
        const el = document.querySelector(m.sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
        return { label: m.label, x: Math.round(r.left), y: Math.round(r.top) };
      });
    })()`);

    const missing = (s.marks || []).filter((m, i) => !coords[i]).map((m) => m.sel);
    if (missing.length) console.log(`    ! ${s.name} 未找到: ${missing.join(', ')}`);

    const rawPath = path.join(OUT, `_${s.name}-raw.png`);
    await app.shot(rawPath);
    records.push({ name: s.name, rawPath, coords, legend: s.legend || [] });
    console.log(`  . ${s.name} 原始截图完成 (${coords.filter(Boolean).length}/${coords.length})`);

    await app.evaluate(
      `(() => { const c = document.querySelector('[data-act="close-modal"]'); if (c) c.click(); return true; })()`,
    );
    await sleep(300);
  }

  await fetch(`http://127.0.0.1:${PORT}/json/close/${appTarget.id}`).catch(() => {});
  await sleep(600);

  /* ---- 阶段二：独立页面叠加编号，输出成品图 ---- */
  const ovTarget = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  ).json();
  const ov = await Conn.open(ovTarget.webSocketDebuggerUrl);
  await ov.send('Page.enable');
  await ov.send('Runtime.enable');
  await ov.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  console.log('\n叠加编号…');
  const legends = {};
  for (const rec of records) {
    const badges = rec.coords
      .filter(Boolean)
      .map((m) => {
        const x = Math.min(Math.max(m.x - 4, 20), W - 20);
        const y = Math.min(Math.max(m.y - 4, 20), H - 20);
        return `<div class="mark" style="left:${x}px;top:${y}px">${m.label}</div>`;
      })
      .join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:#fff}
      .wrap{position:relative;width:${W}px;height:${H}px;overflow:hidden}
      img{display:block;width:${W}px;height:${H}px}
      .mark{position:absolute;width:28px;height:28px;border-radius:50%;background:#ff3b30;color:#fff;
        font:700 16px/33px "Segoe UI",Arial,sans-serif;text-align:center;
        border:2.5px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.45);
        transform:translate(-50%,-50%);box-sizing:content-box}
    </style></head><body>
    <div class="wrap"><img src="file:///${rec.rawPath.replace(/\\/g, '/')}">${badges}</div>
    </body></html>`;

    const htmlPath = path.join(OUT, `_${rec.name}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    await ov.send('Page.navigate', { url: `file:///${htmlPath.replace(/\\/g, '/')}` });
    await sleep(600);
    await ov.shot(path.join(OUT, `${rec.name}.png`), { x: 0, y: 0, width: W, height: H });
    fs.rmSync(htmlPath, { force: true });
    fs.rmSync(rec.rawPath, { force: true });

    legends[rec.name] = rec.legend;
    console.log(`  > ${rec.name}.png (${rec.coords.filter(Boolean).length} 个标注)`);
  }

  if (activeDiagrams.length) {
    console.log('生成流程图…');
    for (const d of activeDiagrams) {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DIAGRAM_CSS}
        body{width:${d.width}px;height:${d.height}px}
      </style></head><body>${d.html}</body></html>`;
      const file = path.join(OUT, `_${d.name}.html`);
      fs.writeFileSync(file, html, 'utf8');
      await ov.send('Emulation.setDeviceMetricsOverride', {
        width: d.width,
        height: d.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await ov.send('Page.navigate', { url: `file:///${file.replace(/\\/g, '/')}` });
      await sleep(550);
      await ov.shot(path.join(OUT, `${d.name}.png`), { x: 0, y: 0, width: d.width, height: d.height });
      fs.rmSync(file, { force: true });
      console.log(`  > ${d.name}.png (流程图)`);
    }
  }

  const legendFile = path.join(OUT, 'legends.json');
  const existing = fs.existsSync(legendFile) ? JSON.parse(fs.readFileSync(legendFile, 'utf8')) : {};
  fs.writeFileSync(legendFile, JSON.stringify({ ...existing, ...legends }, null, 2), 'utf8');

  console.log(`\n完成：${records.length} 张界面截图 + ${activeDiagrams.length} 张流程图 → ${OUT}`);
}

main()
  .catch((err) => {
    console.error('截图失败:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    chrome.kill();
    await sleep(400);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

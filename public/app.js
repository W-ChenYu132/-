/* =========================================================================
 * 云作业 · 在线作业平台 前端
 * 纯原生 JS（hash 路由 + fetch API），无需构建
 * 角色：admin（管理员，全部权限）/ teacher（老师，只能管理自己的作业）/ student（学生）
 * ========================================================================= */

const API = '/api';

const state = {
  user: null,
  settings: { siteName: '云作业', registerEnabled: true, registerNote: '' },
  stats: null,
  classes: [],
  userCache: [],
  authTab: 'login',
  reviewStatus: 'pending',
  reviewKeyword: '',
  reviewAssignment: '',
  manageFilter: 'all',
  homeFilter: 'all',
  userRole: '',
  userClassId: '',
  uploads: { assignment: [], submission: [] },
  lastReviewId: null,
  editingAssignmentId: '',
};

/* ------------------------------ 小工具 ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateShort(iso) {
  if (!iso) return '不限';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '不限';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function deadlineInfo(a) {
  if (!a.deadline) return { text: '不限截止时间', cls: '' };
  const t = new Date(a.deadline).getTime();
  const diff = t - Date.now();
  if (diff <= 0) return { text: `已截止（${fmtDateShort(a.deadline)}）`, cls: 'text-danger' };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days >= 1) return { text: `剩 ${days} 天 ${hours} 小时`, cls: days <= 1 ? 'text-warn' : '' };
  const mins = Math.floor((diff % 3600000) / 60000);
  return { text: `剩 ${hours} 小时 ${mins} 分`, cls: 'text-warn' };
}

const STATUS_META = {
  pending: { label: '待审批', cls: 'pending' },
  approved: { label: '已通过', cls: 'approved' },
  rejected: { label: '已驳回', cls: 'rejected' },
  todo: { label: '未提交', cls: 'todo' },
  expired: { label: '已截止', cls: 'expired' },
};

const badge = (status, label) => {
  const meta = STATUS_META[status] || { label: status, cls: 'info' };
  return `<span class="badge ${meta.cls}">${esc(label || meta.label)}</span>`;
};

const excerpt = (str, len = 80) => {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  return s.length > len ? `${s.slice(0, len)}…` : s;
};

function studentState(a) {
  if (a.mySubmission) return a.mySubmission.status;
  return a.expired ? 'expired' : 'todo';
}

const isStaff = () => state.user && (state.user.role === 'admin' || state.user.role === 'teacher');
const isAdmin = () => state.user?.role === 'admin';

/* ------------------------------ 请求封装 ------------------------------ */

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
  if (opts.body instanceof FormData) {
    init.body = opts.body;
  } else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(API + path, init);
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    if (res.status === 401) {
      state.user = null;
      if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    }
    const err = new Error(payload?.error?.message || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* ------------------------------ Toast / 弹窗 ------------------------------ */

function toast(message, type = 'info') {
  const host = $('#toast-host');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s ease, transform .25s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-8px)';
    setTimeout(() => el.remove(), 260);
  }, type === 'error' ? 3600 : 2200);
}

function openModal({ title, body, footer = '', wide = false, onMount }) {
  closeModal();
  const host = $('#modal-host');
  host.innerHTML = `
    <div class="modal-overlay" data-act="close-modal">
      <div class="modal ${wide ? 'wide' : ''}" data-act="modal-inner" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="modal-close" data-act="close-modal" aria-label="关闭">×</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  if (onMount) onMount();
}

function closeModal() {
  $('#modal-host').innerHTML = '';
}

function askConfirm({ title = '确认操作', message = '', confirmText = '确定', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title,
      body: `<p style="font-size:14px;color:var(--text-2);line-height:1.8">${esc(message)}</p>`,
      footer: `
        <button class="btn btn-ghost" data-act="confirm-cancel">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="confirm-ok">${esc(confirmText)}</button>`,
      onMount() {
        const host = $('#modal-host');
        host.querySelector('[data-act="confirm-ok"]').onclick = () => done(true);
        host.querySelector('[data-act="confirm-cancel"]').onclick = () => done(false);
        host.querySelector('.modal-overlay').addEventListener('click', (ev) => {
          if (ev.target.classList.contains('modal-overlay')) done(false);
        });
      },
    });
  });
}

/* ------------------------------ 路由 ------------------------------ */

const NAV = {
  admin: [
    { href: '#/overview', icon: '📊', label: '数据概览' },
    { href: '#/manage', icon: '📚', label: '作业管理' },
    { href: '#/reviews', icon: '✅', label: '提交审批', badge: 'pending' },
    { href: '#/classes', icon: '🏫', label: '班级管理' },
    { href: '#/users', icon: '👥', label: '账号管理' },
    { href: '#/settings', icon: '⚙️', label: '系统设置' },
  ],
  teacher: [
    { href: '#/overview', icon: '📊', label: '数据概览' },
    { href: '#/manage', icon: '📚', label: '我的作业' },
    { href: '#/reviews', icon: '✅', label: '提交审批', badge: 'pending' },
  ],
  student: [
    { href: '#/home', icon: '📋', label: '我的作业' },
    { href: '#/scores', icon: '🏅', label: '我的成绩' },
  ],
};

const TITLES = {
  '/home': ['我的作业', '查看作业要求并在线提交答案'],
  '/scores': ['我的成绩', '查看提交记录与老师批阅结果'],
  '/assignment': ['作业详情', ''],
  '/overview': ['数据概览', '平台整体运行情况'],
  '/manage': ['作业管理', '发布、编辑与删除作业'],
  '/reviews': ['提交审批', '批阅学生提交的作业'],
  '/classes': ['班级管理', '创建班级并安排学生'],
  '/users': ['账号管理', '管理管理员、老师与学生账号'],
  '/settings': ['系统设置', '站点信息与注册开关'],
};

const STAFF_ROUTES = ['overview', 'manage', 'reviews'];
const ADMIN_ROUTES = ['classes', 'users', 'settings'];
const STUDENT_ROUTES = ['home', 'scores', 'assignment'];

function parseRoute() {
  const raw = (location.hash || '').replace(/^#/, '');
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const query = new URLSearchParams(qs || '');
  return { name: parts[0] || '', id: parts[1] || '', query };
}

const defaultHash = () => (isStaff() ? '#/overview' : '#/home');

/* ------------------------------ 登录页 ------------------------------ */

function renderAuthPage() {
  const isLogin = state.authTab === 'login';
  const site = state.settings.siteName || '云作业';
  const canRegister = state.settings.registerEnabled !== false;
  const tabsHtml = canRegister
    ? `<div class="auth-tabs">
         <button class="${isLogin ? 'active' : ''}" data-act="auth-tab" data-tab="login">登录</button>
         <button class="${isLogin ? '' : 'active'}" data-act="auth-tab" data-tab="register">注册</button>
       </div>`
    : `<div class="auth-tabs"><button class="active">登录</button></div>`;

  $('#app').innerHTML = `
    <div class="auth-wrap">
      <aside class="auth-hero">
        <div>
          <h1>${esc(site)} · 在线作业平台</h1>
          <p class="hero-sub" style="margin-top:10px">老师发布题目，学生在线提交，批阅结果实时反馈 —— 一个页面搞定整个作业闭环。</p>
        </div>
        <div class="hero-list">
          <div class="hero-item">
            <span class="hi-icon">📚</span>
            <div><strong>按班级发布作业</strong><span>设定题目、截止时间、满分与目标班级</span></div>
          </div>
          <div class="hero-item">
            <span class="hi-icon">📤</span>
            <div><strong>学生在线提交</strong><span>文字作答 + 上传 Word / PDF / 图片附件</span></div>
          </div>
          <div class="hero-item">
            <span class="hi-icon">✅</span>
            <div><strong>在线审批打分</strong><span>通过 / 驳回、给分、写评语，一键完成</span></div>
          </div>
        </div>
      </aside>

      <main class="auth-panel">
        <div class="auth-card">
          <h2>${isLogin ? '欢迎回来' : '注册学生账号'}</h2>
          <p class="auth-hint">${
            isLogin
              ? '请使用管理员、老师或学生账号登录'
              : esc(state.settings.registerNote || '注册后即可查看并提交作业')
          }</p>

          ${tabsHtml}

          ${
            isLogin
              ? `<form data-form="login" autocomplete="on">
                  <div class="field">
                    <label for="login-username">用户名</label>
                    <input class="input" id="login-username" name="username" placeholder="请输入用户名" autocomplete="username" required />
                  </div>
                  <div class="field">
                    <label for="login-password">密码</label>
                    <input class="input" id="login-password" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" required />
                  </div>
                  <button class="btn btn-primary btn-block" type="submit" style="margin-top:6px">登 录</button>
                </form>`
              : `<form data-form="register" autocomplete="on">
                  <div class="field">
                    <label for="reg-username">用户名</label>
                    <input class="input" id="reg-username" name="username" placeholder="字母 / 数字，3-32 位" autocomplete="username" required />
                  </div>
                  <div class="field">
                    <label for="reg-name">姓名</label>
                    <input class="input" id="reg-name" name="name" placeholder="用于老师识别，如：张三" required />
                  </div>
                  <div class="field">
                    <label for="reg-password">密码</label>
                    <input class="input" id="reg-password" name="password" type="password" placeholder="至少 6 位" autocomplete="new-password" required />
                  </div>
                  <button class="btn btn-primary btn-block" type="submit" style="margin-top:6px">注册并登录</button>
                </form>`
          }

          <div class="demo-box">
            账号由老师统一发放；忘记密码请联系老师或管理员重置。
          </div>
        </div>
      </main>
    </div>`;
}

/* ------------------------------ 应用外壳 ------------------------------ */

const roleKey = () => (isAdmin() ? 'admin' : state.user?.role === 'teacher' ? 'teacher' : 'student');

function renderShell(route) {
  const user = state.user;
  const key = roleKey();
  const navItems = NAV[key];
  const current = `#/${route.name}`;
  const pendingCount = state.stats?.stats?.pending || 0;
  const [title, subtitle] = TITLES[`/${route.name}`] || [state.settings.siteName || '云作业', ''];

  const roleText = user.roleText || (key === 'admin' ? '管理员' : key === 'teacher' ? '老师' : '学生');
  const classText = user.classNames && user.classNames.length ? user.classNames.join('、') : '';

  $('#app').innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo">作</div>
          <div class="brand-text">
            <strong>${esc(state.settings.siteName || '云作业')}</strong>
            <span>ONLINE HOMEWORK</span>
          </div>
        </div>
        <nav class="nav">
          <div class="nav-group-title">${key === 'student' ? '学习空间' : '管理后台'}</div>
          ${navItems
            .map(
              (item) => `
            <a class="nav-item ${current === item.href ? 'active' : ''}" href="${item.href}">
              <span class="ni-icon">${item.icon}</span>
              <span>${item.label}</span>
              ${
                item.badge === 'pending' && pendingCount > 0
                  ? `<span class="nav-badge" data-role="pending-badge">${pendingCount}</span>`
                  : ''
              }
            </a>`,
            )
            .join('')}
          <button class="nav-item" data-act="open-password" style="border:0;background:transparent;text-align:left;cursor:pointer;width:100%">
            <span class="ni-icon">🔒</span><span>修改密码</span>
          </button>
        </nav>
        <div class="sidebar-user">
          <div class="avatar">${esc((user.name || user.username).slice(0, 1))}</div>
          <div class="su-meta">
            <div class="su-name">${esc(user.name)}</div>
            <div class="su-role">${esc(roleText)}${classText ? ` · ${esc(classText)}` : ''}</div>
          </div>
          <button class="icon-btn" title="退出登录" data-act="logout">⏻</button>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <div>
            <h1>${esc(title)}</h1>
            ${subtitle ? `<div class="tb-sub">${esc(subtitle)}</div>` : ''}
          </div>
          <div class="topbar-right">
            <span class="role-chip ${key === 'student' ? '' : 'admin'}">${esc(roleText)}</span>
          </div>
        </header>
        <main class="content-area" id="content">
          <div class="boot-splash" style="min-height:200px"><div class="boot-spinner"></div></div>
        </main>
      </div>
    </div>`;
}

function updateNavBadge() {
  const pending = state.stats?.stats?.pending || 0;
  const badgeEl = $('[data-role="pending-badge"]');
  if (badgeEl) {
    if (pending > 0) badgeEl.textContent = String(pending);
    else badgeEl.remove();
  } else if (pending > 0) {
    const link = $('a.nav-item[href="#/reviews"]');
    if (link) {
      const el = document.createElement('span');
      el.className = 'nav-badge';
      el.dataset.role = 'pending-badge';
      el.textContent = String(pending);
      link.appendChild(el);
    }
  }
}

/* ------------------------------ 主渲染 ------------------------------ */

async function render() {
  const route = parseRoute();

  if (!state.user) {
    renderAuthPage();
    return;
  }

  if (!route.name || route.name === 'login') {
    location.hash = defaultHash();
    return;
  }

  const key = roleKey();
  if (key === 'student' && (STAFF_ROUTES.includes(route.name) || ADMIN_ROUTES.includes(route.name))) {
    location.hash = '#/home';
    return;
  }
  if (key === 'teacher' && (ADMIN_ROUTES.includes(route.name) || STUDENT_ROUTES.includes(route.name))) {
    location.hash = '#/overview';
    return;
  }
  if (key === 'admin' && STUDENT_ROUTES.includes(route.name)) {
    location.hash = '#/overview';
    return;
  }

  renderShell(route);

  try {
    state.stats = await api('/stats');
  } catch {
    state.stats = null;
  }
  updateNavBadge();

  const content = $('#content');
  try {
    const html = await buildView(route);
    if (content) content.innerHTML = html;
    afterRender(route);
  } catch (err) {
    if (content) {
      content.innerHTML = `
        <div class="card card-pad">
          <div class="empty">
            <div class="empty-icon">⚠️</div>
            <h4>加载失败</h4>
            <p>${esc(err.message)}</p>
            <button class="btn btn-ghost btn-sm" style="margin-top:14px" data-act="reload">重新加载</button>
          </div>
        </div>`;
    }
  }
}

function afterRender(route) {
  if (route.name === 'assignment') state.uploads.submission = [];
  if (route.name === 'reviews' && route.query.get('assignment')) {
    state.reviewAssignment = route.query.get('assignment');
  }
  bindFileInputs();
}

function buildView(route) {
  switch (route.name) {
    case 'home':
      return viewStudentHome();
    case 'scores':
      return viewStudentScores();
    case 'assignment':
      return viewAssignmentDetail(route.id);
    case 'overview':
      return viewOverview();
    case 'manage':
      return viewManage();
    case 'reviews':
      return viewReviews();
    case 'classes':
      return viewClasses();
    case 'users':
      return viewUsers();
    case 'settings':
      return viewSettings();
    default:
      return Promise.resolve(`<div class="card card-pad"><div class="empty"><h4>页面不存在</h4></div></div>`);
  }
}

/* ============================ 学生端视图 ============================ */

async function viewStudentHome() {
  const { assignments } = await api('/assignments');
  const stats = state.stats?.stats || {};
  const filter = state.homeFilter;

  const filtered = assignments.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'todo') return studentState(a) === 'todo';
    return studentState(a) === filter;
  });

  const tabs = [
    ['all', '全部', assignments.length],
    ['todo', '待完成', assignments.filter((a) => studentState(a) === 'todo').length],
    ['pending', '待审批', assignments.filter((a) => studentState(a) === 'pending').length],
    ['approved', '已通过', assignments.filter((a) => studentState(a) === 'approved').length],
    ['rejected', '已驳回', assignments.filter((a) => studentState(a) === 'rejected').length],
  ];

  const listHtml = filtered.length
    ? filtered
        .map((a) => {
          const st = studentState(a);
          const dl = deadlineInfo(a);
          const score =
            a.mySubmission && a.mySubmission.status === 'approved' && a.mySubmission.score != null
              ? `<span class="hm-item">得分 <strong class="text-ok">${a.mySubmission.score}</strong> / ${a.maxScore}</span>`
              : '';
          return `
            <a class="hw-card" href="#/assignment/${a.id}">
              <div class="hw-top">
                <h3>${esc(a.title)}</h3>
                ${badge(st)}
              </div>
              <div class="hw-excerpt">${esc(excerpt(a.content, 90)) || '（无文字说明，请查看附件）'}</div>
              <div class="hw-meta">
                <span class="hm-item ${dl.cls}">⏰ ${esc(dl.text)}</span>
                <span class="hm-item">满分 ${a.maxScore}</span>
                ${score}
              </div>
            </a>`;
        })
        .join('')
    : `<div class="card"><div class="empty">
         <div class="empty-icon">📭</div>
         <h4>暂无作业</h4>
         <p>${assignments.length ? '当前筛选条件下没有作业' : '老师还没有给你所在班级发布作业'}</p>
       </div></div>`;

  return `
    <div class="stat-grid">
      <div class="stat-card accent">
        <div class="sc-label">待完成作业</div>
        <div class="sc-value">${stats.todo ?? 0}</div>
        <div class="sc-foot">尽快完成，别错过截止时间</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">待审批</div>
        <div class="sc-value">${stats.pending ?? 0}</div>
        <div class="sc-foot">已提交、等待老师批阅</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">已通过</div>
        <div class="sc-value text-ok">${stats.approved ?? 0}</div>
        <div class="sc-foot">老师已批阅通过</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">平均得分</div>
        <div class="sc-value">${stats.averageScore ?? '—'}</div>
        <div class="sc-foot">已批阅作业的平均分</div>
      </div>
    </div>

    <div class="page-head">
      <div>
        <h2>作业列表</h2>
        <div class="ph-sub">共 ${assignments.length} 份作业${
          state.user.classNames && state.user.classNames.length
            ? ` · 你的班级：${esc(state.user.classNames.join('、'))}`
            : ' · 尚未分班（只显示面向全体的作业）'
        }</div>
      </div>
      <div class="filter-tabs">
        ${tabs
          .map(
            ([key, label, count]) =>
              `<button class="${filter === key ? 'active' : ''}" data-act="home-filter" data-filter="${key}">${label}<span class="count">${count}</span></button>`,
          )
          .join('')}
      </div>
    </div>
    <div class="grid grid-cards">${listHtml}</div>`;
}

async function viewStudentScores() {
  const { submissions } = await api('/submissions/mine');
  if (!submissions.length) {
    return `<div class="card"><div class="empty">
      <div class="empty-icon">🏅</div>
      <h4>还没有提交记录</h4>
      <p>完成作业并提交后，老师批阅结果会显示在这里</p>
      <a class="btn btn-primary btn-sm" style="margin-top:14px" href="#/home">去完成作业</a>
    </div></div>`;
  }

  const rows = submissions
    .map(
      (s) => `
      <tr>
        <td>
          <div class="cell-title">${esc(s.assignment?.title || '—')}</div>
          <div class="cell-sub">第 ${s.revision} 次提交</div>
        </td>
        <td>${fmtDate(s.submittedAt)}</td>
        <td>${badge(s.status)}</td>
        <td>${
          s.score == null
            ? '<span style="color:var(--muted)">—</span>'
            : `<strong>${s.score}</strong> <span class="cell-sub">/ ${s.assignment?.maxScore ?? '-'}</span>`
        }</td>
        <td>${s.feedback ? esc(excerpt(s.feedback, 30)) : '<span style="color:var(--muted)">—</span>'}</td>
        <td class="actions">
          <a class="btn btn-ghost btn-sm" href="#/assignment/${s.assignmentId}">查看详情</a>
        </td>
      </tr>`,
    )
    .join('');

  return `
    <div class="page-head">
      <div><h2>提交记录</h2><div class="ph-sub">共 ${submissions.length} 条记录</div></div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>作业</th><th>提交时间</th><th>状态</th><th>分数</th><th>老师评语</th><th>操作</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function viewAssignmentDetail(id) {
  if (!id) throw new Error('作业不存在');
  const { assignment: a } = await api(`/assignments/${id}`);
  const st = studentState(a);
  const dl = deadlineInfo(a);
  const mine = a.mySubmission;

  const filesHtml = (files) =>
    files && files.length
      ? `<div class="file-list">${files
          .map(
            (f) => `
          <div class="file-item">
            <span class="fi-icon">📎</span>
            <a class="fi-name" href="/api/files/${f.id}/download" target="_blank" rel="noopener">${esc(f.name)}</a>
            <span class="fi-size">${fmtSize(f.size)}</span>
            <a class="btn btn-ghost btn-sm" href="/api/files/${f.id}/download">下载</a>
          </div>`,
          )
          .join('')}</div>`
      : '';

  const questionCard = `
    <div class="card">
      <div class="card-head">
        <h3>${esc(a.title)}</h3>
        ${badge(st)}
      </div>
      <div class="card-pad">
        <div class="prose">${esc(a.content)}</div>
        ${a.files.length ? `<div class="divider"></div><h4 style="font-size:13.5px;margin-bottom:10px">题目附件</h4>${filesHtml(a.files)}` : ''}
      </div>
    </div>`;

  const infoCard = `
    <div class="card card-pad">
      <div class="kv">
        <div class="kv-row"><span class="k">截止时间</span><span class="v ${dl.cls === 'text-danger' ? 'text-danger' : ''}">${a.deadline ? fmtDate(a.deadline) : '不限'}</span></div>
        <div class="kv-row"><span class="k">剩余时间</span><span class="v ${dl.cls}">${esc(dl.text)}</span></div>
        <div class="kv-row"><span class="k">满分</span><span class="v">${a.maxScore} 分</span></div>
        <div class="kv-row"><span class="k">发布老师</span><span class="v">${esc(a.creatorName || '—')}</span></div>
        <div class="kv-row"><span class="k">面向班级</span><span class="v">${a.classNames && a.classNames.length ? esc(a.classNames.join('、')) : '全部学生'}</span></div>
        <div class="kv-row"><span class="k">发布时间</span><span class="v">${fmtDate(a.createdAt)}</span></div>
        <div class="kv-row"><span class="k">逾期提交</span><span class="v">${a.allowLate ? '允许' : '不允许'}</span></div>
      </div>
    </div>`;

  let resultCard = '';
  if (mine) {
    const meta = {
      pending: { cls: 'pending', title: '等待老师批阅', desc: '已成功提交，老师批阅后会在这里显示结果。' },
      approved: { cls: 'approved', title: '批阅通过', desc: '老师已确认本次作业通过。' },
      rejected: { cls: 'rejected', title: '本次提交被驳回', desc: '请查看老师评语后重新提交。' },
    }[mine.status];

    resultCard = `
      <div class="review-result ${meta.cls}" style="margin-top:16px">
        <div class="rr-head">
          <strong>${meta.title}</strong>
          ${mine.score != null ? `<span class="rr-score">${mine.score}<small> / ${a.maxScore}</small></span>` : ''}
        </div>
        <div style="color:var(--text-2)">${meta.desc}</div>
        ${
          mine.feedback
            ? `<div class="divider" style="margin:10px 0"></div><div style="white-space:pre-wrap">${esc(mine.feedback)}</div>`
            : ''
        }
        ${
          mine.reviewerName
            ? `<div class="hint" style="margin-top:8px">批阅人：${esc(mine.reviewerName)} · ${fmtDate(mine.reviewedAt)}</div>`
            : ''
        }
      </div>`;
  }

  const canEdit = !mine || ['pending', 'rejected'].includes(mine.status);
  const canSubmitNow = a.canSubmit !== false;

  const submittedPreview = mine
    ? `<div class="divider"></div>
       <h4 style="font-size:13.5px;margin-bottom:10px">我的作答（第 ${mine.revision} 次提交 · ${fmtDate(mine.submittedAt)}）</h4>
       <div class="prose" style="font-size:13.5px">${esc(mine.content) || '<span style="color:var(--muted)">（未填写文字答案）</span>'}</div>
       ${mine.files.length ? `<div style="margin-top:12px">${filesHtml(mine.files)}</div>` : ''}`
    : '';

  const formHtml =
    canEdit && canSubmitNow
      ? `
      <div class="divider"></div>
      <h4 style="font-size:13.5px;margin-bottom:10px">${mine ? '重新提交作业' : '提交作业'}</h4>
      <form data-form="submit-assignment" data-id="${a.id}">
        <div class="field">
          <textarea class="textarea" id="answer-content" placeholder="在这里输入你的答案…" style="min-height:150px">${esc(mine?.content || '')}</textarea>
        </div>
        <div class="upload-zone" id="upload-zone" data-kind="submission">
          📎 点击上传附件（图片 / PDF / Word / 压缩包，单个不超过 20MB）
          <input type="file" id="file-input" multiple hidden />
        </div>
        <div class="chips" id="chips-submission"></div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary" type="submit">${mine ? '重新提交' : '提交作业'}</button>
          ${
            mine
              ? `<button class="btn btn-ghost" type="button" data-act="withdraw" data-id="${mine.id}">撤回提交</button>`
              : ''
          }
        </div>
        <div class="hint">提交后状态会变为「待审批」，老师批阅前可以重新提交或撤回。</div>
      </form>`
      : !canSubmitNow
        ? `<div class="review-result rejected" style="margin-top:16px">该作业已过截止时间且不允许逾期提交，无法再提交答案。如需补交请联系老师。</div>`
        : mine && mine.status === 'approved'
          ? `<div class="hint" style="margin-top:16px">该作业已通过审批，如需修改请联系老师。</div>`
          : '';

  return `
    <div class="page-head">
      <div style="display:flex;align-items:center;gap:10px">
        <a class="btn btn-ghost btn-sm" href="#/home">← 返回列表</a>
        <div class="ph-sub">作业详情</div>
      </div>
    </div>
    <div class="detail-grid">
      <div>
        ${questionCard}
        <div class="card card-pad" style="margin-top:16px">
          ${submittedPreview}
          ${resultCard}
          ${formHtml}
        </div>
      </div>
      <div>${infoCard}</div>
    </div>`;
}

/* ============================ 老师 / 管理员视图 ============================ */

async function viewOverview() {
  const data = state.stats || (await api('/stats'));
  const s = data.stats || {};
  const recent = data.recent || [];
  const admin = isAdmin();

  const rows = recent.length
    ? recent
        .map(
          (r) => `
        <tr>
          <td>
            <div class="cell-title">${esc(r.student?.name || '—')}</div>
            <div class="cell-sub">${esc(r.student?.username || '')}</div>
          </td>
          <td>${esc(r.assignment?.title || '—')}</td>
          <td>${fmtDate(r.submittedAt)}</td>
          <td>${badge(r.status)}</td>
          <td class="actions">
            <button class="btn btn-ghost btn-sm" data-act="review" data-id="${r.id}">批阅</button>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><div class="empty" style="padding:34px"><h4>还没有学生提交作业</h4><p>发布作业后，学生的提交会出现在这里</p></div></td></tr>`;

  return `
    <div class="stat-grid">
      <div class="stat-card warn">
        <div class="sc-label">待审批提交</div>
        <div class="sc-value">${s.pending ?? 0}</div>
        <div class="sc-foot">点击左侧「提交审批」开始批阅</div>
      </div>
      <div class="stat-card accent">
        <div class="sc-label">${admin ? '作业总数' : '我的作业'}</div>
        <div class="sc-value">${s.assignmentCount ?? 0}</div>
        <div class="sc-foot">其中已发布 ${s.publishedCount ?? 0} 份</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">${admin ? '学生人数' : '提交学生数'}</div>
        <div class="sc-value">${s.studentCount ?? 0}</div>
        <div class="sc-foot">${admin ? '已开通的学生账号' : '为你提交过作业的学生'}</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">提交总数</div>
        <div class="sc-value">${s.submissionCount ?? 0}</div>
        <div class="sc-foot">通过 ${s.approved ?? 0} · 驳回 ${s.rejected ?? 0}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>最近提交</h3>
        <a class="btn btn-ghost btn-sm" href="#/reviews">查看全部</a>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>学生</th><th>作业</th><th>提交时间</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function viewManage() {
  const { assignments } = await api('/assignments');
  const filter = state.manageFilter;
  const admin = isAdmin();
  const list = assignments.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'published') return a.published;
    return !a.published;
  });

  const rows = list.length
    ? list
        .map(
          (a) => `
      <tr>
        <td>
          <div class="cell-title">${esc(a.title)}</div>
          <div class="cell-sub">${esc(excerpt(a.content, 40)) || '（无文字说明）'}</div>
        </td>
        ${admin ? `<td class="cell-sub nowrap">${esc(a.creatorName || '—')}</td>` : ''}
        <td class="cell-sub">${a.classNames && a.classNames.length ? esc(a.classNames.join('、')) : '<span class="badge todo">全部学生</span>'}</td>
        <td>${a.published ? '<span class="badge approved">已发布</span>' : '<span class="badge draft">草稿</span>'}</td>
        <td>${a.deadline ? fmtDate(a.deadline) : '<span class="cell-sub">不限</span>'}</td>
        <td>
          <div class="cell-title">${a.stats.submissionCount}</div>
          <div class="cell-sub nowrap">待批 ${a.stats.pendingCount}</div>
        </td>
        <td class="actions">
          <button class="btn btn-ghost btn-sm" data-act="edit-assignment" data-id="${a.id}">编辑</button>
          <a class="btn btn-ghost btn-sm" href="#/reviews?assignment=${a.id}">提交</a>
          <button class="btn btn-ghost btn-sm" data-act="toggle-publish" data-id="${a.id}">${a.published ? '撤回' : '发布'}</button>
          <button class="btn btn-danger btn-sm" data-act="delete-assignment" data-id="${a.id}">删除</button>
        </td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="${admin ? 7 : 6}"><div class="empty" style="padding:44px">
        <div class="empty-icon">📚</div>
        <h4>还没有作业</h4>
        <p>点击右上角「发布作业」创建第一份作业</p>
      </div></td></tr>`;

  return `
    <div class="page-head">
      <div><h2>作业列表</h2><div class="ph-sub">共 ${assignments.length} 份作业</div></div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div class="filter-tabs">
          <button class="${filter === 'all' ? 'active' : ''}" data-act="manage-filter" data-filter="all">全部</button>
          <button class="${filter === 'published' ? 'active' : ''}" data-act="manage-filter" data-filter="published">已发布</button>
          <button class="${filter === 'draft' ? 'active' : ''}" data-act="manage-filter" data-filter="draft">草稿</button>
        </div>
        <button class="btn btn-primary" data-act="new-assignment">+ 发布作业</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>作业标题</th>
              ${admin ? '<th>发布人</th>' : ''}
              <th>面向班级</th><th>状态</th><th>截止时间</th><th>提交情况</th><th>操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function viewReviews() {
  const params = new URLSearchParams({ status: state.reviewStatus, size: '100' });
  if (state.reviewKeyword) params.set('q', state.reviewKeyword);
  if (state.reviewAssignment) params.set('assignmentId', state.reviewAssignment);
  const data = await api(`/submissions?${params.toString()}`);
  const counts = data.counts || {};

  const tabs = [
    ['pending', '待审批', counts.pending],
    ['approved', '已通过', counts.approved],
    ['rejected', '已驳回', counts.rejected],
    ['all', '全部', counts.all],
  ];

  const rows = data.submissions.length
    ? data.submissions
        .map(
          (r) => `
        <tr>
          <td>
            <div class="cell-title">${esc(r.student?.name || '—')}</div>
            <div class="cell-sub">${esc(r.student?.username || '')}</div>
          </td>
          <td>${esc(r.assignment?.title || '—')}</td>
          <td>${fmtDate(r.submittedAt)}</td>
          <td>${r.content ? esc(excerpt(r.content, 34)) : `<span class="cell-sub">仅附件（${r.files.length} 个）</span>`}</td>
          <td>${badge(r.status)}</td>
          <td>${r.score == null ? '<span class="cell-sub">—</span>' : `<strong>${r.score}</strong>`}</td>
          <td class="actions">
            <button class="btn ${r.status === 'pending' ? 'btn-primary' : 'btn-ghost'} btn-sm" data-act="review" data-id="${r.id}">
              ${r.status === 'pending' ? '批阅' : '查看 / 改评'}
            </button>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty" style="padding:44px">
        <div class="empty-icon">✅</div>
        <h4>${state.reviewStatus === 'pending' ? '没有待审批的提交' : '没有记录'}</h4>
        <p>${state.reviewStatus === 'pending' ? '全部批阅完成，辛苦了！' : '换个筛选条件试试'}</p>
      </div></td></tr>`;

  return `
    <div class="page-head">
      <div>
        <h2>提交审批</h2>
        <div class="ph-sub">
          共 ${data.total} 条记录
          ${state.reviewAssignment ? `　<span class="badge info">已按作业筛选</span>　<a href="#" data-act="clear-assignment-filter">清除筛选</a>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div class="filter-tabs">
          ${tabs
            .map(
              ([key, label, count]) =>
                `<button class="${state.reviewStatus === key ? 'active' : ''}" data-act="review-filter" data-status="${key}">${label}<span class="count">${count ?? 0}</span></button>`,
            )
            .join('')}
        </div>
        <input class="input" id="review-search" placeholder="搜索学生 / 作业" value="${esc(state.reviewKeyword)}" style="width:190px" />
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>学生</th><th>作业</th><th>提交时间</th><th>答案摘要</th><th>状态</th><th>分数</th><th>操作</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function viewClasses() {
  const { classes } = await api('/classes');
  state.classes = classes;

  const cards = classes.length
    ? classes
        .map(
          (c) => `
      <div class="card card-pad">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div>
            <h3 style="font-size:15.5px">${esc(c.name)}</h3>
            <div class="cell-sub">${esc(c.note || '暂无备注')}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" data-act="edit-class" data-id="${c.id}">编辑</button>
            <button class="btn btn-danger btn-sm" data-act="delete-class" data-id="${c.id}">删除</button>
          </div>
        </div>
        <div class="hw-meta" style="margin-top:14px">
          <span class="hm-item">👥 学生 ${c.memberCount} 人</span>
          <span class="hm-item">📚 作业 ${c.assignmentCount} 份</span>
        </div>
        ${
          c.members.length
            ? `<div class="chips" style="margin-top:12px">${c.members
                .map((m) => `<span class="chip"><span class="chip-name">${esc(m.name)}</span></span>`)
                .join('')}</div>`
            : `<div class="hint" style="margin-top:10px">还没有学生，去「账号管理」把学生分配到这个班级</div>`
        }
      </div>`,
        )
        .join('')
    : `<div class="card"><div class="empty">
        <div class="empty-icon">🏫</div>
        <h4>还没有班级</h4>
        <p>创建班级后，就可以把学生分班并按班级发布作业</p>
        <button class="btn btn-primary btn-sm" style="margin-top:14px" data-act="new-class">+ 新建班级</button>
      </div></div>`;

  return `
    <div class="page-head">
      <div><h2>班级列表</h2><div class="ph-sub">共 ${classes.length} 个班级 · 未分班的学生只能看到「面向全部学生」的作业</div></div>
      <button class="btn btn-primary" data-act="new-class">+ 新建班级</button>
    </div>
    <div class="grid grid-cards">${cards}</div>`;
}

async function viewUsers() {
  const { users } = await api('/users');
  const { classes } = await api('/classes');
  state.userCache = users;
  state.classes = classes;

  let list = users;
  if (state.userRole) list = list.filter((u) => u.role === state.userRole);
  if (state.userClassId) list = list.filter((u) => (u.classIds || []).includes(state.userClassId));

  const roleText = { admin: '管理员', teacher: '老师', student: '学生' };

  const rows = list.length
    ? list
        .map(
          (u) => `
      <tr>
        <td>
          <div class="cell-title">${esc(u.name)}</div>
          <div class="cell-sub">${esc(u.username)}</div>
        </td>
        <td>${u.role === 'admin' ? '<span class="badge info">管理员</span>' : u.role === 'teacher' ? '<span class="badge pending">老师</span>' : '<span class="badge todo">学生</span>'}</td>
        <td class="cell-sub">${
          u.role === 'student'
            ? u.classNames && u.classNames.length
              ? esc(u.classNames.join('、'))
              : '<span style="color:var(--muted)">未分班</span>'
            : '—'
        }</td>
        <td>${u.active ? '<span class="badge approved">正常</span>' : '<span class="badge rejected">已停用</span>'}</td>
        <td class="cell-sub">${
          u.role === 'student'
            ? `提交 ${u.stats.submitted} · 通过 ${u.stats.approved} · 待批 ${u.stats.pending}`
            : '—'
        }</td>
        <td class="actions">
          <button class="btn btn-ghost btn-sm" data-act="edit-user" data-id="${u.id}">编辑</button>
          <button class="btn btn-ghost btn-sm" data-act="toggle-user" data-id="${u.id}" data-active="${u.active ? '1' : '0'}">${u.active ? '停用' : '启用'}</button>
          <button class="btn btn-danger btn-sm" data-act="delete-user" data-id="${u.id}">删除</button>
        </td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty" style="padding:40px"><h4>没有匹配的账号</h4><p>换个筛选条件试试</p></div></td></tr>`;

  const roleTabs = [
    ['', '全部', users.length],
    ['admin', '管理员', users.filter((u) => u.role === 'admin').length],
    ['teacher', '老师', users.filter((u) => u.role === 'teacher').length],
    ['student', '学生', users.filter((u) => u.role === 'student').length],
  ];

  return `
    <div class="page-head">
      <div><h2>账号列表</h2><div class="ph-sub">共 ${list.length} 个账号（总计 ${users.length}）　　当前：${roleText[state.userRole] || '全部角色'}</div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-ghost" data-act="bulk-user">批量添加学生</button>
        <button class="btn btn-primary" data-act="new-user">+ 新增账号</button>
      </div>
    </div>

    <div class="page-head" style="margin-bottom:14px">
      <div class="filter-tabs">
        ${roleTabs
          .map(
            ([key, label, count]) =>
              `<button class="${state.userRole === key ? 'active' : ''}" data-act="user-role-filter" data-role="${key}">${label}<span class="count">${count}</span></button>`,
          )
          .join('')}
      </div>
      <select class="select" id="user-class-filter" style="max-width:220px">
        <option value="">全部班级</option>
        ${classes
          .map(
            (c) =>
              `<option value="${c.id}" ${state.userClassId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`,
          )
          .join('')}
      </select>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>姓名 / 用户名</th><th>角色</th><th>班级</th><th>状态</th><th>提交统计</th><th>操作</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

async function viewSettings() {
  const { settings } = await api('/settings');
  state.settings = { ...state.settings, ...settings };

  return `
    <div class="page-head">
      <div><h2>系统设置</h2><div class="ph-sub">路径 <code>/settings</code> · 仅管理员可见</div></div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr)">
      <div class="card">
        <div class="card-head"><h3>基本设置</h3></div>
        <div class="card-pad">
          <div class="field">
            <label for="set-site">站点名称</label>
            <input class="input" id="set-site" value="${esc(settings.siteName || '云作业')}" maxlength="30" />
            <div class="hint">显示在登录页与左侧导航顶部</div>
          </div>
          <div class="field">
            <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text)">
              <input type="checkbox" id="set-register" ${settings.registerEnabled !== false ? 'checked' : ''} />
              开放学生自助注册
            </label>
            <div class="hint">关闭后，登录页不再显示注册入口，学生账号只能由管理员创建</div>
          </div>
          <div class="field">
            <label for="set-register-note">注册页提示语</label>
            <input class="input" id="set-register-note" value="${esc(settings.registerNote || '')}" placeholder="例如：请使用学号注册，注册后联系老师分班" maxlength="200" />
          </div>
          <button class="btn btn-primary" data-act="save-settings">保存设置</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>数据备份</h3></div>
        <div class="card-pad">
          <p style="color:var(--text-2);font-size:13.5px;line-height:1.9">
            所有作业、提交与账号数据都保存在服务端的 <code>data/db.json</code>，
            附件保存在 <code>data/uploads/</code> 目录。建议定期下载备份。
          </p>
          <div class="btn-row" style="margin-top:14px">
            <a class="btn btn-ghost" href="/api/settings/backup">⬇ 下载数据备份（JSON）</a>
          </div>
        </div>
      </div>
    </div>`;
}

/* ============================ 弹窗业务逻辑 ============================ */

const classCheckboxes = (selected = [], name = 'cls') => {
  const classes = state.classes || [];
  if (!classes.length) {
    return `<div class="hint">还没有班级，作业将面向全部学生。<a href="#/classes">先去创建班级 →</a></div>`;
  }
  return `
    <div style="display:flex;flex-wrap:wrap;gap:8px 16px">
      ${classes
        .map(
          (c) => `
        <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;color:var(--text-2)">
          <input type="checkbox" data-cls="${esc(name)}" value="${c.id}" ${selected.includes(c.id) ? 'checked' : ''} />
          ${esc(c.name)}
        </label>`,
        )
        .join('')}
    </div>
    <div class="hint">都不勾选 = 面向全部学生</div>`;
};

const readClassChecks = (name = 'cls') =>
  Array.from(document.querySelectorAll(`input[data-cls="${name}"]:checked`)).map((el) => el.value);

async function loadClassesIfNeeded() {
  if (!state.classes.length) {
    try {
      const { classes } = await api('/classes');
      state.classes = classes;
    } catch {
      state.classes = [];
    }
  }
}

async function openAssignmentModal(id) {
  await loadClassesIfNeeded();
  let a = null;
  if (id) {
    const res = await api(`/assignments/${id}`);
    a = res.assignment;
  }
  state.editingAssignmentId = id || '';
  state.uploads.assignment = a ? a.files.map((f) => ({ ...f })) : [];

  openModal({
    title: id ? '编辑作业' : '发布作业',
    wide: true,
    body: `
      <form data-form="save-assignment">
        <div class="field">
          <label for="hw-title">作业标题 *</label>
          <input class="input" id="hw-title" value="${esc(a?.title || '')}" placeholder="例如：第 3 章 课后练习" required />
        </div>
        <div class="field">
          <label for="hw-content">题目内容 *</label>
          <textarea class="textarea" id="hw-content" placeholder="在这里粘贴题目要求，支持多行文本…" style="min-height:170px">${esc(a?.content || '')}</textarea>
          <div class="hint">学生端会按原样换行展示，可配合附件上传题目图片或文档。</div>
        </div>
        <div class="field">
          <label>面向班级</label>
          ${classCheckboxes(a?.classIds || [])}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div class="field">
            <label for="hw-deadline">截止时间</label>
            <input class="input" type="datetime-local" id="hw-deadline" value="${toLocalInput(a?.deadline)}" />
            <div class="hint">留空表示不限截止时间</div>
          </div>
          <div class="field">
            <label for="hw-maxscore">满分</label>
            <input class="input" type="number" id="hw-maxscore" min="1" max="1000" step="1" value="${a?.maxScore ?? 100}" />
          </div>
        </div>
        <div class="field">
          <label>题目附件</label>
          <div class="upload-zone" id="upload-zone" data-kind="assignment">
            📎 点击上传题目附件（图片 / PDF / Word，单个不超过 20MB）
            <input type="file" id="file-input" multiple hidden />
          </div>
          <div class="chips" id="chips-assignment"></div>
        </div>
        <div class="btn-row" style="gap:20px">
          <label style="display:flex;align-items:center;gap:7px;font-size:13.5px;color:var(--text-2)">
            <input type="checkbox" id="hw-allowlate" ${a?.allowLate === false ? '' : 'checked'} /> 允许逾期提交
          </label>
          <label style="display:flex;align-items:center;gap:7px;font-size:13.5px;color:var(--text-2)">
            <input type="checkbox" id="hw-published" ${a && a.published === false ? '' : 'checked'} /> 立即发布给学生
          </label>
        </div>
      </form>`,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-assignment">${id ? '保存修改' : '发布作业'}</button>`,
    onMount() {
      bindFileInputs();
      renderChips('assignment');
    },
  });
}

async function openReviewModal(id) {
  const { submission: s } = await api(`/submissions/${id}`);
  state.lastReviewId = id;
  const maxScore = s.assignment?.maxScore ?? 100;

  const filesHtml = s.files.length
    ? `<div class="file-list" style="margin-top:10px">${s.files
        .map(
          (f) => `
        <div class="file-item">
          <span class="fi-icon">📎</span>
          <a class="fi-name" href="/api/files/${f.id}/download" target="_blank" rel="noopener">${esc(f.name)}</a>
          <span class="fi-size">${fmtSize(f.size)}</span>
        </div>`,
        )
        .join('')}</div>`
    : '';

  openModal({
    title: `批阅 · ${s.student?.name || '学生'}`,
    wide: true,
    body: `
      <div class="kv" style="font-size:13.5px">
        <div class="kv-row"><span class="k">作业</span><span class="v">${esc(s.assignment?.title || '—')}</span></div>
        <div class="kv-row"><span class="k">学生</span><span class="v">${esc(s.student?.name || '—')}（${esc(s.student?.username || '')}）</span></div>
        <div class="kv-row"><span class="k">提交时间</span><span class="v">${fmtDate(s.submittedAt)}</span></div>
        <div class="kv-row"><span class="k">当前状态</span><span class="v">${badge(s.status)}</span></div>
      </div>
      <div class="divider"></div>
      <h4 style="font-size:13.5px;margin-bottom:8px">学生作答</h4>
      <div class="prose" style="font-size:13.5px;background:#fafbfe;border:1px solid var(--line);border-radius:10px;padding:14px;max-height:280px;overflow:auto">${esc(s.content) || '<span style="color:var(--muted)">（学生未填写文字答案，仅上传附件）</span>'}</div>
      ${filesHtml}
      <div class="divider"></div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px">
        <div class="field" style="margin:0">
          <label for="review-score">分数（满分 ${maxScore}）</label>
          <input class="input" type="number" id="review-score" min="0" max="${maxScore}" step="0.5" value="${s.score ?? ''}" placeholder="可留空" />
        </div>
        <div class="field" style="margin:0">
          <label for="review-feedback">评语</label>
          <input class="input" id="review-feedback" value="${esc(s.feedback || '')}" placeholder="给学生一些反馈（可留空）" />
        </div>
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-danger" data-act="do-review" data-action="reject">驳回</button>
      <button class="btn btn-success" data-act="do-review" data-action="approve">通过并保存</button>`,
  });
}

async function openUserModal(id) {
  if (!state.classes.length) await loadClassesIfNeeded();
  const u = id ? state.userCache.find((x) => x.id === id) : null;
  const isSelf = u && u.id === state.user.id;

  openModal({
    title: id ? '编辑账号' : '新增账号',
    body: `
      <div class="field">
        <label for="user-username">用户名 *</label>
        <input class="input" id="user-username" value="${esc(u?.username || '')}" ${id ? 'disabled' : ''} placeholder="登录用，字母/数字/学号，3-32 位" />
        ${id ? '<div class="hint">用户名不可修改</div>' : ''}
      </div>
      <div class="field">
        <label for="user-name">姓名 *</label>
        <input class="input" id="user-name" value="${esc(u?.name || '')}" placeholder="如：张三" />
      </div>
      <div class="field">
        <label for="user-password">${id ? '重置密码（留空则不修改）' : '密码 *'}</label>
        <input class="input" type="text" id="user-password" placeholder="至少 6 位" />
      </div>
      <div class="field">
        <label for="user-role">角色</label>
        <select class="select" id="user-role" ${isSelf ? 'disabled' : ''}>
          <option value="student" ${u?.role !== 'admin' && u?.role !== 'teacher' ? 'selected' : ''}>学生</option>
          <option value="teacher" ${u?.role === 'teacher' ? 'selected' : ''}>老师（可发布作业与审批）</option>
          <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>管理员（全部权限）</option>
        </select>
      </div>
      <div class="field" id="user-class-field" ${u && u.role !== 'student' ? 'style="display:none"' : ''}>
        <label>所属班级（学生专用）</label>
        ${
          state.classes.length
            ? `<div style="display:flex;flex-wrap:wrap;gap:8px 16px">
                ${state.classes
                  .map(
                    (c) => `
                  <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;color:var(--text-2)">
                    <input type="checkbox" data-cls="user" value="${c.id}" ${(u?.classIds || []).includes(c.id) ? 'checked' : ''} />
                    ${esc(c.name)}
                  </label>`,
                  )
                  .join('')}
              </div>`
            : `<div class="hint">还没有班级，<a href="#/classes">先去创建班级 →</a></div>`
        }
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-user" data-id="${id || ''}">保存</button>`,
    onMount() {
      const sel = $('#user-role');
      if (sel) {
        sel.addEventListener('change', () => {
          const field = $('#user-class-field');
          if (field) field.style.display = sel.value === 'student' ? '' : 'none';
        });
      }
    },
  });
}

function openBulkUserModal() {
  openModal({
    title: '批量添加学生',
    body: `
      <div class="field">
        <label for="bulk-text">学生名单（每行一个）*</label>
        <textarea class="textarea" id="bulk-text" style="min-height:170px" placeholder="学号,姓名&#10;2024001,张三&#10;2024002,李四"></textarea>
        <div class="hint">支持「学号,姓名」格式（英文/中文逗号或制表符分隔）。只写用户名时，姓名默认为用户名。</div>
      </div>
      <div class="field">
        <label for="bulk-password">统一初始密码</label>
        <input class="input" id="bulk-password" value="123456" />
      </div>
      <div class="field">
        <label>分配班级</label>
        ${
          state.classes.length
            ? `<div style="display:flex;flex-wrap:wrap;gap:8px 16px">
                ${state.classes
                  .map(
                    (c) => `
                  <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;color:var(--text-2)">
                    <input type="checkbox" data-cls="bulk" value="${c.id}" />
                    ${esc(c.name)}
                  </label>`,
                  )
                  .join('')}
              </div>`
            : `<div class="hint">还没有班级，可稍后到「账号管理」逐个分班</div>`
        }
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="do-bulk-user">开始导入</button>`,
  });
}

function openClassModal(id) {
  const c = id ? state.classes.find((x) => x.id === id) : null;
  openModal({
    title: id ? '编辑班级' : '新建班级',
    body: `
      <div class="field">
        <label for="class-name">班级名称 *</label>
        <input class="input" id="class-name" value="${esc(c?.name || '')}" placeholder="例如：高一(1)班" />
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="class-note">备注</label>
        <input class="input" id="class-note" value="${esc(c?.note || '')}" placeholder="例如：2024 级 数学 A 班" />
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-class" data-id="${id || ''}">保存</button>`,
  });
}

function openPasswordModal() {
  openModal({
    title: '修改密码',
    body: `
      <div class="field">
        <label for="pw-old">当前密码</label>
        <input class="input" type="password" id="pw-old" autocomplete="current-password" />
      </div>
      <div class="field">
        <label for="pw-new">新密码</label>
        <input class="input" type="password" id="pw-new" autocomplete="new-password" placeholder="至少 6 位" />
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="pw-confirm">确认新密码</label>
        <input class="input" type="password" id="pw-confirm" autocomplete="new-password" />
      </div>`,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-password">确认修改</button>`,
  });
}

/* ------------------------------ 文件上传 ------------------------------ */

function renderChips(kind) {
  const host = $(`#chips-${kind}`);
  if (!host) return;
  const files = state.uploads[kind] || [];
  host.innerHTML = files
    .map(
      (f) => `
      <span class="chip">
        <span class="chip-name" title="${esc(f.name)}">${esc(f.name)}</span>
        <button type="button" class="chip-x" data-act="remove-file" data-kind="${kind}" data-id="${f.id}">×</button>
      </span>`,
    )
    .join('');
}

function bindFileInputs() {
  const zone = $('#upload-zone');
  const input = $('#file-input');
  if (!zone || !input || zone.dataset.bound === '1') return;
  zone.dataset.bound = '1';

  const kind = zone.dataset.kind === 'assignment' ? 'assignment' : 'submission';
  zone.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await api('/files', { method: 'POST', body: fd });
        state.uploads[kind].push(res.file);
        renderChips(kind);
        toast(`已上传 ${res.file.name}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change'));
    }
  });
}

/* ------------------------------ 事件处理 ------------------------------ */

document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-act]');
  if (!target) return;
  const act = target.dataset.act;

  if (act === 'modal-inner') return;
  if (act === 'close-modal') {
    closeModal();
    return;
  }
  if (act.startsWith('confirm-')) return; // 由 askConfirm 内部处理

  try {
    switch (act) {
      case 'auth-tab':
        state.authTab = target.dataset.tab;
        renderAuthPage();
        break;

      case 'logout':
        await api('/auth/logout', { method: 'POST' });
        state.user = null;
        state.stats = null;
        location.hash = '#/login';
        renderAuthPage();
        toast('已退出登录');
        break;

      case 'reload':
        render();
        break;

      case 'home-filter':
        state.homeFilter = target.dataset.filter;
        render();
        break;

      case 'manage-filter':
        state.manageFilter = target.dataset.filter;
        render();
        break;

      case 'review-filter':
        state.reviewStatus = target.dataset.status;
        render();
        break;

      case 'clear-assignment-filter':
        state.reviewAssignment = '';
        render();
        break;

      case 'user-role-filter':
        state.userRole = target.dataset.role;
        render();
        break;

      case 'open-password':
        openPasswordModal();
        break;

      case 'save-password': {
        const oldPassword = $('#pw-old').value;
        const newPassword = $('#pw-new').value;
        const confirm = $('#pw-confirm').value;
        if (newPassword !== confirm) throw new Error('两次输入的新密码不一致');
        await api('/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } });
        closeModal();
        toast('密码修改成功', 'success');
        break;
      }

      case 'new-assignment':
        await openAssignmentModal();
        break;

      case 'edit-assignment':
        await openAssignmentModal(target.dataset.id);
        break;

      case 'save-assignment': {
        const payload = {
          title: $('#hw-title').value,
          content: $('#hw-content').value,
          deadline: $('#hw-deadline').value || null,
          maxScore: Number($('#hw-maxscore').value || 100),
          allowLate: $('#hw-allowlate').checked,
          published: $('#hw-published').checked,
          classIds: readClassChecks('cls'),
          files: state.uploads.assignment.map((f) => f.id),
        };
        const realId = state.editingAssignmentId || '';
        target.disabled = true;
        if (realId) await api(`/assignments/${realId}`, { method: 'PATCH', body: payload });
        else await api('/assignments', { method: 'POST', body: payload });
        closeModal();
        toast(realId ? '作业已更新' : '作业已发布', 'success');
        state.editingAssignmentId = '';
        render();
        break;
      }

      case 'toggle-publish': {
        const { assignment } = await api(`/assignments/${target.dataset.id}`);
        await api(`/assignments/${assignment.id}`, {
          method: 'PATCH',
          body: { published: !assignment.published },
        });
        toast(assignment.published ? '已撤回为草稿' : '已发布给学生', 'success');
        render();
        break;
      }

      case 'delete-assignment': {
        const ok = await askConfirm({
          title: '删除作业',
          message: '删除后该作业及其所有学生提交记录将无法恢复，确定继续吗？',
          confirmText: '删除',
        });
        if (!ok) return;
        await api(`/assignments/${target.dataset.id}`, { method: 'DELETE' });
        toast('作业已删除', 'success');
        render();
        break;
      }

      case 'review':
        await openReviewModal(target.dataset.id);
        break;

      case 'do-review': {
        const score = $('#review-score').value;
        const feedback = $('#review-feedback').value;
        const action = target.dataset.action;
        target.disabled = true;
        await api(`/submissions/${state.lastReviewId}/review`, {
          method: 'POST',
          body: { action, score: score === '' ? null : Number(score), feedback },
        });
        closeModal();
        toast(action === 'approve' ? '已通过并保存' : '已驳回', 'success');
        render();
        break;
      }

      case 'withdraw': {
        const ok = await askConfirm({
          title: '撤回提交',
          message: '撤回后本次作答内容将被删除，需要重新填写。确定撤回吗？',
          confirmText: '撤回',
        });
        if (!ok) return;
        await api(`/submissions/${target.dataset.id}`, { method: 'DELETE' });
        toast('已撤回提交');
        render();
        break;
      }

      case 'remove-file': {
        const kind = target.dataset.kind;
        state.uploads[kind] = state.uploads[kind].filter((f) => f.id !== target.dataset.id);
        renderChips(kind);
        break;
      }

      /* ---------------- 班级 ---------------- */
      case 'new-class':
        openClassModal();
        break;

      case 'edit-class':
        openClassModal(target.dataset.id);
        break;

      case 'save-class': {
        const id = target.dataset.id;
        const body = { name: $('#class-name').value, note: $('#class-note').value };
        if (id) await api(`/classes/${id}`, { method: 'PATCH', body });
        else await api('/classes', { method: 'POST', body });
        closeModal();
        toast(id ? '班级已更新' : '班级已创建', 'success');
        state.classes = [];
        render();
        break;
      }

      case 'delete-class': {
        const ok = await askConfirm({
          title: '删除班级',
          message: '删除后该班级的学生会变成「未分班」，相关作业的班级设置也会被移除。确定继续吗？',
          confirmText: '删除',
        });
        if (!ok) return;
        await api(`/classes/${target.dataset.id}`, { method: 'DELETE' });
        state.classes = [];
        toast('班级已删除', 'success');
        render();
        break;
      }

      /* ---------------- 账号 ---------------- */
      case 'new-user':
        await openUserModal();
        break;

      case 'edit-user':
        await openUserModal(target.dataset.id);
        break;

      case 'bulk-user':
        await loadClassesIfNeeded();
        openBulkUserModal();
        break;

      case 'do-bulk-user': {
        const text = $('#bulk-text').value;
        const password = $('#bulk-password').value || '123456';
        const classIds = readClassChecks('bulk');
        const res = await api('/users/bulk', { method: 'POST', body: { text, password, classIds } });
        closeModal();
        toast(`导入完成：新增 ${res.created.length} 个，跳过 ${res.skipped.length} 个`, 'success');
        if (res.skipped.length) {
          openModal({
            title: '部分名单未导入',
            body: `<div class="prose" style="font-size:13px">${esc(res.skipped.join('\n'))}</div>`,
            footer: `<button class="btn btn-primary" data-act="close-modal">知道了</button>`,
          });
        }
        render();
        break;
      }

      case 'save-user': {
        const id = target.dataset.id;
        const username = $('#user-username').value.trim();
        const name = $('#user-name').value.trim();
        const password = $('#user-password').value;
        const roleEl = $('#user-role');
        const role = roleEl && !roleEl.disabled ? roleEl.value : undefined;
        const classIds = readClassChecks('user');

        if (id) {
          const body = { name, classIds };
          if (password) body.password = password;
          if (role) body.role = role;
          await api(`/users/${id}`, { method: 'PATCH', body });
        } else {
          await api('/users', { method: 'POST', body: { username, name, password, role: role || 'student', classIds } });
        }
        closeModal();
        toast(id ? '账号已更新' : '账号已创建', 'success');
        render();
        break;
      }

      case 'toggle-user': {
        const active = target.dataset.active === '1';
        await api(`/users/${target.dataset.id}`, { method: 'PATCH', body: { active: !active } });
        toast(active ? '账号已停用' : '账号已启用', 'success');
        render();
        break;
      }

      case 'delete-user': {
        const ok = await askConfirm({
          title: '删除账号',
          message: '删除账号会同时删除该学生的所有提交记录，确定继续吗？',
          confirmText: '删除',
        });
        if (!ok) return;
        await api(`/users/${target.dataset.id}`, { method: 'DELETE' });
        toast('账号已删除', 'success');
        render();
        break;
      }

      /* ---------------- 设置 ---------------- */
      case 'save-settings': {
        const body = {
          siteName: $('#set-site').value,
          registerEnabled: $('#set-register').checked,
          registerNote: $('#set-register-note').value,
        };
        const res = await api('/settings', { method: 'PATCH', body });
        state.settings = { ...state.settings, ...res.settings };
        toast('设置已保存', 'success');
        render();
        break;
      }

      default:
        break;
    }
  } catch (err) {
    toast(err.message || '操作失败', 'error');
    if (target.tagName === 'BUTTON') target.disabled = false;
  }
});

/* 表单提交 */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const btn = form.querySelector('button[type="submit"]');

  try {
    if (kind === 'login') {
      const username = $('#login-username').value.trim();
      const password = $('#login-password').value;
      if (btn) btn.disabled = true;
      const res = await api('/auth/login', { method: 'POST', body: { username, password } });
      state.user = res.user;
      state.stats = null;
      state.classes = [];
      state.authTab = 'login';
      toast(`欢迎回来，${res.user.name}`, 'success');
      location.hash = res.user.role === 'student' ? '#/home' : '#/overview';
      await render();
    } else if (kind === 'register') {
      const username = $('#reg-username').value.trim();
      const name = $('#reg-name').value.trim();
      const password = $('#reg-password').value;
      if (btn) btn.disabled = true;
      const res = await api('/auth/register', { method: 'POST', body: { username, name, password } });
      state.user = res.user;
      state.authTab = 'login';
      toast('注册成功，已自动登录', 'success');
      location.hash = '#/home';
      await render();
    } else if (kind === 'submit-assignment') {
      const assignmentId = form.dataset.id;
      const content = $('#answer-content').value;
      const files = state.uploads.submission.map((f) => f.id);
      if (btn) {
        btn.disabled = true;
        btn.textContent = '提交中…';
      }
      await api('/submissions', { method: 'POST', body: { assignmentId, content, files } });
      state.uploads.submission = [];
      toast('作业已提交，等待老师批阅', 'success');
      await render();
    }
  } catch (err) {
    toast(err.message || '操作失败', 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = kind === 'submit-assignment' ? '提交作业' : btn.textContent;
    }
  }
});

/* 搜索 / 筛选 / 快捷键 */
document.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && e.target.id === 'review-search') {
    state.reviewKeyword = e.target.value.trim();
    render();
  }
  if (e.key === 'Escape') closeModal();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'user-class-filter') {
    state.userClassId = e.target.value;
    render();
  }
});

/* ------------------------------ 启动 ------------------------------ */

window.addEventListener('hashchange', () => {
  closeModal();
  render();
});

(async function boot() {
  try {
    const s = await api('/settings/public');
    state.settings = { ...state.settings, ...s };
    if (s.siteName) document.title = `${s.siteName} · 在线作业平台`;
  } catch {
    /* 使用默认设置 */
  }
  try {
    const res = await api('/auth/me');
    state.user = res.user;
  } catch {
    state.user = null;
  }
  if (!location.hash) location.hash = state.user ? defaultHash() : '#/login';
  await render();
})();

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

fs.mkdirSync(DATA_DIR, { recursive: true });

const emptyDb = () => ({
  version: 2,
  users: [],
  assignments: [],
  submissions: [],
  files: [],
  classes: [],
  settings: {
    siteName: '云作业',
    registerEnabled: true,
    registerNote: '',
    // 允许学生注册时／登录后自己选择班级（默认关闭，由管理员在系统设置里开启）
    selfClassSelect: false,
  },
});

const ROLES = ['admin', 'teacher', 'student'];

/** 兼容旧数据：补齐缺失字段 */
function normalize(parsed) {
  const base = emptyDb();
  const db = { ...base, ...parsed };
  db.classes = Array.isArray(db.classes) ? db.classes : [];
  db.settings = { ...base.settings, ...(parsed.settings || {}) };
  db.users = (Array.isArray(db.users) ? db.users : []).map((u) => ({
    ...u,
    role: ROLES.includes(u.role) ? u.role : 'student',
    classIds: Array.isArray(u.classIds) ? u.classIds : [],
  }));
  db.assignments = (Array.isArray(db.assignments) ? db.assignments : []).map((a) => ({
    ...a,
    classIds: Array.isArray(a.classIds) ? a.classIds : [],
  }));
  db.submissions = Array.isArray(db.submissions) ? db.submissions : [];
  db.files = Array.isArray(db.files) ? db.files : [];
  return db;
}

function load() {
  if (!fs.existsSync(DB_FILE)) return emptyDb();
  const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
  if (!raw) return emptyDb();
  try {
    return normalize(JSON.parse(raw));
  } catch (err) {
    const backup = `${DB_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(DB_FILE, backup);
    console.error(`[db] 数据文件解析失败，已备份到 ${backup}，将以空数据启动。`, err.message);
    return emptyDb();
  }
}

let state = load();

/** 只读访问内存数据（写入请用 mutate） */
export function data() {
  return state;
}

let writeQueue = Promise.resolve();

/** 原子落盘（写临时文件后 rename），串行执行避免互相覆盖 */
function persist() {
  const json = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tmp = `${DB_FILE}.tmp-${process.pid}`;
    await fs.promises.writeFile(tmp, json, 'utf8');
    await fs.promises.rename(tmp, DB_FILE);
  }).catch((err) => {
    console.error('[db] 写入数据失败:', err);
  });
  return writeQueue;
}

/**
 * 修改数据。mutator 必须是同步函数；返回值会透传给调用方。
 * @template T
 * @param {(db: typeof state) => T} mutator
 * @returns {Promise<T>}
 */
export async function mutate(mutator) {
  const result = mutator(state);
  await persist();
  return result;
}

/** 同步修改 + 触发落盘（无需等待时使用） */
export function mutateSync(mutator) {
  const result = mutator(state);
  persist();
  return result;
}

/** 应用密钥：用于签发会话 Cookie，首次启动自动生成并持久化 */
export function appSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  if (fs.existsSync(SECRET_FILE)) {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 16) return s;
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { encoding: 'utf8', mode: 0o600 });
  return s;
}

export const paths = {
  DATA_DIR,
  DB_FILE,
  UPLOAD_DIR: path.resolve(process.cwd(), process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads')),
};

fs.mkdirSync(paths.UPLOAD_DIR, { recursive: true });

export { persist };

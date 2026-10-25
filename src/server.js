import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { attachUser } from './auth.js';
import { HttpError } from './util.js';
import { paths } from './db.js';
import { seed } from './seed.js';
import authRoutes from './routes/auth.routes.js';
import assignmentRoutes from './routes/assignments.routes.js';
import submissionRoutes from './routes/submissions.routes.js';
import userRoutes from './routes/users.routes.js';
import fileRoutes from './routes/files.routes.js';
import statsRoutes from './routes/stats.routes.js';
import classRoutes from './routes/classes.routes.js';
import settingsRoutes from './routes/settings.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', 1);

/* --------------------------- 基础中间件 --------------------------- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(attachUser);

/* ------------------------------ API ------------------------------ */
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/auth', authRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/settings', settingsRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { message: '接口不存在', code: 'NOT_FOUND' } });
});

/* --------------------------- 静态资源 --------------------------- */
app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    // 静态资源每次都要向服务器确认（带 ETag，未变更时返回 304），
    // 避免手机/浏览器缓存旧版页面导致「新功能看不到」
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);
app.use('/uploads', express.static(paths.UPLOAD_DIR, { index: false, dotfiles: 'deny' }));

// 前端使用 hash 路由，其它 GET 请求一律回首页
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* --------------------------- 错误处理 --------------------------- */
app.use((err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { message: err.message, code: err.code } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { message: '提交内容过大' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: '请求数据格式错误' } });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { message: '文件过大' } });
  }
  console.error('[server] 未处理异常:', err);
  res.status(500).json({ error: { message: '服务器内部错误，请稍后再试' } });
});

/* ----------------------------- 启动 ----------------------------- */
const info = await seed();
app.listen(PORT, '0.0.0.0', () => {
  const line = '='.repeat(56);
  console.log(line);
  console.log('  作业平台已启动');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  局域网访问: http://<本机IP>:${PORT}`);
  console.log(`  数据目录:   ${paths.DATA_DIR}`);
  console.log(`  上传目录:   ${paths.UPLOAD_DIR}`);
  if (info.seeded) {
    console.log(line);
    console.log('  已初始化管理员账号（请登录后立即修改密码）：');
    console.log(`    账号: ${info.admin.username}`);
    console.log(`    密码: ${info.admin.password}`);
    if (info.demo) {
      console.log('  演示学生账号: student / 123456   li / 123456');
      console.log('  （正式使用前请删除演示账号或修改密码）');
    }
  }
  console.log(line);
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../auth.js';
import { data, mutate, paths } from '../db.js';
import { fileView } from '../views.js';
import {
  asyncHandler,
  badRequest,
  forbidden,
  newId,
  notFound,
  now,
  unauthorized,
} from '../util.js';

const router = Router();

const MAX_SIZE_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic',
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
  '.txt', '.md', '.csv', '.zip', '.rar', '.7z', '.mp4', '.mp3', '.wav',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, paths.UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 12);
    cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  },
});

function decodeOriginalName(name) {
  // multer 会把 multipart 里的文件名按 latin1 解码，中文名需要转回 utf8
  if (!name) return '未命名文件';
  const looksMojibake = /[\u0080-\u00ff]/.test(name);
  let fixed = name;
  if (looksMojibake) {
    try {
      const converted = Buffer.from(name, 'latin1').toString('utf8');
      if (!converted.includes('\uFFFD')) fixed = converted;
    } catch {
      /* 保留原名 */
    }
  }
  return fixed.slice(0, 200);
}

function canAccessFile(user, file) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (file.uploaderId === user.id) return true;
  const d = data();
  const inAssignment = d.assignments.some(
    (a) => (a.files || []).includes(file.id) && a.published !== false,
  );
  if (inAssignment) return true;
  return d.submissions.some(
    (s) => (s.files || []).includes(file.id) && s.studentId === user.id,
  );
}

/** 解析单个文件上传，把 multer 错误翻译成中文提示 */
function uploadOne(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(badRequest(`文件超过 ${MAX_SIZE_MB}MB 限制`));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(badRequest('不支持该文件类型（可上传图片、PDF、Office 文档、压缩包等）'));
    }
    return next(err);
  });
}

/** 上传文件，返回文件元信息（提交作业或发布作业时把 id 带上） */
router.post(
  '/',
  requireAuth,
  uploadOne,
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('没有收到文件');
    const record = {
      id: newId(),
      name: decodeOriginalName(req.file.originalname),
      size: req.file.size,
      mime: req.file.mimetype || 'application/octet-stream',
      storedName: req.file.filename,
      uploaderId: req.user.id,
      createdAt: now(),
      used: false,
    };
    await mutate((db) => {
      db.files.push(record);
    });
    res.status(201).json({ file: fileView(record) });
  }),
);

router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    if (!req.user) throw unauthorized();
    const file = data().files.find((f) => f.id === req.params.id);
    if (!file) throw notFound('文件不存在');
    if (!canAccessFile(req.user, file)) throw forbidden('无权访问该文件');

    const full = path.join(paths.UPLOAD_DIR, file.storedName);
    if (!fs.existsSync(full)) throw notFound('文件已丢失');
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const inline = req.query.inline === '1' && /^image\//i.test(file.mime || '');
    const disposition = inline ? 'inline' : 'attachment';
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    fs.createReadStream(full).pipe(res);
  }),
);

export default router;

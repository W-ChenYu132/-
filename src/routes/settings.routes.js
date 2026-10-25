import { Router } from 'express';
import path from 'node:path';
import { requireAdmin } from '../auth.js';
import { data, mutate, paths } from '../db.js';
import { asyncHandler, badRequest } from '../util.js';

const router = Router();

/** 公开接口：登录页需要知道是否开放注册、站点名称 */
router.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const s = data().settings || {};
    res.json({
      siteName: s.siteName || '云作业',
      registerEnabled: s.registerEnabled !== false,
      registerNote: s.registerNote || '',
    });
  }),
);

/** 登录后可读完整设置（仅管理员，避免暴露内部配置） */
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ settings: data().settings });
  }),
);

/** 仅管理员可修改 */
router.patch(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const patch = {};
    if (typeof req.body?.registerEnabled === 'boolean') {
      patch.registerEnabled = req.body.registerEnabled;
    }
    if (typeof req.body?.registerNote === 'string') {
      patch.registerNote = req.body.registerNote.slice(0, 200);
    }
    if (req.body?.siteName !== undefined) {
      const name = String(req.body.siteName).trim();
      if (!name || name.length > 30) throw badRequest('站点名称需为 1-30 个字符');
      patch.siteName = name;
    }
    const settings = await mutate((db) => {
      db.settings = { ...db.settings, ...patch };
      return db.settings;
    });
    res.json({ settings });
  }),
);

/** 下载数据备份（JSON），便于在免费托管（磁盘不持久）场景下定期存档 */
router.get(
  '/backup',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.download(paths.DB_FILE, `homework-backup-${stamp}.json`, (err) => {
      if (err && !res.headersSent) res.status(500).end();
    });
  }),
);

export default router;
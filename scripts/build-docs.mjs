/**
 * 生成三份 Word 文档到 docs/ 目录
 * 用法：node scripts/build-docs.mjs
 */

import path from 'node:path';
import fs from 'node:fs';
import { buildDocx } from './docx.mjs';
import publish from './docs/01-publish.mjs';
import adminTeacher from './docs/02-admin-teacher.mjs';
import student from './docs/03-student.mjs';

const rootDir = process.cwd();
const outDir = path.join(rootDir, 'docs');
fs.mkdirSync(outDir, { recursive: true });

const docs = [publish, adminTeacher, student];

console.log('开始生成 Word 文档…\n');
for (const item of docs) {
  const outFile = path.join(outDir, item.file);
  const res = buildDocx({
    doc: { ...item.doc, rootDir },
    outFile,
  });
  const kb = (res.bytes / 1024).toFixed(0);
  console.log(`  ✓ ${item.file}　${kb} KB　（${res.images} 张插图）`);
}
console.log(`\n全部完成，输出目录：${outDir}`);

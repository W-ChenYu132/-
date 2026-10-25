/**
 * 极简 .docx 生成器（零依赖）
 * - 手写 OOXML + 自带 ZIP 打包（deflate）
 * - 支持：封面、标题层级、正文（**加粗**、`代码`）、项目符号/编号列表、表格、图片、提示框、代码块、分页、页脚页码
 *
 * 用法：
 *   import { buildDocx } from './docx.mjs';
 *   await buildDocx({ doc, rootDir, outFile });
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ============================== ZIP ============================== */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(d = new Date()) {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosStamp();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ============================ OOXML 工具 ============================ */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CN_FONT = '微软雅黑';
const CN_BODY = '宋体';
const MONO = 'Consolas';

/** A4 = 11906 x 16838 twips，左右边距 1247 twips */
const PAGE_W = 11906;
const MARGIN_X = 1247;
const CONTENT_W = PAGE_W - MARGIN_X * 2; // 9412

function run(text, opts = {}) {
  const font = opts.font || CN_BODY;
  const pr = [
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
  ];
  if (opts.bold) pr.push('<w:b/><w:bCs/>');
  if (opts.italic) pr.push('<w:i/>');
  if (opts.color) pr.push(`<w:color w:val="${opts.color}"/>`);
  if (opts.size) pr.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  if (opts.underline) pr.push('<w:u w:val="single"/>');
  return `<w:r><w:rPr>${pr.join('')}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** 支持 **加粗** 与 `等宽代码` 的行内富文本 */
function inline(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) out.push(run(text.slice(last, m.index), base));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(run(tok.slice(2, -2), { ...base, bold: true, color: base.color || '16233D' }));
    } else {
      out.push(run(tok.slice(1, -1), { ...base, font: MONO, color: 'B03A5B', size: base.size || 19 }));
    }
    last = m.index + tok.length;
    m = re.exec(text);
  }
  if (last < text.length) out.push(run(text.slice(last), base));
  return out.join('');
}

function para(content, opts = {}) {
  const pr = [`<w:pStyle w:val="${opts.style || 'BodyText'}"/>`];
  if (opts.align) pr.push(`<w:jc w:val="${opts.align}"/>`);
  if (opts.ind) pr.push(opts.ind);
  if (opts.spacing) pr.push(opts.spacing);
  if (opts.shading) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shading}"/>`);
  if (opts.borders) pr.push(opts.borders);
  if (opts.keepNext) pr.push('<w:keepNext/>');
  return `<w:p><w:pPr>${pr.join('')}</w:pPr>${content}</w:p>`;
}

function heading(level, text) {
  return para(inline(text, { font: CN_FONT, bold: true }), { style: `Heading${level}`, keepNext: true });
}

function bullets(items, { numbered = false } = {}) {
  return items
    .map((item, i) => {
      const marker = numbered ? `${i + 1}.` : '•';
      return para(
        run(`${marker} `, { font: CN_FONT, bold: true, color: '2B6CF6' }) + inline(item),
        { style: 'ListText', ind: '<w:ind w:left="454" w:hanging="240"/>' },
      );
    })
    .join('');
}

function table({ head, rows, widths }) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cols = widths.map((w) => Math.round((w / total) * CONTENT_W));
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D3DBE8"/>`;

  const cell = (text, { header = false, w = 0 } = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${
      header ? '<w:shd w:val="clear" w:color="auto" w:fill="EAF1FF"/>' : ''
    }<w:vAlign w:val="center"/></w:tcPr>${para(
      inline(String(text ?? ''), {
        font: header ? CN_FONT : CN_BODY,
        bold: header,
        size: 19,
        color: header ? '1B3A7A' : undefined,
      }),
      { style: 'TableText' },
    )}</w:tc>`;

  const headRow = head
    ? `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${head
        .map((h, i) => cell(h, { header: true, w: cols[i] }))
        .join('')}</w:tr>`
    : '';

  const bodyRows = rows
    .map(
      (r) =>
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>${r
          .map((c, i) => cell(c, { w: cols[i] }))
          .join('')}</w:tr>`,
    )
    .join('');

  return `
<w:tbl>
  <w:tblPr>
    <w:tblW w:w="${CONTENT_W}" w:type="dxa"/>
    <w:tblBorders>${border('top')}${border('left')}${border('bottom')}${border('right')}${border('insideH')}${border('insideV')}</w:tblBorders>
    <w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar>
  </w:tblPr>
  <w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>
  ${headRow}${bodyRows}
</w:tbl>
${para('', { style: 'TableText' })}`;
}

function note(kind, text) {
  const palette = {
    info: { bg: 'EDF3FF', line: '2B6CF6', label: '提示', color: '1B3A7A' },
    warn: { bg: 'FDF3E2', line: 'D97706', label: '注意', color: '8A4B04' },
    danger: { bg: 'FDECEC', line: 'DC2626', label: '重要', color: '9B1C1C' },
    tip: { bg: 'EAF8EE', line: '16A34A', label: '建议', color: '14602F' },
  }[kind || 'info'];

  const bdr = (side) =>
    `<w:${side} w:val="single" w:sz="6" w:space="6" w:color="${palette.line}"/>`;

  return para(
    run(`${palette.label}　`, { font: CN_FONT, bold: true, color: palette.color, size: 20 }) +
      inline(text, { size: 20, color: palette.color }),
    {
      style: 'NoteText',
      shading: palette.bg,
      borders: `<w:pBdr>${bdr('top')}${bdr('left')}${bdr('bottom')}${bdr('right')}</w:pBdr>`,
      ind: '<w:ind w:left="113" w:right="113"/>',
      spacing: '<w:spacing w:before="120" w:after="120" w:line="300" w:lineRule="auto"/>',
    },
  );
}

function codeBlock(text) {
  return text
    .split('\n')
    .map((line) =>
      para(run(line || ' ', { font: MONO, size: 18, color: '1F2A44' }), {
        style: 'CodeText',
        shading: 'F5F7FB',
        borders: `<w:pBdr><w:left w:val="single" w:sz="18" w:space="6" w:color="9FB3D1"/></w:pBdr>`,
        ind: '<w:ind w:left="170"/>',
        spacing: '<w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto"/>',
      }),
    )
    .join('');
}

/** 图注编号说明：1 用户名　2 密码　3 登录按钮 */
function legendBlock(items) {
  const parts = [run('图中编号　', { font: CN_FONT, size: 17, color: '9AA6B9' })];
  items.forEach((text, i) => {
    if (i > 0) parts.push(run('　　', { size: 17 }));
    parts.push(run(String(i + 1), { font: CN_FONT, bold: true, size: 18, color: 'FF3B30' }));
    parts.push(run(` ${text}`, { font: CN_BODY, size: 18, color: '47536B' }));
  });
  return para(parts.join(''), {
    style: 'LegendText',
    shading: 'F7F9FD',
    borders: `<w:pBdr><w:left w:val="single" w:sz="12" w:space="6" w:color="D3DBE8"/></w:pBdr>`,
    ind: '<w:ind w:left="113" w:right="113"/>',
    spacing: '<w:spacing w:before="40" w:after="200" w:line="280" w:lineRule="auto"/>',
  });
}

/* ============================== 图片 ============================== */

function pngSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 1500, height: 1000 };
}

const EMU_PER_PX = 9525; // 96dpi
const MAX_IMG_W = 5486400; // 6 英寸

function imageParagraph({ relId, px, index, caption }) {
  const ratio = px.height / px.width;
  let cx = px.width * EMU_PER_PX;
  let cy = px.height * EMU_PER_PX;
  const maxH = 4114800; // 4.5 英寸，避免单张图占满整页
  if (cx > MAX_IMG_W) {
    cy = Math.round((cy * MAX_IMG_W) / cx);
    cx = MAX_IMG_W;
  }
  if (cy > maxH) {
    cx = Math.round((cx * maxH) / cy);
    cy = maxH;
  }

  const drawing = `<w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${cx}" cy="${cy}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="${index}" name="图片 ${index}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr>
              <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
              <a:ln xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:solidFill><a:srgbClr val="D3DBE8"/></a:solidFill></a:ln>
            </pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>`;

  const imgPara = para(`<w:r>${drawing}</w:r>`, {
    align: 'center',
    spacing: '<w:spacing w:before="120" w:after="40" w:line="240" w:lineRule="auto"/>',
    keepNext: Boolean(caption),
  });

  return (
    imgPara +
    (caption
      ? para(run(caption, { size: 18, color: '7A869A', font: CN_FONT }), { style: 'CaptionText', align: 'center' })
      : '')
  );
}

/* ============================ 样式与部件 ============================ */

function stylesXml() {
  const heading = (id, name, size, color, before, after, outline) => `
  <w:style w:type="paragraph" w:styleId="${id}">
    <w:name w:val="${name}"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="BodyText"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:outlineLvl w:val="${outline}"/>
      <w:spacing w:before="${before}" w:after="${after}" w:line="300" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/>
      <w:b/>
      <w:color w:val="${color}"/>
      <w:sz w:val="${size}"/><w:szCs w:val="${size}"/>
    </w:rPr>
  </w:style>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${CN_BODY}" w:hAnsi="${CN_BODY}" w:eastAsia="${CN_BODY}" w:cs="${CN_BODY}"/>
        <w:sz w:val="21"/><w:szCs w:val="21"/>
        <w:lang w:val="en-US" w:eastAsia="zh-CN"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr><w:spacing w:after="120" w:line="312" w:lineRule="auto"/></w:pPr>
    </w:pPrDefault>
  </w:docDefaults>

  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
  </w:style>

  <w:style w:type="paragraph" w:styleId="BodyText">
    <w:name w:val="Body Text"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="0" w:after="120" w:line="330" w:lineRule="auto"/>
      <w:ind w:firstLine="0"/>
    </w:pPr>
    <w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="ListText">
    <w:name w:val="List Text"/>
    <w:basedOn w:val="BodyText"/>
    <w:qFormat/>
    <w:pPr><w:spacing w:before="0" w:after="60" w:line="320" w:lineRule="auto"/></w:pPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="TableText">
    <w:name w:val="Table Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="NoteText">
    <w:name w:val="Note Text"/>
    <w:basedOn w:val="BodyText"/>
    <w:pPr><w:spacing w:before="120" w:after="120" w:line="300" w:lineRule="auto"/></w:pPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="CodeText">
    <w:name w:val="Code Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="auto"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${MONO}" w:hAnsi="${MONO}" w:eastAsia="${CN_BODY}"/>
      <w:sz w:val="18"/><w:szCs w:val="18"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="CaptionText">
    <w:name w:val="Caption Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="200" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/><w:color w:val="7A869A"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="LegendText">
    <w:name w:val="Legend Text"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="40" w:after="200" w:line="280" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="CoverTitle">
    <w:name w:val="Cover Title"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="2400" w:after="240" w:line="400" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/>
      <w:b/><w:color w:val="122C58"/>
      <w:sz w:val="56"/><w:szCs w:val="56"/>
    </w:rPr>
  </w:style>

  <w:style w:type="paragraph" w:styleId="CoverSub">
    <w:name w:val="Cover Sub"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="1200" w:line="320" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/>
      <w:color w:val="47536B"/>
      <w:sz w:val="26"/><w:szCs w:val="26"/>
    </w:rPr>
  </w:style>

  ${heading('Heading1', 'heading 1', 34, '122C58', 420, 200, 0)}
  ${heading('Heading2', 'heading 2', 27, '1B3A7A', 320, 160, 1)}
  ${heading('Heading3', 'heading 3', 23, '2B4C88', 240, 120, 2)}
  <w:style w:type="table" w:default="1" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:qFormat/>
  </w:style>
</w:styles>`;
}

function footerXml(docLabel) {
  const pageField = `
    <w:r><w:rPr><w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:t xml:space="preserve">第 </w:t></w:r>
    <w:r><w:rPr><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:rPr><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
    <w:r><w:rPr><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>
    <w:r><w:rPr><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:t>1</w:t></w:r>
    <w:r><w:rPr><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>
    <w:r><w:rPr><w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:t xml:space="preserve"> 页</w:t></w:r>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p>
    <w:pPr>
      <w:pStyle w:val="Normal"/>
      <w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D3DBE8"/></w:pBdr>
      <w:tabs><w:tab w:val="right" w:pos="${CONTENT_W}"/></w:tabs>
      <w:spacing w:before="0" w:after="0"/>
    </w:pPr>
    <w:r><w:rPr><w:rFonts w:ascii="${CN_FONT}" w:hAnsi="${CN_FONT}" w:eastAsia="${CN_FONT}"/><w:color w:val="7A869A"/><w:sz w:val="17"/></w:rPr><w:t xml:space="preserve">${esc(docLabel)}</w:t></w:r>
    <w:r><w:tab/></w:r>
    ${pageField}
  </w:p>
</w:ftr>`;
}

const CONTENT_TYPES = (imageCount) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

function coreXml(doc) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${esc(doc.title)}</dc:title>
  <dc:subject>${esc(doc.subtitle || '')}</dc:subject>
  <dc:creator>云作业 · 在线作业平台</dc:creator>
  <cp:keywords>作业平台;使用手册;部署指南</cp:keywords>
  <dc:description>${esc(doc.subtitle || '')}</dc:description>
  <cp:lastModifiedBy>云作业</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>云作业文档生成器</Application>
  <Company>云作业 · 在线作业平台</Company>
</Properties>`;
}

/* ============================== 文档组装 ============================== */

const pageBreak = () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
const spacer = (h = 200) => `<w:p><w:pPr><w:spacing w:before="0" w:after="${h}"/></w:pPr></w:p>`;

function coverPage(doc) {
  const metaRows = (doc.meta || [])
    .map(
      ([k, v]) =>
        `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="60"/></w:pPr>${run(
          `${k}：`,
          { font: CN_FONT, size: 20, color: '7A869A' },
        )}${run(v, { font: CN_FONT, size: 20, color: '1B2437' })}</w:p>`,
    )
    .join('');

  const accent = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="200"/></w:pPr>${run(
    '● ● ●',
    { color: '2B6CF6', size: 22 },
  )}</w:p>`;

  return `
${para(run(doc.title, { font: CN_FONT, bold: true, size: 52, color: '122C58' }), { style: 'CoverTitle' })}
${accent}
${para(run(doc.subtitle || '', { font: CN_FONT, size: 26, color: '47536B' }), { style: 'CoverSub' })}
${metaRows}
${spacer(600)}
${para(
  run('云作业 · 在线作业平台  ——  老师发布题目，学生上传答案，管理员在线审批', {
    font: CN_FONT,
    size: 19,
    color: '808C9F',
  }),
  { align: 'center' },
)}
${pageBreak()}`;
}

/** 将 block 数组编译为 document.xml 的 body */
function compileBlocks(doc, images) {
  const out = [];
  let imgIndex = 0;

  for (const block of doc.blocks) {
    if (block.pagebreak) {
      out.push(pageBreak());
      continue;
    }
    if (block.h1 !== undefined) {
      out.push(heading(1, block.h1));
      continue;
    }
    if (block.h2 !== undefined) {
      out.push(heading(2, block.h2));
      continue;
    }
    if (block.h3 !== undefined) {
      out.push(heading(3, block.h3));
      continue;
    }
    if (block.p !== undefined) {
      out.push(para(inline(block.p)));
      continue;
    }
    if (block.bullets) {
      out.push(bullets(block.bullets));
      continue;
    }
    if (block.steps) {
      out.push(bullets(block.steps, { numbered: true }));
      continue;
    }
    if (block.table) {
      out.push(table(block.table));
      continue;
    }
    if (block.code) {
      out.push(codeBlock(block.code));
      continue;
    }
    if (block.note) {
      out.push(note(block.note.kind, block.note.text));
      continue;
    }
    if (block.img) {
      imgIndex += 1;
      const abs = path.resolve(doc.rootDir, block.img);
      const buf = fs.readFileSync(abs);
      const px = pngSize(buf);
      const relId = `rId${100 + imgIndex}`;
      images.push({ relId, name: `image${imgIndex}.png`, data: buf });
      out.push(imageParagraph({ relId, px, index: imgIndex, caption: block.caption }));
      continue;
    }
    if (block.legend) {
      out.push(legendBlock(block.legend));
      continue;
    }
    if (block.spacer) {
      out.push(spacer(block.spacer));
      continue;
    }
    throw new Error(`未知的 block 类型: ${JSON.stringify(block).slice(0, 80)}`);
  }

  return out.join('\n');
}

function documentXml(bodyXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
${bodyXml}
    <w:sectPr>
      <w:footerReference w:type="default" r:id="rId2"/>
      <w:pgSz w:w="${PAGE_W}" w:h="16838"/>
      <w:pgMar w:top="1247" w:right="${MARGIN_X}" w:bottom="1247" w:left="${MARGIN_X}" w:header="851" w:footer="992" w:gutter="0"/>
      <w:cols w:space="425"/>
      <w:docGrid w:linePitch="312"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function documentRels(images) {
  const imgRels = images
    .map(
      (img) =>
        `<Relationship Id="${img.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.name}"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  ${imgRels}
</Relationships>`;
}

/**
 * 生成一个 .docx
 * @param {{ doc: object, outFile: string }} options
 */
export function buildDocx({ doc, outFile }) {
  const rootDir = doc.rootDir || process.cwd();
  const images = [];
  const body = coverPage({ ...doc }) + compileBlocks({ ...doc, rootDir }, images);

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES(images.length), 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml(doc), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(appXml(), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(body), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml(doc.footerLabel || doc.title), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels(images), 'utf8') },
    ...images.map((img) => ({ name: `word/media/${img.name}`, data: img.data })),
  ];

  const buf = makeZip(entries);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, buf);
  return { outFile, bytes: buf.length, images: images.length };
}

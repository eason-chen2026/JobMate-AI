import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { PATHS, ensureDataDirs } from './paths.mjs';
import { addAuditLog } from './db.mjs';
import {
  loadPrivateProfile,
  restoreObjectDeep,
  sanitizeText,
  saveMasterResume,
} from './privacy.mjs';

/**
 * 规范化主简历数据结构（支持工作经历内嵌多段品牌/子项目 subProjects）
 */
export function normalizeMasterResume(raw = {}) {
  const toLines = (val) => {
    if (Array.isArray(val)) {
      return val.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
    if (typeof val === 'string') {
      return val
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return [];
  };

  const normalizeSummary = (val) => {
    if (Array.isArray(val)) {
      return val.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n');
    }
    return String(val ?? '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .join('\n');
  };

  const normalizeSubProjects = (list) =>
    Array.isArray(list)
      ? list
          .map((sp) => ({
            name: String(sp?.name ?? '').trim(),
            role: String(sp?.role ?? '').trim(),
            period: String(sp?.period ?? '').trim(),
            highlights: toLines(sp?.highlights),
          }))
          .filter((sp) => sp.name || sp.role || sp.period || sp.highlights.length)
      : [];

  return {
    headline: String(raw?.headline ?? '').trim(),
    basicInfo: String(raw?.basicInfo ?? '').trim(),
    summary: normalizeSummary(raw?.summary),
    skills: toLines(raw?.skills),
    experiences: Array.isArray(raw?.experiences)
      ? raw.experiences
          .map((item) => ({
            company: String(item?.company ?? '').trim(),
            role: String(item?.role ?? '').trim(),
            period: String(item?.period ?? '').trim(),
            highlights: toLines(item?.highlights),
            subProjects: normalizeSubProjects(item?.subProjects),
          }))
          .filter(
            (item) =>
              item.company ||
              item.role ||
              item.period ||
              item.highlights.length ||
              item.subProjects.length
          )
      : [],
    projects: Array.isArray(raw?.projects)
      ? raw.projects
          .map((item) => ({
            name: String(item?.name ?? '').trim(),
            role: String(item?.role ?? '').trim(),
            period: String(item?.period ?? '').trim(),
            highlights: toLines(item?.highlights),
          }))
          .filter((item) => item.name || item.role || item.period || item.highlights.length)
      : [],
    education: Array.isArray(raw?.education)
      ? raw.education
          .map((item) => ({
            school: String(item?.school ?? '').trim(),
            degree: String(item?.degree ?? '').trim(),
            period: String(item?.period ?? '').trim(),
          }))
          .filter((item) => item.school || item.degree || item.period)
      : [],
  };
}

/**
 * 零依赖读取 ZIP（.docx）中指定路径的条目内容
 */
function readZipEntry(zipBuffer, targetEntryNames) {
  const buf = Buffer.isBuffer(zipBuffer) ? zipBuffer : Buffer.from(zipBuffer);
  const minPos = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('文件不是有效的 .docx（ZIP）格式，请确认文件未损坏且非老版 .doc 格式。');
  }

  const cdEntriesCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const wanted = new Set(targetEntryNames.map((n) => n.toLowerCase()));
  const results = new Map();

  let offset = cdOffset;
  for (let i = 0; i < cdEntriesCount; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);

    const fileName = buf.subarray(offset + 46, offset + 46 + fileNameLen).toString('utf8');
    offset += 46 + fileNameLen + extraLen + commentLen;

    const lowerName = fileName.toLowerCase();
    if (!wanted.has(lowerName) && !/^word\/header\d*\.xml$/.test(lowerName)) continue;

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      continue;
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

    let rawData;
    if (compressionMethod === 0) {
      rawData = compressedData;
    } else if (compressionMethod === 8) {
      rawData = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`不支持的 .docx 压缩方式 (${compressionMethod})`);
    }
    results.set(lowerName, rawData.toString('utf8'));
  }

  return results;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function xmlToPlainText(xml) {
  if (!xml) return '';
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, ' | ')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeXmlEntities(withBreaks)
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[\t\u00A0]+/g, ' ')
        .replace(/\s*\|\s*(\|\s*)+/g, ' | ')
        .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
        .replace(/ {2,}/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * 从 .docx 二进制内容离线提取纯文本
 */
export function extractTextFromDocxBuffer(buffer) {
  const entries = readZipEntry(buffer, ['word/document.xml']);
  const docXml = entries.get('word/document.xml');
  if (!docXml) {
    throw new Error('在 .docx 文件中未找到 word/document.xml 正文内容。');
  }
  const parts = [];
  for (const [name, xml] of entries.entries()) {
    if (name !== 'word/document.xml') {
      const headerText = xmlToPlainText(xml);
      if (headerText) parts.push(headerText);
    }
  }
  parts.push(xmlToPlainText(docXml));
  return parts.filter(Boolean).join('\n');
}

function decodeHexToUnicode(hexStr) {
  const clean = String(hexStr || '').replace(/\s+/g, '');
  if (!clean) return '';
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const code = parseInt(clean.slice(i, i + 4), 16);
    if (!Number.isNaN(code) && code > 0) out += String.fromCharCode(code);
  }
  return out;
}

function parseToUnicodeCMap(cmapText, cmapMap) {
  // 解析 beginbfchar ... endbfchar
  const charBlocks = cmapText.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
  for (const block of charBlocks) {
    const pairs = block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const m of pairs) {
      const src = m[1].toUpperCase();
      const dst = decodeHexToUnicode(m[2]);
      if (dst) cmapMap.set(src, dst);
    }
  }
  // 解析 beginbfrange ... endbfrange
  const rangeBlocks = cmapText.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
  for (const block of rangeBlocks) {
    const rangeLines = block.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]+)\])/g
    );
    for (const m of rangeLines) {
      const startHex = m[1].toUpperCase();
      const endHex = m[2].toUpperCase();
      const width = startHex.length;
      const startCode = parseInt(startHex, 16);
      const endCode = parseInt(endHex, 16);
      if (Number.isNaN(startCode) || Number.isNaN(endCode) || endCode - startCode > 8192) continue;

      if (m[3]) {
        const baseDstHex = m[3];
        if (baseDstHex.length <= 4) {
          let dstCode = parseInt(baseDstHex, 16);
          for (let c = startCode; c <= endCode; c += 1) {
            cmapMap.set(c.toString(16).toUpperCase().padStart(width, '0'), String.fromCharCode(dstCode));
            dstCode += 1;
          }
        } else {
          const prefix = baseDstHex.slice(0, -4);
          let lastCode = parseInt(baseDstHex.slice(-4), 16);
          for (let c = startCode; c <= endCode; c += 1) {
            const hexFull = prefix + lastCode.toString(16).toUpperCase().padStart(4, '0');
            cmapMap.set(c.toString(16).toUpperCase().padStart(width, '0'), decodeHexToUnicode(hexFull));
            lastCode += 1;
          }
        }
      } else if (m[4]) {
        const arr = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => decodeHexToUnicode(x[1]));
        for (let i = 0; i < arr.length && startCode + i <= endCode; i += 1) {
          if (arr[i]) {
            cmapMap.set((startCode + i).toString(16).toUpperCase().padStart(width, '0'), arr[i]);
          }
        }
      }
    }
  }
}

function decodePdfLiteralString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') {
        out += '\n';
        i += 1;
      } else if (next === 'r') {
        out += '\r';
        i += 1;
      } else if (next === 't') {
        out += '\t';
        i += 1;
      } else if (next === 'b' || next === 'f') {
        i += 1;
      } else if (next === '(' || next === ')' || next === '\\') {
        out += next;
        i += 1;
      } else if (/[0-7]/.test(next)) {
        const oct = raw.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        out += String.fromCharCode(parseInt(oct, 8));
        i += oct.length;
      } else if (next === '\r' || next === '\n') {
        i += next === '\r' && raw[i + 2] === '\n' ? 2 : 1;
      } else {
        out += next;
        i += 1;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function decodePdfHexString(hexRaw, cmapMap) {
  const clean = String(hexRaw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!clean) return '';
  // UTF-16BE BOM
  if (clean.startsWith('FEFF') && clean.length >= 8) {
    return decodeHexToUnicode(clean.slice(4));
  }
  // 优先按 2 字节（4 hex）查 ToUnicode CMap（Chrome / Word / WPS 中文 PDF 均走此路径）
  if (cmapMap.size > 0 && clean.length % 4 === 0) {
    let out = '';
    let hit = 0;
    const total = clean.length / 4;
    for (let i = 0; i < clean.length; i += 4) {
      const k = clean.slice(i, i + 4);
      if (cmapMap.has(k)) {
        out += cmapMap.get(k);
        hit += 1;
      } else {
        const code = parseInt(k, 16);
        if (code >= 32 && code < 127) out += String.fromCharCode(code);
      }
    }
    if (hit > 0 && hit >= total * 0.25) return out;
  }
  // 尝试 1 字节（2 hex）查 CMap
  if (cmapMap.size > 0 && clean.length % 2 === 0) {
    let out = '';
    let hit = 0;
    for (let i = 0; i < clean.length; i += 2) {
      const k = clean.slice(i, i + 2);
      if (cmapMap.has(k)) {
        out += cmapMap.get(k);
        hit += 1;
      }
    }
    if (hit > 0) return out;
  }
  // ASCII 兜底
  let ascii = '';
  for (let i = 0; i + 2 <= clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 && code < 127) ascii += String.fromCharCode(code);
  }
  return ascii;
}

function extractTextFromPdfContentStream(streamText, fontCmapByName, fallbackCmap) {
  const lines = [];
  let curLine = '';
  let activeCmap = fallbackCmap;
  const flushLine = () => {
    const t = curLine.replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    curLine = '';
  };

  // 只解析 BT ... ET 文本块，防止误读矢量路径指令
  const btBlocks = streamText.match(/\bBT\b[\s\S]*?\bET\b/g) || [];
  for (const block of btBlocks) {
    let i = 0;
    const n = block.length;
    const stack = [];
    while (i < n) {
      const ch = block[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '%') {
        while (i < n && block[i] !== '\n' && block[i] !== '\r') i += 1;
        continue;
      }
      if (ch === '/') {
        let start = i + 1;
        i += 1;
        while (i < n && !/[\s\[\]()<>\/%]/.test(block[i])) i += 1;
        stack.push({ type: 'name', val: block.slice(start, i) });
        continue;
      }
      if (ch === '(') {
        let depth = 1;
        let start = i + 1;
        i += 1;
        while (i < n && depth > 0) {
          if (block[i] === '\\') {
            i += 2;
            continue;
          }
          if (block[i] === '(') depth += 1;
          else if (block[i] === ')') depth -= 1;
          i += 1;
        }
        const raw = block.slice(start, i - 1);
        stack.push({ type: 'str', val: decodePdfLiteralString(raw) });
        continue;
      }
      if (ch === '<' && block[i + 1] !== '<') {
        const end = block.indexOf('>', i + 1);
        if (end < 0) break;
        const hex = block.slice(i + 1, end);
        stack.push({ type: 'hex', val: decodePdfHexString(hex, activeCmap) });
        i = end + 1;
        continue;
      }
      if (ch === '[') {
        const arr = [];
        i += 1;
        while (i < n && block[i] !== ']') {
          if (/\s/.test(block[i])) {
            i += 1;
          } else if (block[i] === '(') {
            let depth = 1;
            let start = i + 1;
            i += 1;
            while (i < n && depth > 0) {
              if (block[i] === '\\') {
                i += 2;
                continue;
              }
              if (block[i] === '(') depth += 1;
              else if (block[i] === ')') depth -= 1;
              i += 1;
            }
            arr.push({ type: 'str', val: decodePdfLiteralString(block.slice(start, i - 1)) });
          } else if (block[i] === '<') {
            const end = block.indexOf('>', i + 1);
            if (end < 0) break;
            arr.push({ type: 'hex', val: decodePdfHexString(block.slice(i + 1, end), activeCmap) });
            i = end + 1;
          } else {
            let start = i;
            while (i < n && !/[\s\[\]()<>]/.test(block[i])) i += 1;
            const num = Number(block.slice(start, i));
            if (!Number.isNaN(num)) arr.push({ type: 'num', val: num });
          }
        }
        if (block[i] === ']') i += 1;
        stack.push({ type: 'arr', val: arr });
        continue;
      }

      // 读取操作数或操作符
      let start = i;
      while (i < n && !/[\s\[\]()<>\/%]/.test(block[i])) i += 1;
      if (i === start) {
        i += 1;
        continue;
      }
      const token = block.slice(start, i);
      if (token === 'Tf') {
        const nameItem = [...stack].reverse().find((x) => x.type === 'name');
        if (nameItem && fontCmapByName.has(nameItem.val)) {
          activeCmap = fontCmapByName.get(nameItem.val);
        }
        stack.length = 0;
      } else if (token === 'Tj' || token === "'" || token === '"') {
        if (token === "'" || token === '"') flushLine();
        const item = stack.pop();
        if (item && (item.type === 'str' || item.type === 'hex')) curLine += item.val;
        stack.length = 0;
      } else if (token === 'TJ') {
        const item = stack.pop();
        if (item && item.type === 'arr') {
          for (const el of item.val) {
            if (el.type === 'str' || el.type === 'hex') curLine += el.val;
            else if (el.type === 'num' && el.val < -260 && curLine && !curLine.endsWith(' ')) curLine += ' ';
          }
        }
        stack.length = 0;
      } else if (token === 'T*') {
        flushLine();
        stack.length = 0;
      } else if (token === 'Td' || token === 'TD') {
        const ty = Number(stack[stack.length - 1]?.val ?? 0);
        const tx = Number(stack[stack.length - 2]?.val ?? 0);
        if (Math.abs(ty) > 1.5) flushLine();
        else if (tx > 60 && curLine && !curLine.endsWith(' ')) curLine += ' ';
        stack.length = 0;
      } else if (token === 'Tm') {
        flushLine();
        stack.length = 0;
      } else if (/^[A-Za-z*']+$/.test(token)) {
        stack.length = 0;
      } else {
        stack.push({ type: 'num', val: token });
      }
    }
    flushLine();
  }
  return lines.join('\n');
}

/**
 * 零依赖离线提取 PDF 文本（支持按字体精准绑定 ToUnicode CMap、FlateDecode 解压与 Tj/TJ 文本提取）
 */
export function extractTextFromPdfBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const latin = buf.toString('latin1');
  if (!latin.slice(0, 1024).includes('%PDF-')) {
    throw new Error('文件不是合法的 PDF 格式，请确认文件未损坏。');
  }

  const decompressedStreams = [];
  const cmapByObjId = new Map();
  const fallbackCmap = new Map();

  // 1. 解析字体对象 -> ToUnicode 对象映射，以及页面资源 /F* -> 字体对象映射
  const fontObjToCmapObj = new Map();
  const fontNameToObjIds = new Map();
  for (const m of latin.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g)) {
    const objId = Number(m[1]);
    const body = m[2];
    const tu = body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (tu) fontObjToCmapObj.set(objId, Number(tu[1]));
    const fontDict = body.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (fontDict) {
      for (const fm of fontDict[1].matchAll(/\/([A-Za-z0-9_.-]+)\s+(\d+)\s+0\s+R/g)) {
        fontNameToObjIds.set(fm[1], Number(fm[2]));
      }
    }
  }

  // 2. 遍历解压所有 stream，分别收集各对象的 ToUnicode CMap 和页面内容流（跳过二进制字体文件）
  let searchPos = 0;
  while (true) {
    const streamIdx = latin.indexOf('stream', searchPos);
    if (streamIdx < 0) break;
    const prevCh = latin[streamIdx - 1] || '\n';
    if (/[A-Za-z0-9]/.test(prevCh)) {
      searchPos = streamIdx + 6;
      continue;
    }

    let dataStart = streamIdx + 6;
    if (latin[dataStart] === '\r' && latin[dataStart + 1] === '\n') dataStart += 2;
    else if (latin[dataStart] === '\n' || latin[dataStart] === '\r') dataStart += 1;

    const endIdx = latin.indexOf('endstream', dataStart);
    if (endIdx < 0) break;
    searchPos = endIdx + 9;

    const prefix = latin.slice(Math.max(0, streamIdx - 900), streamIdx);
    const objMatches = [...prefix.matchAll(/(\d+)\s+0\s+obj\b/g)];
    const curObjId = objMatches.length ? Number(objMatches[objMatches.length - 1][1]) : -1;
    const rawSlice = buf.subarray(dataStart, endIdx);

    let decodedBuf = rawSlice;
    if (/\/FlateDecode\b/.test(prefix)) {
      try {
        decodedBuf = zlib.inflateSync(rawSlice);
      } catch {
        try {
          decodedBuf = zlib.inflateRawSync(rawSlice);
        } catch {
          continue;
        }
      }
    }

    // 跳过内嵌二进制字体流（TrueType / CFF / 图片等含大量 NUL 字节）
    const headSample = decodedBuf.subarray(0, Math.min(64, decodedBuf.length));
    let nulCount = 0;
    for (let k = 0; k < headSample.length; k += 1) {
      if (headSample[k] === 0) nulCount += 1;
    }
    if (nulCount > 4) continue;

    const text = decodedBuf.toString('latin1');
    if (text.includes('begincmap') || text.includes('beginbfchar') || text.includes('beginbfrange')) {
      const localMap = new Map();
      parseToUnicodeCMap(text, localMap);
      if (curObjId >= 0) cmapByObjId.set(curObjId, localMap);
      for (const [k, v] of localMap.entries()) {
        if (!fallbackCmap.has(k)) fallbackCmap.set(k, v);
      }
    } else if (/\bBT\b/.test(text) && (text.includes('Tj') || text.includes('TJ'))) {
      decompressedStreams.push(text);
    }
  }

  // 3. 构建 /F* 字体名 -> 专属 ToUnicode CMap 查找表
  const fontCmapByName = new Map();
  for (const [fontName, fontObjId] of fontNameToObjIds.entries()) {
    const cmapObjId = fontObjToCmapObj.get(fontObjId);
    if (cmapObjId !== undefined && cmapByObjId.has(cmapObjId)) {
      fontCmapByName.set(fontName, cmapByObjId.get(cmapObjId));
    }
  }

  const extractedParts = decompressedStreams
    .map((s) => extractTextFromPdfContentStream(s, fontCmapByName, fallbackCmap))
    .filter(Boolean);

  const cleaned = extractedParts
    .join('\n')
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g, '').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  if (!cleaned || cleaned.length < 10) {
    throw new Error(
      '未能从该 PDF 中提取到可读文字（可能是纯图片扫描版或加密保护的 PDF）。建议直接复制 PDF 中的文字粘贴到下方「粘贴全文」框，或上传 Word (.docx) 版本。'
    );
  }
  return cleaned;
}

const SECTION_PATTERNS = [
  {
    key: 'summary',
    regex:
      /^(?:个人优势|个人简介|自我评价|个人总结|核心优势|求职简介|职业概述|profile|summary|about\s*me)[:：\s]*$/i,
  },
  {
    key: 'skills',
    regex:
      /^(?:专业技能|核心技能|核心能力|核心竞争力|技能清单|技术栈|技能特长|个人技能|掌握技能|专业能力|能力标签|skills|technical\s*skills|core\s*competencies)[:：\s]*$/i,
  },
  {
    key: 'experiences',
    regex:
      /^(?:工作经历|工作经验|职业经历|任职经历|实习经历|实习经验|work\s*experience|experience)[:：\s]*$/i,
  },
  {
    key: 'projects',
    regex: /^(?:项目经历|重点项目|项目经验|代表项目|核心项目|projects?)[:：\s]*$/i,
  },
  {
    key: 'education',
    regex: /^(?:教育背景|教育经历|学历背景|学习经历|education)[:：\s]*$/i,
  },
];

// 常见时间段模式：2021.06 - 2024.06 / 2020..05-2023.08 / 2021年5月 - 至今
const PERIOD_REGEX =
  /((?:19|20)\d{2}(?:[./年-]{1,2}\d{1,2}月?)?\s*(?:-|–|—|~|～|至|到)\s*(?:(?:19|20)\d{2}(?:[./年-]{1,2}\d{1,2}月?)?|至今|现在|Present|Now))/i;

function detectSectionHeading(line) {
  const clean = line.replace(/^[#*\-•·\d.\s【\[]+/, '').replace(/[\]】\s]+$/, '');
  if (!clean || clean.length > 24) return null;
  for (const item of SECTION_PATTERNS) {
    if (item.regex.test(clean)) return item.key;
  }
  return null;
}

function stripBullet(line) {
  return line.replace(/^(?:[•·●▪▸\-*–—]+|\d+[.、)）])\s*/, '').trim();
}

function isBulletLine(line) {
  return /^(?:[•·●▪▸\-*–—]+|\d+[.、)）])\s*/.test(line);
}

/**
 * 解析时间段字符串为可比较的年月区间 { start, end }
 */
function parsePeriodRange(periodStr) {
  const raw = String(periodStr || '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*(?:-|–|—|~|～|至|到)\s*/);
  if (parts.length < 2) return null;

  const parsePoint = (s, isEnd) => {
    const clean = String(s || '').trim();
    if (/^(?:至今|现在|present|now)$/i.test(clean)) return 999912;
    const m = clean.match(/((?:19|20)\d{2})(?:[./年-]{1,2}(\d{1,2}))?/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = m[2] ? Math.min(12, Math.max(1, Number(m[2]))) : isEnd ? 12 : 1;
    return year * 100 + month;
  };

  const start = parsePoint(parts[0], false);
  const end = parsePoint(parts[1], true);
  if (!start || !end) return null;
  return { start, end };
}

function isSubPeriodOf(childPeriod, parentPeriod) {
  const c = parsePeriodRange(childPeriod);
  const p = parsePeriodRange(parentPeriod);
  if (!c || !p) return false;
  // 允许前后 1 个月容差，且子区间不能明显超出父区间
  return c.start >= p.start - 1 && c.end <= p.end + 1;
}

function parseEntryHeader(line, type) {
  const cleanLine = stripBullet(line);
  const periodMatch = cleanLine.match(PERIOD_REGEX);
  const period = periodMatch
    ? periodMatch[1].replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim()
    : '';

  // 支持「个人休整期 2024.06 - 至今（主动调整节奏）：系统复盘与技能升级...」单行冒号说明
  let inlineHighlight = '';
  let headPart = cleanLine;
  const colonIdx = cleanLine.search(/[：:]/);
  if (colonIdx > 0 && cleanLine.length - colonIdx > 14 && type !== 'education') {
    headPart = cleanLine.slice(0, colonIdx).trim();
    inlineHighlight = cleanLine.slice(colonIdx + 1).trim();
  }

  const rest = periodMatch
    ? headPart
        .replace(periodMatch[0], ' | ')
        .replace(/^\s*[|｜/·\-—]+\s*|\s*[|｜/·\-—]+\s*$/g, '')
        .trim()
    : headPart.trim();

  // 同时支持全角空格(\u3000)、竖线、斜杠、连续空格分隔公司与职位
  const tokens = rest
    .split(/\s*(?:\||｜|——|--|\u3000|\s{2,})\s*/)
    .map((s) => s.replace(/^[（(]|[）)]$/g, '').trim())
    .filter(Boolean);

  if (type === 'education') {
    const school = tokens[0] || rest;
    const degree = tokens.slice(1).join(' · ');
    return { school, degree, period };
  }

  if (type === 'projects') {
    return {
      name: tokens[0] || rest,
      role: tokens.slice(1).join(' / '),
      period,
      highlights: inlineHighlight ? [inlineHighlight] : [],
    };
  }

  return {
    company: tokens[0] || rest,
    role: tokens.slice(1).join(' / '),
    period,
    highlights: inlineHighlight ? [inlineHighlight] : [],
    subProjects: [],
  };
}

/**
 * 识别“同一家公司下挂多段品牌/子项目”的层级关系
 * 例如：父公司 2021.06 - 2024.06（自身无独立要点）+ 紧随其后的子项目 2022.06 - 2024.06 / 2021.06 - 2022.05
 */
function groupNestedSubProjects(experiences) {
  const grouped = [];

  for (const exp of experiences) {
    const prev = grouped[grouped.length - 1];
    const looksLikeGapOrCompany =
      /(?:有限公司|科技|集团|股份|网络|信息|休整期|空窗期)/.test(exp.company);

    if (
      prev &&
      prev.period &&
      exp.period &&
      prev.highlights.length === 0 &&
      !looksLikeGapOrCompany &&
      isSubPeriodOf(exp.period, prev.period)
    ) {
      prev.subProjects.push({
        name: exp.company,
        role: exp.role,
        period: exp.period,
        highlights: exp.highlights,
      });
      continue;
    }

    grouped.push(exp);
  }

  return grouped;
}

function parseTimelineEntries(lines, type) {
  const entries = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const hasPeriod = PERIOD_REGEX.test(line);
    const bullet = isBulletLine(line);
    const isGapLine = /^(?:[•·●▪▸\-*]\s*)?(?:个人休整期|职业空窗期|休整期)/.test(line);

    if ((hasPeriod && !bullet && line.length <= 100) || (hasPeriod && isGapLine)) {
      current = parseEntryHeader(line, type);
      entries.push(current);
      continue;
    }

    if (!current) {
      current = parseEntryHeader(line, type);
      entries.push(current);
      continue;
    }

    const cleaned = stripBullet(line);
    if (!cleaned) continue;

    if (
      type !== 'education' &&
      !current.role &&
      current.highlights.length === 0 &&
      !bullet &&
      cleaned.length <= 24 &&
      !/[。；;，,：:]/.test(cleaned)
    ) {
      current.role = cleaned;
    } else if (type === 'education') {
      if (!current.degree) {
        current.degree = cleaned;
      } else {
        entries.push(parseEntryHeader(cleaned, type));
        current = entries[entries.length - 1];
      }
    } else {
      current.highlights.push(cleaned);
    }
  }

  return type === 'experiences' ? groupNestedSubProjects(entries) : entries;
}

/**
 * 纯本地中文简历文本结构化拆解（支持公司嵌套子项目、基本信息栏、个人优势分条、隐私自动剔除）
 */
export function parseResumeTextToMaster(rawText) {
  const originalLines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const detectedContacts = {
    phone: '',
    email: '',
  };
  const warnings = [];

  const phoneMatch = String(rawText || '').match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  if (phoneMatch) detectedContacts.phone = phoneMatch[0];
  const emailMatch = String(rawText || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (emailMatch) detectedContacts.email = emailMatch[0];

  // 仅在真正命中手机/邮箱/微信/身份证时才剔除并计数，不误伤行首项目符号
  const filteredLines = [];
  let strippedPrivacyCount = 0;
  const privacyPatterns = [
    /(?:电话|手机|Tel|Phone)[:：\s]*1[3-9]\d{9}/gi,
    /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    /(?:邮箱|Email|Mail)[:：\s]*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    /(?<!\d)\d{17}[\dXx](?!\d)/g,
    /(?:微信|WeChat)[:：\s]*[A-Za-z0-9_-]{4,}/gi,
  ];

  for (const line of originalLines) {
    let cleaned = line;
    let lineHit = false;
    for (const pat of privacyPatterns) {
      if (pat.test(cleaned)) {
        lineHit = true;
        cleaned = cleaned.replace(pat, '');
      }
      pat.lastIndex = 0;
    }
    if (lineHit) {
      strippedPrivacyCount += 1;
      cleaned = cleaned
        .replace(/\s*[|｜]\s*(?:[|｜]\s*)+/g, ' ｜ ')
        .replace(/^[\s|｜/]+|[\s|｜/]+$/g, '')
        .trim();
    }
    if (cleaned) filteredLines.push(cleaned);
  }

  if (strippedPrivacyCount > 0) {
    warnings.push(
      `已自动从导入正文中剔除 ${strippedPrivacyCount} 处手机号/邮箱/微信等隐私信息（真实联系方式请在「隐私与 AI 设置」中统一维护）。`
    );
  }

  const buckets = {
    header: [],
    summary: [],
    skills: [],
    experiences: [],
    projects: [],
    education: [],
  };

  let activeSection = 'header';
  for (const line of filteredLines) {
    const heading = detectSectionHeading(line);
    if (heading) {
      activeSection = heading;
      continue;
    }
    buckets[activeSection].push(line);
  }

  // 解析头部信息：区分真实姓名（跳过）、一句话基本信息栏、求职方向标题
  let headline = '';
  let basicInfo = '';
  const extraSummary = [];

  for (const line of buckets.header) {
    if (/^(?:个人简历|简历|resume)$/i.test(line)) continue;

    // 跳过疑似真实姓名（2~4位纯汉字）
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(line)) {
      warnings.push(
        `检测到顶部疑似真实姓名「${line}」，已跳过未写入主简历（真实姓名请在「隐私与 AI 设置」维护）。`
      );
      continue;
    }

    // 优先提取「求职方向 / 求职意向 / 期望职位」
    const intentMatch = line.match(
      /(?:求职方向|求职意向|期望职位|期望方向|目标岗位|意向岗位|应聘职位)[:：\s]*([^|｜]+)/
    );
    if (intentMatch && !headline) {
      headline = intentMatch[1].trim();
      continue;
    }

    // 识别一句话基本信息栏（性别/年龄/学历/经验年限）
    if (
      !basicInfo &&
      /(?:\d+\s*岁|大专|本科|硕士|博士|\d+\s*年.*经验|男|女)/.test(line) &&
      line.length <= 60
    ) {
      basicInfo = line;
      continue;
    }

    if (!headline && line.length >= 4 && line.length <= 40) {
      headline = line;
    } else if (line.length > 18) {
      extraSummary.push(line);
    }
  }

  const summaryLines = (buckets.summary.length ? buckets.summary : extraSummary)
    .map(stripBullet)
    .filter(Boolean);
  const summary = summaryLines.join('\n');

  const skills = buckets.skills
    .map(stripBullet)
    .flatMap((line) => (line.length > 90 ? line.split(/[；;]/).map((s) => s.trim()) : [line]))
    .filter(Boolean);

  const experiences = parseTimelineEntries(buckets.experiences, 'experiences');
  const projects = parseTimelineEntries(buckets.projects, 'projects');
  const education = parseTimelineEntries(buckets.education, 'education');

  if (
    !skills.length &&
    !experiences.length &&
    !projects.length &&
    !education.length &&
    filteredLines.length > 0
  ) {
    warnings.push(
      '未能自动识别常见中文简历板块标题（如「工作经历」「核心能力」「教育背景」），已将正文暂存到「个人优势总结」，你可手动整理或点击「导出脱敏整理包（模式 B）」让 Antigravity 精准拆分。'
    );
    return {
      resume: normalizeMasterResume({
        headline: headline || '待补充求职定位',
        basicInfo,
        summary: filteredLines.join('\n'),
      }),
      warnings,
      detectedContacts,
    };
  }

  return {
    resume: normalizeMasterResume({
      headline,
      basicInfo,
      summary,
      skills,
      experiences,
      projects,
      education,
    }),
    warnings,
    detectedContacts,
  };
}

/**
 * 统一入口：支持上传文件（.pdf / .docx / .txt / .md / .json）或直接粘贴文本
 */
export function parseUploadedResume({ filename = '', contentBase64 = '', rawText = '' }) {
  const lowerName = String(filename || '').toLowerCase();
  let extractedText = String(rawText || '').trim();

  if (contentBase64) {
    const buffer = Buffer.from(contentBase64, 'base64');
    if (lowerName.endsWith('.pdf')) {
      extractedText = extractTextFromPdfBuffer(buffer);
    } else if (lowerName.endsWith('.doc')) {
      throw new Error(
        '暂不支持老版二进制 .doc 格式，请先在 Word/WPS 中另存为 .docx 或 .pdf 再上传，或直接复制正文粘贴导入。'
      );
    } else if (lowerName.endsWith('.docx')) {
      extractedText = extractTextFromDocxBuffer(buffer);
    } else if (lowerName.endsWith('.json')) {
      const parsed = JSON.parse(buffer.toString('utf8'));
      return {
        resume: normalizeMasterResume(parsed),
        rawText: JSON.stringify(parsed, null, 2),
        warnings: ['已直接导入 JSON 主简历，请在下方表单核对后点击「保存主简历」。'],
        detectedContacts: { phone: '', email: '' },
      };
    } else {
      extractedText = buffer.toString('utf8');
    }
  }

  if (!extractedText) {
    throw new Error('未读取到有效的简历文本内容，请检查文件内容或重新粘贴。');
  }

  if (extractedText.startsWith('{') && extractedText.endsWith('}')) {
    try {
      const maybeJson = JSON.parse(extractedText);
      if (
        maybeJson &&
        typeof maybeJson === 'object' &&
        ('experiences' in maybeJson || 'skills' in maybeJson || 'headline' in maybeJson)
      ) {
        return {
          resume: normalizeMasterResume(maybeJson),
          rawText: extractedText,
          warnings: ['检测到标准主简历 JSON，已直接填入表单，核对后点击「保存主简历」即可。'],
          detectedContacts: { phone: '', email: '' },
        };
      }
    } catch {
      // 不是合法 JSON，继续按纯文本拆解
    }
  }

  const parsed = parseResumeTextToMaster(extractedText);
  return {
    ...parsed,
    rawText: extractedText,
  };
}

/**
 * 模式 B：将原始简历文本本地脱敏后导出为 Antigravity 整理任务包
 */
export function exportResumeParseCollabTask(rawText) {
  const cleanRaw = String(rawText || '').trim();
  if (!cleanRaw) {
    throw new Error('请先上传 .docx/.txt 简历或粘贴简历全文，再导出脱敏整理任务包。');
  }

  ensureDataDirs();
  const profile = loadPrivateProfile();
  const sanitized = sanitizeText(cleanRaw, profile);

  const taskPath = path.join(PATHS.tasksDir, 'task_parse_resume.md');
  const resultPath = path.join(PATHS.tasksDir, 'result_parse_resume.json');

  const systemInstruction = `你是严谨的中文简历结构化整理专家。
请将以下已脱敏的个人简历原文整理为标准的主简历 JSON，遵守以下铁律：
1. 100% 忠实于原文事实，严禁虚构任何经历、项目、技能或数据；可做适度分段与条理化整理。
2. 严禁包含真实姓名、手机号、邮箱、微信号等个人联系方式；保留输入中的脱敏占位符（如 {{SENSITIVE_1}}）。
3. 如果候选人在同一家公司负责过多个品牌或子项目，务必放在该公司的 experiences[].subProjects 数组中，不要拆成多家独立公司。
4. 只输出合法的纯 JSON 对象（不要用 Markdown 代码块包裹，不要额外解释），字段严格如下：
{
  "headline": "求职方向标题（如：高级产品经理 / 后端架构师 / 运营负责人）",
  "basicInfo": "一句话基本信息（如：本科 ｜ 5年互联网行业经验，不含姓名和联系方式）",
  "summary": "个人优势要点（多条请用 \\n 换行分隔，每条精炼带数据）",
  "skills": ["类别1：技能A｜技能B｜技能C", "类别2：技能D｜技能E"],
  "experiences": [
    {
      "company": "公司名称",
      "role": "总职位",
      "period": "在职时间段",
      "highlights": ["公司级通用职责或成果要点，若全部按子项目展开可为空数组"],
      "subProjects": [
        {
          "name": "该公司下负责的品牌或子项目名称",
          "role": "项目角色/职位",
          "period": "项目时间段",
          "highlights": ["项目具体成果要点1", "项目具体成果要点2"]
        }
      ]
    }
  ],
  "projects": [
    {
      "name": "独立重点项目名称（若已放在公司 subProjects 下则无需重复）",
      "role": "角色",
      "period": "时间段",
      "highlights": ["项目亮点1"]
    }
  ],
  "education": [
    { "school": "学校", "degree": "学历与专业", "period": "时间段" }
  ]
}`;

  const userPrompt = `请将以下脱敏简历文本整理为上述标准 JSON：\n\n${sanitized.sanitizedText}`;

  const content = `# 脱敏主简历整理任务（模式 B）

> 本文件已经过本地隐私脱敏（命中替换 ${sanitized.replacementsCount} 处：${sanitized.hitFields.join('、') || '无敏感命中'}），不含真实手机号、邮箱与微信号。
> 你可以直接把此文件路径发给 Antigravity，让其整理并保存标准 JSON 到：\`${resultPath}\`

## 任务指令
${systemInstruction}

## 脱敏简历原文
${userPrompt}
`;

  fs.writeFileSync(taskPath, content, 'utf8');

  addAuditLog({
    jobId: null,
    mode: 'collab',
    provider: 'local-collab-resume-parse',
    replacementsCount: sanitized.replacementsCount,
    hitFields: sanitized.hitFields,
    sanitizedPreview: sanitized.sanitizedText,
  });

  return {
    mode: 'collab',
    taskPath,
    expectedResultPath: resultPath,
    promptText: `${systemInstruction}\n\n${userPrompt}`,
    privacyReport: {
      replacementsCount: sanitized.replacementsCount,
      hitFields: sanitized.hitFields,
    },
  };
}

function extractJsonObject(rawText) {
  const trimmed = String(rawText || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      return JSON.parse(fenced[1].trim());
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('整理结果无法解析为合法 JSON，请检查格式。');
  }
}

/**
 * 模式 B：读取 result_parse_resume.json 或粘贴 JSON，本地还原并保存为主简历
 */
export function importResumeParseCollabResult(jsonTextOrObj = null, { persist = true } = {}) {
  const resultPath = path.join(PATHS.tasksDir, 'result_parse_resume.json');
  let payload = jsonTextOrObj;
  if (!payload) {
    if (!fs.existsSync(resultPath)) {
      throw new Error(
        `未找到整理结果文件：${resultPath}，请先让 Antigravity 写入该文件或直接粘贴 JSON。`
      );
    }
    payload = fs.readFileSync(resultPath, 'utf8');
  }

  const parsed = typeof payload === 'string' ? extractJsonObject(payload) : payload;
  const profile = loadPrivateProfile();
  const companyOnlyProfile = {
    name: '',
    phone: '',
    email: '',
    wechat: '',
    extraSensitiveWords: profile.extraSensitiveWords || [],
  };
  const restored = restoreObjectDeep(parsed, companyOnlyProfile);
  const normalized = normalizeMasterResume(restored);

  if (persist) {
    saveMasterResume(normalized);
  }
  return normalized;
}

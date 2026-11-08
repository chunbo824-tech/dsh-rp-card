// 材料导入与切分：编码判定、归一化、按类型切分、块大小校正。
// 纯逻辑为主，IO 只在 registerSource / readSource 中出现。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SOURCE_KINDS = ['novel', 'screenplay', 'setting-book', 'game-script'];

export const PRESETS = {
  novel: [/^第[零一二三四五六七八九十百千万0-9]{1,10}[章回卷节部篇][^\n]{0,40}$/m, /^Chapter\s+\d+[^\n]{0,40}$/m],
  screenplay: [/^第[零一二三四五六七八九十百0-9]{1,6}集[^\n]{0,40}$/m, /^(?:Episode|EP)\s*\d+[^\n]{0,40}$/m],
  scene: [/^第?[0-9一二三四五六七八九十]{1,4}场[^\n]{0,40}$/m, /^(?:INT|EXT)\.\s*[^\n]{0,60}$/m],
  'setting-book': [/^#{1,3}\s+[^\n]{1,40}$/m, /^【[^】\n]{1,30}】/m],
  'game-script': [/^第[零一二三四五六七八九十百0-9]{1,10}[章回节][^\n]{0,40}$/m, /^(?:任务|Quest)\s*[:：]\s*[^\n]{1,30}$/m],
};

export const DEFAULT_OPTIONS = { maxChars: 15000, minChars: 500, sceneFallback: true };

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

function scoreText(text) {
  if (!text) return -1;
  const sample = text.slice(0, 4000);
  let cjk = 0;
  let bad = 0;
  for (const ch of sample) {
    if (CJK.test(ch)) cjk++;
    if (ch === '\uFFFD') bad++;
  }
  return (cjk - bad * 5) / Math.max(1, sample.length);
}

export function decodeText(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf ?? ''), 'utf8');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', text: buf.toString('utf8').replace(/^\uFEFF/, '') };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(buf) };
  }
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(buf) };
  }
  let best = null;
  for (const enc of ['utf-8', 'gb18030', 'big5']) {
    try {
      const text = new TextDecoder(enc, { fatal: true }).decode(buf);
      const score = scoreText(text);
      if (!best || score > best.score) best = { encoding: enc, text, score };
    } catch {
      // 该编码解不出，试下一个
    }
  }
  if (best) return { encoding: best.encoding, text: best.text };
  return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(buf) };
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ');
}

function findHeads(text, regexes) {
  const hits = [];
  for (const re of regexes) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(text))) {
      hits.push({ index: m.index, title: m[0].trim().slice(0, 60) });
      if (m.index === g.lastIndex) g.lastIndex++;
    }
    if (hits.length) break;
  }
  return hits.sort((a, b) => a.index - b.index);
}

function sliceByHeads(text, heads) {
  if (!heads.length) return [{ title: '', text }];
  const parts = [];
  if (heads[0].index > 0) {
    const lead = text.slice(0, heads[0].index);
    if (lead.trim()) parts.push({ title: '（前言）', text: lead });
  }
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    parts.push({ title: heads[i].title, text: text.slice(start, end) });
  }
  return parts;
}

function hardSplit(text, maxChars) {
  const out = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf('。', maxChars);
    if (cut < maxChars * 0.4) cut = maxChars - 1;
    if (cut > maxChars - 1) cut = maxChars - 1;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

function enforceMax(parts, maxChars) {
  const out = [];
  for (const p of parts) {
    if (p.text.length <= maxChars) { out.push(p); continue; }
    const pieces = hardSplit(p.text, maxChars);
    pieces.forEach((t, i) => out.push({ title: pieces.length > 1 ? `${p.title}（${i + 1}）` : p.title, text: t }));
  }
  return out;
}

function mergeSmall(parts, minChars) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    const titled = Boolean(p.title && p.title !== '（前言）');
    if (!titled && last && p.text.length < minChars && last.text.length + p.text.length <= 15000) {
      last.text += '\n' + p.text;
      if (!last.title) last.title = p.title;
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

export function splitText(text, kind = 'novel', opts = {}) {
  const { maxChars, minChars, sceneFallback } = { ...DEFAULT_OPTIONS, ...opts };
  const src = normalizeText(text);
  if (!src.trim()) return { units: [], stats: { count: 0, chars: 0, kind } };

  const preset = PRESETS[kind] || PRESETS.novel;
  let parts = sliceByHeads(src, findHeads(src, preset));

  // 剧本：单集超上限时按场再切
  if (kind === 'screenplay' && sceneFallback) {
    const next = [];
    for (const p of parts) {
      if (p.text.length <= maxChars) { next.push(p); continue; }
      const scenes = sliceByHeads(p.text, findHeads(p.text, PRESETS.scene));
      for (const s of scenes) next.push({ title: `${p.title} ${s.title}`.trim(), text: s.text });
    }
    parts = next;
  }

  parts = mergeSmall(enforceMax(parts, maxChars), minChars);

  const units = [];
  let cursor = 0;
  parts.forEach((p, i) => {
    let start = src.indexOf(p.text, cursor);
    if (start < 0) start = cursor;
    cursor = start + p.text.length;
    units.push({
      id: `u${String(i + 1).padStart(6, '0')}`,
      index: i,
      title: p.title,
      start,
      end: start + p.text.length,
      chars: p.text.length,
    });
  });

  return {
    units,
    stats: {
      count: units.length,
      chars: src.length,
      kind,
      oversized: units.filter((u) => u.chars > maxChars).length,
      smallest: units.reduce((a, u) => Math.min(a, u.chars), Number.MAX_SAFE_INTEGER) === Number.MAX_SAFE_INTEGER ? 0 : units.reduce((a, u) => Math.min(a, u.chars), 1e9),
    },
  };
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function libraryDir(projectDir) {
  return path.join(projectDir, '.card-build', 'library');
}

export function sourcesDir(projectDir) {
  return path.join(libraryDir(projectDir), 'sources');
}

export function registerSource(projectDir, { id, kind = 'novel', title = '', realm = 'unknown', continuity = '', edition = '', phase = null, buffer, text, filePath }) {
  if (!id) throw new Error('registerSource 需要 id');
  if (!SOURCE_KINDS.includes(kind)) throw new Error(`未知材料类型：${kind}`);
  const raw = buffer
    ? Buffer.from(buffer)
    : filePath
      ? fs.readFileSync(filePath)
      : Buffer.from(String(text ?? ''), 'utf8');
  const decoded = decodeText(raw);
  const normalized = normalizeText(text ?? decoded.text);
  const dir = sourcesDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });

  const textFile = path.join(dir, `${id}.txt`);
  fs.writeFileSync(textFile, normalized, 'utf8');

  const split = splitText(normalized, kind);
  const meta = {
    id,
    kind,
    title: title || path.basename(filePath || id),
    realm,
    continuity,
    edition,
    phase,
    encoding: decoded.encoding,
    file: path.basename(textFile),
    file_sha256: sha256(normalized),
    chars: normalized.length,
    units: split.units,
    stats: split.stats,
    registered_from: filePath || 'inline',
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta;
}

export function readSource(projectDir, id) {
  const dir = sourcesDir(projectDir);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  const text = fs.readFileSync(path.join(dir, meta.file), 'utf8');
  return { meta, text };
}

export function readUnitText(projectDir, sourceId, unitId) {
  const { meta, text } = readSource(projectDir, sourceId);
  const unit = (meta.units || []).find((u) => u.id === unitId);
  if (!unit) return null;
  return text.slice(unit.start, unit.end);
}

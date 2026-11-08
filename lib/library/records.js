// 资料条目：序列化、读写、哈希保护、索引重建、证据校验。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readSource } from './sources.js';

export const RECORD_MARK = '<!-- library-record:v1 -->';
const FENCE = '`'.repeat(3);
export const RECORD_KINDS = ['character', 'place', 'faction', 'rule', 'event', 'relationship', 'item', 'visual', 'question'];
export const STATUSES = ['confirmed', 'inference', 'uncertain'];
export const REALMS = ['canon', 'reference', 'fanon', 'unknown'];

const META_KEYS = ['id', 'kind', 'name', 'aliases', 'realm', 'continuity', 'known_from', 'status', 'evidence', 'conflict', 'base_sha256'];

export function recordsDir(projectDir) {
  return path.join(projectDir, '.card-build', 'library', 'records');
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function digestOfFileText(text) {
  return sha256(text.replace(/"base_sha256":\s*"[^"]*"/, '"base_sha256":""'));
}

export function serializeRecord(record) {
  const meta = {};
  for (const k of META_KEYS) {
    if (record[k] !== undefined) meta[k] = record[k];
  }
  if (!meta.aliases) meta.aliases = [];
  if (!meta.evidence) meta.evidence = [];
  const body = String(record.body ?? '').replace(/\s+$/, '');
  return [RECORD_MARK, FENCE + 'json', JSON.stringify(meta, null, 2), FENCE, '', body, ''].join('\n');
}

export function parseRecord(text) {
  const src = String(text ?? '');
  if (!src.includes(RECORD_MARK)) throw new Error('不是合法的资料条目（缺少 library-record:v1 标记）');
  const first = src.indexOf(FENCE + 'json');
  if (first < 0) throw new Error('资料条目缺少 JSON 元数据块');
  const jsonStart = src.indexOf('\n', first) + 1;
  const jsonEnd = src.indexOf('\n' + FENCE, jsonStart);
  if (jsonEnd < 0) throw new Error('资料条目 JSON 块未闭合');
  const meta = JSON.parse(src.slice(jsonStart, jsonEnd));
  const bodyStart = src.indexOf('\n', jsonEnd + FENCE.length + 1) + 1;
  const body = bodyStart > 0 ? src.slice(bodyStart).replace(/^\n+/, '') : '';
  return { ...meta, body: body.replace(/\s+$/, '') };
}

export function recordPath(projectDir, id) {
  return path.join(recordsDir(projectDir), `${id}.md`);
}

export function readRecord(projectDir, id) {
  const p = recordPath(projectDir, id);
  if (!fs.existsSync(p)) return null;
  return parseRecord(fs.readFileSync(p, 'utf8'));
}

export function listRecords(projectDir) {
  const dir = recordsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseRecord(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function normalizeRecord(record) {
  const out = { ...record };
  if (!out.id || !/^[a-z0-9_-]+$/.test(out.id)) {
    throw new Error(`条目 id 只能是小写字母/数字/短横线/下划线：${out.id}`);
  }
  if (!RECORD_KINDS.includes(out.kind)) throw new Error(`未知条目类型：${out.kind}`);
  if (out.status && !STATUSES.includes(out.status)) throw new Error(`未知确定性：${out.status}`);
  if (out.realm && !REALMS.includes(out.realm)) throw new Error(`未知来源身份：${out.realm}`);
  if (!Array.isArray(out.aliases)) out.aliases = [];
  if (!Array.isArray(out.evidence)) out.evidence = [];
  if (out.known_from === undefined) out.known_from = null;
  return out;
}

export function writeRecord(projectDir, record) {
  const rec = normalizeRecord(record);
  const p = recordPath(projectDir, rec.id);
  const exists = fs.existsSync(p);
  if (exists) {
    const current = fs.readFileSync(p, 'utf8');
    if (!rec.base_sha256) {
      const err = new Error(`条目 ${rec.id} 已存在，修改时必须提供 base_sha256（当前 ${digestOfFileText(current).slice(0, 12)}…），避免覆盖人工修改`);
      err.code = 'LIB011';
      throw err;
    }
    if (rec.base_sha256 !== digestOfFileText(current)) {
      const err = new Error(`条目 ${rec.id} 已被修改（base_sha256 不匹配），本次写入已停止；请先读回当前文件再合并`);
      err.code = 'LIB012';
      throw err;
    }
  }
  const serialized = serializeRecord({ ...rec, base_sha256: '' });
  const final = serializeRecord({ ...rec, base_sha256: digestOfFileText(serialized) });
  fs.mkdirSync(recordsDir(projectDir), { recursive: true });
  fs.writeFileSync(p, final, 'utf8');
  return { id: rec.id, path: p, sha256: digestOfFileText(final) };
}

export function rebuildIndex(projectDir) {
  const records = listRecords(projectDir);
  const dir = path.join(projectDir, '.card-build', 'library');
  fs.mkdirSync(dir, { recursive: true });
  const lines = records.map((r) =>
    JSON.stringify({
      id: r.id,
      kind: r.kind,
      name: r.name,
      aliases: r.aliases || [],
      realm: r.realm || 'unknown',
      continuity: r.continuity || '',
      known_from: r.known_from ?? null,
      status: r.status || 'inference',
      chars: String(r.body || '').length,
      conflict: Boolean(r.conflict),
    }),
  );
  const file = path.join(dir, 'index.jsonl');
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return { file, count: lines.length };
}

/**
 * 证据校验：每条证据必须能在来源单元里逐字找到。
 * 兼容两种定位：start 为全文位置，或仅给 quote。
 */
export function verifyEvidence(projectDir, record) {
  const problems = [];
  const evs = record.evidence || [];
  if (!evs.length) return [{ code: 'LIB001', message: `条目 ${record.id} 没有任何原文证据` }];

  for (const ev of evs) {
    const { source_id: sourceId, unit_id: unitId, quote } = ev || {};
    if (!sourceId || !unitId || !quote) {
      problems.push({ code: 'LIB001', message: `条目 ${record.id} 的证据缺少 source_id / unit_id / quote` });
      continue;
    }
    let src;
    try {
      src = readSource(projectDir, sourceId);
    } catch {
      problems.push({ code: 'LIB001', message: `条目 ${record.id} 引用了不存在的来源 ${sourceId}` });
      continue;
    }
    const unit = (src.meta.units || []).find((u) => u.id === unitId);
    if (!unit) {
      problems.push({ code: 'LIB001', message: `条目 ${record.id} 引用了不存在的单元 ${sourceId}/${unitId}` });
      continue;
    }
    const unitText = src.text.slice(unit.start, unit.end);
    const at = unitText.indexOf(quote);
    if (at < 0) {
      problems.push({
        code: 'LIB001',
        message: `条目 ${record.id} 的引文在 ${sourceId}/${unitId} 中找不到：${String(quote).slice(0, 20)}…`,
      });
      continue;
    }
    if (typeof ev.start === 'number' && ev.start >= unit.start && ev.start < unit.end) {
      if (!src.text.startsWith(quote, ev.start)) {
        problems.push({ code: 'LIB001', message: `条目 ${record.id} 的引文位置与 start 不符（${sourceId}/${unitId}）` });
      }
    }
  }
  return problems;
}

export function unresolvedConflicts(projectDir) {
  return listRecords(projectDir).filter((r) => r.conflict);
}

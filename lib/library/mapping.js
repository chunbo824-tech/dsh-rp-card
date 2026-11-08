// 资料条目 → 世界书条目：内容拼装、锚点生成、阶段前缀、平台字段默认值。
const TRIGGER_BY_KIND = {
  character: '内容锚',
  place: '内容锚',
  faction: '内容锚',
  event: '内容锚',
  item: '内容锚',
  relationship: '内容锚',
  rule: '常驻或格式字段锚',
  question: '条件触发',
  visual: '不进世界书',
};

export const PLATFORM_DEFAULTS = {
  sort: 0,
  depth: 0,
  probability: 100,
  value_region: 1,
  key_region: 6,
  value_type: 0,
  match_type: 2,
  enable: true,
};

export function entryContent(record) {
  const head = record.name ? `【${record.name}】\n` : '';
  return head + String(record.body || '').trim();
}

export function anchorsOf(record, limit = 8) {
  const raw = [record.name, ...(record.aliases || [])].filter(Boolean).map((s) => String(s).trim());
  const seen = new Set();
  const out = [];
  for (const a of raw) {
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

export function triggerOf(record) {
  return TRIGGER_BY_KIND[record.kind] || '内容锚';
}

export function toPlatformEntry(record, { key, content } = {}) {
  return {
    content: content ?? entryContent(record),
    key: key ?? anchorsOf(record),
    ...PLATFORM_DEFAULTS,
  };
}

const LATE_PREFIX = '（此信息此刻尚不可知；仅当剧情推进到相应阶段后再使用）\n';

/**
 * 按方案生成世界书条目。
 * 只有 resident 与 conditional 进世界书；background / visual 不进。
 * 阶段晚于开局的条目补一句「尚不可知」前缀。
 */
export function buildEntries(plan, records = [], { startPhase = 0 } = {}) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const entries = [];
  const meta = [];
  const skipped = [];

  const push = (item, bucket) => {
    const rec = byId.get(item.id);
    if (!rec) { skipped.push({ id: item.id, reason: '条目已删除' }); return; }
    const gated = !(rec.known_from === null || rec.known_from === undefined || Number(rec.known_from) <= Number(startPhase));
    const content = (gated ? LATE_PREFIX : '') + entryContent(rec);
    const key = anchorsOf(rec);
    if (!key.length) { skipped.push({ id: rec.id, reason: '没有可用锚点' }); return; }
    entries.push(toPlatformEntry(rec, { key, content }));
    meta.push({
      id: rec.id,
      name: rec.name,
      kind: rec.kind,
      bucket,
      trigger: triggerOf(rec),
      gated,
      chars: content.length,
      key,
    });
  };

  for (const item of plan.resident || []) push(item, 'resident');
  for (const item of plan.conditional || []) push(item, 'conditional');
  for (const item of plan.background || []) skipped.push({ id: item.id, reason: item.reason || '只做背景' });
  for (const item of plan.visual || []) skipped.push({ id: item.id, reason: '视觉参考，不进世界书' });

  return {
    entries,
    meta,
    skipped,
    usage: {
      entryCount: entries.length,
      residentChars: meta.filter((m) => m.bucket === 'resident').reduce((a, m) => a + m.chars, 0),
      conditionalChars: meta.filter((m) => m.bucket === 'conditional').reduce((a, m) => a + m.chars, 0),
    },
  };
}

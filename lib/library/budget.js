// 预算与两套取舍方案：复杂度判定、常驻/触发/背景分流、降级顺序。
export const PROFILES = {
  simple: { id: 'simple', label: '简单卡', total: 800, entry: 600 },
  complex: { id: 'complex', label: '复杂卡', total: 1600, entry: 900 },
};

export const SCHEMES = {
  A: { id: 'A', name: '沉浸优先', residentShare: 0.7, note: '常驻占约 70% 预算，世界感强，触发条目少而精' },
  B: { id: 'B', name: '轻量优先', residentShare: 0.4, note: '常驻占约 40% 预算，保留更多触发条目，token 更省' },
};

// 常驻优先顺序：规则 → 人物 → 势力 → 地点 → 事件 → 关系 → 物品
const PRIORITY = { rule: 0, character: 1, faction: 2, place: 3, event: 4, relationship: 5, item: 6, question: 9, visual: 99 };

// 超预算时的降级顺序：事件 → 地点 → 人物细节 → 规则细化（核心规则与主要人物不降级）
const DOWNGRADE_ORDER = ['event', 'item', 'place', 'relationship', 'faction', 'character', 'rule'];

export function detectComplexity(records = [], opts = {}) {
  if (opts.complexity === true || opts.complexity === 'complex') return PROFILES.complex;
  if (opts.complexity === false || opts.complexity === 'simple') return PROFILES.simple;
  return records.length >= 24 ? PROFILES.complex : PROFILES.simple;
}

export function recordChars(record) {
  const head = record.name ? `【${record.name}】\n` : '';
  return (head + String(record.body || '')).length;
}

export function phaseAllowed(record, startPhase = 0) {
  const kf = record.known_from;
  if (kf === null || kf === undefined) return true;
  return Number(kf) <= Number(startPhase);
}

function sortByPriority(a, b) {
  const pa = PRIORITY[a.kind] ?? 50;
  const pb = PRIORITY[b.kind] ?? 50;
  if (pa !== pb) return pa - pb;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * 按方案分配：常驻 / 条件触发 / 只做背景 / 视觉参考
 * - uncertain 条目一律不进世界书（进背景，避免把存疑内容当设定）
 * - 未解决冲突条目进背景并在 notes 里点名
 * - visual 条目进视觉清单
 * - 阶段晚于开局的条目只能条件触发
 */
export function allocate(records = [], { scheme = 'A', profile, startPhase = 0 } = {}) {
  const sch = SCHEMES[scheme] || SCHEMES.A;
  const prof = profile || detectComplexity(records);
  const residentBudget = Math.floor(prof.total * sch.residentShare);

  const resident = [];
  const conditional = [];
  const background = [];
  const visual = [];
  const notes = [];
  let used = 0;

  const sorted = [...records].sort(sortByPriority);

  for (const rec of sorted) {
    const chars = recordChars(rec);
    if (rec.kind === 'visual') { visual.push({ id: rec.id, name: rec.name, chars }); continue; }
    if (rec.conflict) {
      background.push({ id: rec.id, name: rec.name, chars, reason: '未解决冲突' });
      notes.push(`条目 ${rec.id} 存在未解决冲突，未进入世界书`);
      continue;
    }
    if (rec.status === 'uncertain') {
      background.push({ id: rec.id, name: rec.name, chars, reason: '确定性存疑' });
      continue;
    }
    const gated = !phaseAllowed(rec, startPhase);
    if (gated) {
      conditional.push({ id: rec.id, name: rec.name, chars, reason: '阶段晚于开局，只能条件触发' });
      continue;
    }
    if (chars > prof.entry) {
      conditional.push({ id: rec.id, name: rec.name, chars, reason: `单条超过 ${prof.entry} 字上限` });
      notes.push(`条目 ${rec.id} 单条 ${chars} 字超过上限 ${prof.entry}，已降为条件触发并需拆分`);
      continue;
    }
    if (used + chars <= residentBudget) {
      resident.push({ id: rec.id, name: rec.name, chars, kind: rec.kind });
      used += chars;
    } else {
      conditional.push({ id: rec.id, name: rec.name, chars, reason: '常驻预算已满' });
    }
  }

  return {
    scheme: sch.id,
    schemeName: sch.name,
    profile: prof.id,
    profileLabel: prof.label,
    residentBudget,
    entriesCap: prof.entry,
    resident,
    conditional,
    background,
    visual,
    usage: {
      residentChars: used,
      residentBudget,
      residentCount: resident.length,
      conditionalCount: conditional.length,
      backgroundCount: background.length,
      visualCount: visual.length,
      overBudget: used > residentBudget,
    },
    notes,
  };
}

/** 超预算时的建议降级顺序（给方案文档用） */
export function downgradePlan(plan) {
  const movable = plan.resident
    .filter((r) => DOWNGRADE_ORDER.includes(r.kind))
    .sort((a, b) => DOWNGRADE_ORDER.indexOf(b.kind) - DOWNGRADE_ORDER.indexOf(a.kind));
  return {
    order: DOWNGRADE_ORDER,
    first: movable.slice(0, 3).map((r) => r.id),
    text: '超预算时按「事件 → 物品 → 地点 → 关系 → 势力 → 人物 → 规则」降级；核心规则与主要人物不降级',
  };
}

import assert from 'node:assert/strict';
import { allocate, PROFILES } from '../lib/library/budget.js';
import { buildEntries, anchorsOf, entryContent, triggerOf, toPlatformEntry, PLATFORM_DEFAULTS } from '../lib/library/mapping.js';

const rec = (id, kind, name, body, extra = {}) => ({
  id, kind, name, body, aliases: [], realm: 'canon', status: 'confirmed', known_from: null, ...extra,
});

const records = [
  rec('rule-1', 'rule', '世界规则', '这个世界有三条铁律。'),
  rec('char-1', 'character', '阿雨', '她经营一家咖啡馆。', { aliases: ['小雨', '阿雨'] }),
  rec('place-1', 'place', '临街咖啡馆', '两层小楼，靠窗四张桌。'),
  rec('late-1', 'character', '神秘客人', '他其实是通缉犯。', { known_from: 3 }),
  rec('v1', 'visual', '雨夜街景', '霓虹被雨打散。'),
];

// 1. 内容拼装
{
  assert.equal(entryContent({ name: '阿雨', body: '正文' }), '【阿雨】\n正文');
}

// 2. 锚点去重与上限
{
  assert.deepEqual(anchorsOf({ name: 'A', aliases: ['A', 'B', 'C'] }), ['A', 'B', 'C']);
  assert.equal(anchorsOf({ name: 'A', aliases: Array.from({ length: 20 }, (_, i) => 'x' + i) }).length, 8);
  assert.deepEqual(anchorsOf({ name: '', aliases: [] }), []);
}

// 3. 触发方式映射
{
  assert.equal(triggerOf({ kind: 'character' }), '内容锚');
  assert.equal(triggerOf({ kind: 'rule' }), '常驻或格式字段锚');
  assert.equal(triggerOf({ kind: 'visual' }), '不进世界书');
  assert.equal(triggerOf({ kind: 'nonsense' }), '内容锚');
}

// 4. 平台字段默认值
{
  const e = toPlatformEntry({ name: '阿雨', body: '正文' });
  for (const [k, v] of Object.entries(PLATFORM_DEFAULTS)) assert.deepEqual(e[k], v, '字段 ' + k);
  assert.deepEqual(e.key, ['阿雨']);
  assert.equal(e.content, '【阿雨】\n正文');
}

// 5. 只把常驻与触发写进世界书
{
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.complex, startPhase: 0 });
  const out = buildEntries(plan, records, { startPhase: 0 });
  const ids = out.meta.map((m) => m.id);
  assert.ok(ids.includes('rule-1'));
  assert.ok(ids.includes('char-1'));
  assert.ok(!ids.includes('v1'), '视觉参考不应进世界书');
  assert.ok(out.skipped.some((s) => s.id === 'v1'));
}

// 6. 阶段晚于开局的条目加提示前缀
{
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.complex, startPhase: 0 });
  const out = buildEntries(plan, records, { startPhase: 0 });
  const late = out.meta.find((m) => m.id === 'late-1');
  assert.equal(late.gated, true);
  const idx = out.meta.indexOf(late);
  assert.match(out.entries[idx].content, /尚不可知/);
}

// 7. 阶段满足时不加前缀
{
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.complex, startPhase: 5 });
  const out = buildEntries(plan, records, { startPhase: 5 });
  const late = out.meta.find((m) => m.id === 'late-1');
  assert.equal(late.gated, false);
  const idx = out.meta.indexOf(late);
  assert.ok(!/尚不可知/.test(out.entries[idx].content));
}

// 8. 无锚点条目被跳过并记录
{
  const r2 = [rec('noanchor', 'character', '', '没有名字也没有别名')];
  const plan = allocate(r2, { scheme: 'A', profile: PROFILES.complex });
  const out = buildEntries(plan, r2, { startPhase: 0 });
  assert.equal(out.entries.length, 0);
  assert.ok(out.skipped.some((s) => /锚点/.test(s.reason)));
}

// 9. 条目被删除时跳过
{
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.complex });
  const out = buildEntries(plan, records.filter((r) => r.id !== 'rule-1'), { startPhase: 0 });
  assert.ok(out.skipped.some((s) => s.id === 'rule-1' && /删除/.test(s.reason)));
}

// 10. 用量统计
{
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.complex });
  const out = buildEntries(plan, records, { startPhase: 0 });
  assert.equal(out.usage.entryCount, out.entries.length);
  assert.ok(out.usage.residentChars > 0);
}

console.log('library mapping tests passed');

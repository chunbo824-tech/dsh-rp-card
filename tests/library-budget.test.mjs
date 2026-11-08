import assert from 'node:assert/strict';
import { allocate, detectComplexity, recordChars, phaseAllowed, downgradePlan, PROFILES, SCHEMES } from '../lib/library/budget.js';

const rec = (id, kind, chars, extra = {}) => ({ id, kind, name: id, body: 'x'.repeat(chars), status: 'confirmed', known_from: null, ...extra });

// 1. 复杂度判定：条目数
{
  assert.equal(detectComplexity(Array.from({ length: 10 }, (_, i) => rec('r' + i, 'place', 100))).id, 'simple');
  assert.equal(detectComplexity(Array.from({ length: 24 }, (_, i) => rec('r' + i, 'place', 100))).id, 'complex');
  assert.equal(detectComplexity([], { complexity: true }).id, 'complex');
  assert.equal(detectComplexity(Array.from({ length: 30 }, (_, i) => rec('r' + i, 'place', 100)), { complexity: false }).id, 'simple');
}

// 2. 字符估算含名称前缀
{
  assert.equal(recordChars({ name: '阿雨', body: '12345' }), '【阿雨】\n12345'.length);
}

// 3. 两套方案预算不同
{
  const records = [rec('rule-1', 'rule', 300), rec('char-1', 'character', 300)];
  const a = allocate(records, { scheme: 'A' });
  const b = allocate(records, { scheme: 'B' });
  assert.equal(a.residentBudget, Math.floor(800 * 0.7));
  assert.equal(b.residentBudget, Math.floor(800 * 0.4));
  assert.equal(SCHEMES.A.residentShare, 0.7);
  assert.equal(SCHEMES.B.residentShare, 0.4);
}

// 4. 常驻按优先级填充，超出转条件触发
{
  const records = [rec('event-1', 'event', 300), rec('rule-1', 'rule', 300), rec('char-1', 'character', 300)];
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.simple });
  // 预算 560：规则 309 + 人物 307 = 616 > 560 → 只有规则常驻
  assert.equal(plan.resident[0].id, 'rule-1');
  assert.ok(plan.conditional.some((c) => c.id === 'char-1'));
  assert.ok(plan.conditional.some((c) => c.id === 'event-1'));
}

// 5. 单条超上限 → 条件触发并提示
{
  const records = [rec('big', 'rule', 700)];
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.simple });
  assert.equal(plan.resident.length, 0);
  assert.match(plan.conditional[0].reason, /单条超过/);
  assert.ok(plan.notes.some((n) => /超过上限/.test(n)));
}

// 6. 阶段晚于开局 → 只能条件触发
{
  const records = [rec('late', 'character', 100, { known_from: 3 })];
  const plan = allocate(records, { scheme: 'A', startPhase: 0 });
  assert.equal(plan.resident.length, 0);
  assert.match(plan.conditional[0].reason, /阶段晚于开局/);
  assert.equal(phaseAllowed({ known_from: 2 }, 3), true);
  assert.equal(phaseAllowed({ known_from: 3 }, 2), false);
  assert.equal(phaseAllowed({ known_from: null }, 0), true);
}

// 7. uncertain → 背景，不进世界书
{
  const plan = allocate([rec('maybe', 'rule', 100, { status: 'uncertain' })], { scheme: 'A' });
  assert.equal(plan.resident.length, 0);
  assert.equal(plan.background[0].reason, '确定性存疑');
}

// 8. 未解决冲突 → 背景并留痕
{
  const plan = allocate([rec('conf', 'character', 100, { conflict: '原作两处矛盾' })], { scheme: 'A' });
  assert.equal(plan.background[0].reason, '未解决冲突');
  assert.ok(plan.notes.some((n) => /冲突/.test(n)));
}

// 9. visual → 视觉清单
{
  const plan = allocate([rec('v1', 'visual', 50)], { scheme: 'A' });
  assert.equal(plan.visual.length, 1);
  assert.equal(plan.resident.length, 0);
}

// 10. 预算用尽后不再常驻，且 usage 正确
{
  const records = [rec('rule-1', 'rule', 300), rec('char-1', 'character', 300), rec('place-1', 'place', 300)];
  const plan = allocate(records, { scheme: 'B', profile: PROFILES.simple });
  assert.ok(plan.usage.residentChars <= plan.usage.residentBudget);
  assert.equal(plan.usage.residentCount, plan.resident.length);
  assert.ok(plan.usage.conditionalCount >= 1);
  assert.equal(plan.usage.overBudget, false);
}

// 11. 复杂档预算更大
{
  const records = [rec('rule-1', 'rule', 300), rec('char-1', 'character', 500), rec('faction-1', 'faction', 400)];
  const simple = allocate(records, { scheme: 'A', profile: PROFILES.simple });
  const complex = allocate(records, { scheme: 'A', profile: PROFILES.complex });
  assert.ok(complex.usage.residentChars >= simple.usage.residentChars);
  assert.equal(complex.residentBudget, Math.floor(1600 * 0.7));
}

// 12. 降级顺序文本与首批候选
{
  const plan = allocate([rec('event-1', 'event', 200), rec('place-1', 'place', 200)], { scheme: 'A', profile: PROFILES.complex });
  const d = downgradePlan(plan);
  assert.match(d.text, /事件/);
  assert.ok(Array.isArray(d.first));
}

console.log('library budget tests passed');

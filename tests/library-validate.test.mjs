import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSource } from '../lib/library/sources.js';
import { writeRecord, readRecord } from '../lib/library/records.js';
import { allocate, PROFILES } from '../lib/library/budget.js';
import { lintLibrary } from '../lib/library/validate.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-val-'));
const text = ['第一章 相遇', '她推门进来，雨水顺着伞骨往下滴。'.repeat(30)].join('\n');
const meta = registerSource(dir, { id: 'novel-a', kind: 'novel', realm: 'canon', text });
const unit0 = meta.units[0].id;
const quote = '她推门进来，雨水顺着伞骨往下滴。';

const ok = (id, kind, name, body, extra = {}) => ({
  id, kind, name, body, aliases: [], realm: 'canon', status: 'confirmed', known_from: null,
  evidence: [{ source_id: 'novel-a', unit_id: unit0, quote }], ...extra,
});

const codes = (ds, code) => ds.filter((d) => d.id === code);

// 1. 干净资料 → 无报错
{
  const records = [ok('rule-1', 'rule', '世界规则', '三条铁律。')];
  const plan = allocate(records, { scheme: 'A', profile: PROFILES.complex, startPhase: 0 });
  const ds = lintLibrary({ projectDir: dir, records, plan, startPhase: 0 });
  assert.deepEqual(ds.map((d) => d.id), []);
}

// 2. LIB001 证据缺失
{
  const records = [ok('char-1', 'character', '阿雨', '设定', { evidence: [] })];
  const ds = lintLibrary({ projectDir: dir, records, plan: null });
  assert.equal(codes(ds, 'LIB001').length, 1);
  assert.match(codes(ds, 'LIB001')[0].message, /原因：/);
  assert.match(codes(ds, 'LIB001')[0].message, /两条路：/);
}

// 3. LIB001 引文对不上
{
  const records = [ok('char-2', 'character', '阿雨', '设定', { evidence: [{ source_id: 'novel-a', unit_id: unit0, quote: '原文没有这句话' }] })];
  const ds = lintLibrary({ projectDir: dir, records, plan: null });
  assert.equal(codes(ds, 'LIB001').length, 1);
}

// 4. LIB002 常驻晚于开局
{
  const records = [ok('late-1', 'character', '神秘人', '其实是通缉犯。', { known_from: 3 })];
  const plan = { resident: [{ id: 'late-1', name: '神秘人', chars: 10 }], conditional: [], background: [], residentBudget: 9999, entriesCap: 900 };
  const ds = lintLibrary({ projectDir: dir, records, plan, startPhase: 0 });
  assert.equal(codes(ds, 'LIB002').length, 1);
  assert.match(codes(ds, 'LIB002')[0].message, /尚不可知/);
}

// 5. LIB003 常驻超预算
{
  const records = [ok('rule-1', 'rule', '世界规则', 'x'.repeat(900))];
  const plan = { resident: [{ id: 'rule-1', name: '世界规则', chars: 900 }], conditional: [], background: [], residentBudget: 500, entriesCap: 2000 };
  const ds = lintLibrary({ projectDir: dir, records, plan });
  assert.equal(codes(ds, 'LIB003').length, 1);
  assert.match(codes(ds, 'LIB003')[0].message, /降为触发/);
}

// 6. LIB003 单条超上限
{
  const records = [ok('rule-2', 'rule', '世界规则', 'x'.repeat(900))];
  const plan = { resident: [], conditional: [{ id: 'rule-2', name: '世界规则', chars: 900 }], background: [], residentBudget: 9999, entriesCap: 600 };
  const ds = lintLibrary({ projectDir: dir, records, plan });
  assert.equal(codes(ds, 'LIB003').length, 1);
  assert.match(codes(ds, 'LIB003')[0].message, /单条/);
}

// 7. LIB004 触发条目无锚点
{
  const records = [ok('noanchor', 'character', '', '没有名字')];
  const plan = { resident: [], conditional: [{ id: 'noanchor', name: '', chars: 10 }], background: [], residentBudget: 9999, entriesCap: 900 };
  const ds = lintLibrary({ projectDir: dir, records, plan });
  assert.equal(codes(ds, 'LIB004').length, 1);
}

// 8. LIB005 视觉参考缺用途 / 缺说明
{
  const ds1 = lintLibrary({ projectDir: dir, records: [], plan: null, visual: [{ id: 'v1' }] });
  assert.equal(codes(ds1, 'LIB005').length, 1);
  const ds2 = lintLibrary({ projectDir: dir, records: [], plan: null, visual: [{ id: 'v2', use: 'chat' }] });
  assert.equal(codes(ds2, 'LIB005').length, 1);
  const ds3 = lintLibrary({ projectDir: dir, records: [], plan: null, visual: [{ id: 'v3', use: 'chat', note: '借雨夜霓虹配色' }] });
  assert.equal(codes(ds3, 'LIB005').length, 0);
}

// 9. LIB006 未解决冲突
{
  const plan = { resident: [], conditional: [], background: [{ id: 'c1', name: 'A', reason: '未解决冲突' }], residentBudget: 9999, entriesCap: 900 };
  const ds = lintLibrary({ projectDir: dir, records: [], plan });
  assert.equal(codes(ds, 'LIB006').length, 1);
}

// 10. LIB007 同人进常驻
{
  const records = [ok('fan-1', 'character', '阿雨', '同人设定', { realm: 'fanon' })];
  const plan = { resident: [{ id: 'fan-1', name: '阿雨', chars: 10 }], conditional: [], background: [], residentBudget: 9999, entriesCap: 900 };
  const ds = lintLibrary({ projectDir: dir, records, plan });
  assert.equal(codes(ds, 'LIB007').length, 1);
}

// 11. 视觉与问题类条目不检查证据
{
  const records = [ok('v-1', 'visual', '街景', '雨夜', { evidence: [] })];
  const ds = lintLibrary({ projectDir: dir, records, plan: null });
  assert.equal(codes(ds, 'LIB001').length, 0);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('library validate tests passed');

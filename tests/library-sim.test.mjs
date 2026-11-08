import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { libraryAction } from '../lib/library/tool.js';
import { readLibraryState } from '../lib/library/state.js';
import { listRecords } from '../lib/library/records.js';

// 模拟真实场景：一份没有场次编号的长剧本，用户只发了材料
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-sim-'));

const blocks = [];
for (let i = 0; i < 12; i++) {
  const body = `场景段落 ${i + 1}：` + `尼奥走进房间，灯管嗡嗡响，特工在走廊尽头。`.repeat(300);
  blocks.push(body);
}
const script = blocks.join('\n\n');
fs.writeFileSync(path.join(dir, 'matrix.txt'), script, 'utf8');

const run = (args) => libraryAction({ out: dir, ...args });

// 1. 导入：无场次标记时应按块切分，且不止一段
{
  const out = run({ action: 'ingest', file: 'matrix.txt', id: 'matrix', kind: 'screenplay', realm: 'canon', continuity: 'film-1999' });
  assert.match(out, /已导入材料 matrix/);
  const unitCount = Number((out.match(/切分：(\d+) 个单元/) || [])[1]);
  assert.ok(unitCount >= 2, '应切出多段，实际 ' + unitCount);
  assert.match(out, /单元清单/);
  assert.equal(readLibraryState(dir).stage, 'P1');
}

// 2. read-unit 能取到具体段落正文
{
  const out = run({ action: 'read-unit', source_id: 'matrix', unit_id: 'u000001' });
  assert.match(out, /matrix\/u000001/);
  assert.match(out, /尼奥走进房间/);
}

// 3. 未确认条目时不能 propose（闸门）
{
  const q = '尼奥走进房间';
  const rec = {
    id: 'char-neo', kind: 'character', name: '尼奥', realm: 'canon', status: 'confirmed', known_from: 0,
    body: '被墨菲斯认定是救世主的人。',
    evidence: [{ source_id: 'matrix', unit_id: 'u000001', quote: q }],
  };
  run({ action: 'commit', records: [rec] });
  assert.throws(() => run({ action: 'propose' }), /条目清单还没确认/);
  assert.throws(() => run({ action: 'write' }), /条目清单还没确认/);
}

// 4. 批量入库 40 条（模拟真实规模），证据逐条可查
{
  const unitId = 'u000001';
  const quote = '尼奥走进房间';
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push({
      id: `rec-${String(i + 1).padStart(3, '0')}`,
      kind: i % 4 === 0 ? 'rule' : i % 4 === 1 ? 'character' : i % 4 === 2 ? 'place' : 'event',
      name: `条目${i + 1}`,
      realm: 'canon',
      status: 'confirmed',
      known_from: i > 35 ? 3 : 0,
      body: `这是第 ${i + 1} 条资料，写一些能进世界书的内容。`,
      evidence: [{ source_id: 'matrix', unit_id: unitId, quote }],
    });
  }
  const out = run({ action: 'commit', records });
  assert.match(out, /入库 40 条/);
  assert.equal(listRecords(dir).length, 41);
  assert.equal(readLibraryState(dir).stage, 'P2');
}

// 5. 确认清单 → 生成两套方案
{
  run({ action: 'confirm', key: 'records' });
  const out = run({ action: 'propose' });
  assert.match(out, /方案对比/);
  assert.match(out, /沉浸优先/);
  assert.match(out, /轻量优先/);
  assert.equal(readLibraryState(dir).stage, 'P3');
  const md = fs.readFileSync(path.join(dir, '.card-build/library/library-proposal.md'), 'utf8');
  assert.match(md, /方案 A · 沉浸优先/);
  assert.match(md, /方案 B · 轻量优先/);
  assert.match(md, /需要你确认/);
}

// 6. 未批准时 write 仍被拦
{
  assert.throws(() => run({ action: 'write' }), /取舍方案还没被批准/);
}

// 7. 批准 A → 写入，且阶段门控生效
{
  run({ action: 'approve', scheme: 'A' });
  const out = run({ action: 'write', scheme: 'A', startPhase: 0 });
  assert.match(out, /已生成世界书条目/);
  assert.match(out, /文件结构/);
  assert.match(out, /前 3 条样例/);

  const wb = JSON.parse(fs.readFileSync(path.join(dir, '.card-build/library/wb-entries.json'), 'utf8'));
  assert.ok(wb.entries.length > 0);
  assert.ok(wb.meta.length === wb.entries.length);
  // 后期条目应带「尚不可知」前缀
  const late = wb.meta.find((m) => m.gated);
  assert.ok(late, '应存在被阶段门控的条目');
  const idx = wb.meta.indexOf(late);
  assert.match(wb.entries[idx].content, /尚不可知/);
  // 平台字段
  for (const e of wb.entries) {
    assert.equal(e.key_region, 6);
    assert.equal(e.value_region, 1);
    assert.equal(e.depth, 0);
    assert.equal(e.probability, 100);
  }
  assert.ok(['P4', 'P5'].includes(readLibraryState(dir).stage));
}

// 8. 视觉参考在 P4 之后才允许
{
  const out = run({ action: 'visual', visual: [{ id: 'v1', kind: 'palette', use: 'both', note: '冷灰蓝 + 磷光绿' }] });
  assert.match(out, /已保存视觉参考 1 条/);
  assert.equal(readLibraryState(dir).stage, 'P5');
}

// 9. 最终状态可汇总
{
  const out = run({ action: 'status' });
  assert.match(out, /阶段：P5/);
  assert.match(out, /条目：41 条/);
  assert.match(out, /已确认/);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('library simulation passed');

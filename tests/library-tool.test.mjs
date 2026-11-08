import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { libraryAction } from '../lib/library/tool.js';
import { readLibraryState } from '../lib/library/state.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-tool-'));

// 造一份两章的小说材料
const novel = [
  '第一章 雨夜',
  '她推门进来，雨水顺着伞骨往下滴。店里只有四张桌，靠窗那张空着。'.repeat(20),
  '第二章 旧账',
  '账本上记着七年前的债，数字被反复涂改过。'.repeat(20),
].join('\n');
const srcFile = path.join(dir, 'novel.txt');
fs.writeFileSync(srcFile, novel, 'utf8');

const run = (args) => libraryAction({ out: dir, ...args });

// 1. status 初始
{
  const out = run({ action: 'status' });
  assert.match(out, /阶段：P0/);
  assert.match(out, /材料：0 份/);
}

// 2. ingest 导入并切分
{
  const out = run({ action: 'ingest', file: 'novel.txt', id: 'novel-a', kind: 'novel', title: '雨夜店', realm: 'canon' });
  assert.match(out, /已导入材料 novel-a（novel/);
  assert.match(out, /切分：2 个单元/);
  assert.ok(fs.existsSync(path.join(dir, '.card-build/library/sources/novel-a.json')));
  assert.equal(readLibraryState(dir).stage, 'P1');
}

// 3. commit：一条合法 + 一条引文错误
{
  const quote = '她推门进来，雨水顺着伞骨往下滴。';
  const out = run({
    action: 'commit',
    records: [
      { id: 'char-a', kind: 'character', name: '阿雨', aliases: ['小雨'], realm: 'canon', status: 'confirmed', known_from: 0, body: '开着一间小咖啡店。', evidence: [{ source_id: 'novel-a', unit_id: 'u000001', quote }] },
      { id: 'bad-1', kind: 'place', name: '不存在的店', realm: 'canon', status: 'confirmed', body: '瞎编的', evidence: [{ source_id: 'novel-a', unit_id: 'u000001', quote: '原文里没有这句' }] },
    ],
  });
  assert.match(out, /入库 1 条，拒收 1 条/);
  assert.match(out, /bad-1/);
  assert.ok(fs.existsSync(path.join(dir, '.card-build/library/records/char-a.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.card-build/library/records/bad-1.md')));
  assert.equal(readLibraryState(dir).stage, 'P2');
}

// 4. allocate 给两套方案对比
{
  const out = run({ action: 'allocate' });
  assert.match(out, /方案对比/);
  assert.match(out, /沉浸优先/);
  assert.match(out, /轻量优先/);
  assert.ok(fs.existsSync(path.join(dir, '.card-build/library/plan.json')));
}

// 4b. 未确认条目清单时 propose 被拦
{
  assert.throws(() => run({ action: 'propose' }), /条目清单还没确认/);
}

// 4c. 记录确认
{
  const out = run({ action: 'confirm', key: 'records' });
  assert.match(out, /已记录确认：records/);
  assert.equal(readLibraryState(dir).confirmed.records, true);
}

// 5. propose 生成方案文档
{
  const out = run({ action: 'propose' });
  assert.match(out, /方案文档已生成/);
  const md = fs.readFileSync(path.join(dir, '.card-build/library/library-proposal.md'), 'utf8');
  assert.match(md, /方案 A · 沉浸优先/);
  assert.match(md, /方案 B · 轻量优先/);
  assert.match(md, /需要你确认/);
  assert.equal(readLibraryState(dir).stage, 'P3');
}

// 6a. 方案未批准时 write 被拦
{
  assert.throws(() => run({ action: 'write', scheme: 'B' }), /取舍方案还没被批准/);
}

// 6. approve 记录选定方案
{
  const out = run({ action: 'approve', scheme: 'B' });
  assert.match(out, /方案 B/);
  assert.equal(readLibraryState(dir).confirmed.proposal, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.card-build/library/plan.json'), 'utf8')).scheme, 'B');
}

// 7. write 生成世界书条目
{
  const out = run({ action: 'write', scheme: 'B', startPhase: 0 });
  assert.match(out, /已生成世界书条目/);
  const j = JSON.parse(fs.readFileSync(path.join(dir, '.card-build/library/wb-entries.json'), 'utf8'));
  assert.equal(j.scheme, 'B');
  assert.equal(j.entries.length, 1);
  const e = j.entries[0];
  assert.deepEqual(e.key, ['阿雨', '小雨']);
  assert.equal(e.key_region, 6);
  assert.equal(e.value_region, 1);
  assert.equal(e.probability, 100);
  assert.match(e.content, /【阿雨】/);
  assert.equal(readLibraryState(dir).stage, 'P4');
}

// 8. visual 视觉参考交付
{
  const out = run({ action: 'visual', visual: [{ id: 'v1', kind: 'scene', use: 'chat', note: '借雨夜霓虹的冷色调' }] });
  assert.match(out, /已保存视觉参考 1 条/);
  assert.ok(fs.existsSync(path.join(dir, '.card-build/library/visual-proposal.md')));
  assert.equal(readLibraryState(dir).stage, 'P5');
}

// 9. visual 缺字段时提醒
{
  const out = run({ action: 'visual', visual: [{ id: 'v2' }] });
  assert.match(out, /缺 use 或 note/);
}

// 10. usage 记账与去重
{
  run({ action: 'usage', attempt_id: 'a1', usage_kind: 'measured', input_tokens: 100, output_tokens: 20 });
  run({ action: 'usage', attempt_id: 'a1', usage_kind: 'measured', input_tokens: 100, output_tokens: 20 });
  const s = readLibraryState(dir);
  assert.equal(s.batches.calls, 1);
  assert.equal(s.batches.tokens.input, 100);
}

// 11. pause / resume
{
  assert.match(run({ action: 'pause' }), /已暂停/);
  assert.equal(readLibraryState(dir).paused, true);
  assert.match(run({ action: 'resume' }), /已恢复/);
  assert.equal(readLibraryState(dir).paused, false);
}

// 12. status 汇总
{
  const out = run({ action: 'status' });
  assert.match(out, /阶段：P5/);
  assert.match(out, /材料：1 份/);
  assert.match(out, /条目：1 条/);
  assert.match(out, /下一步：/);
}

// 13. 未知动作给出可用列表
{
  const out = run({ action: 'nonsense' });
  assert.match(out, /未知动作/);
  assert.match(out, /ingest/);
}

// 14. 材料文件不存在时报错
{
  assert.throws(() => run({ action: 'ingest', file: 'nope.txt' }), /不存在/);
}

// 15. read-unit 取单段全文
{
  const out = run({ action: 'read-unit', source_id: 'novel-a', unit_id: 'u000001' });
  assert.match(out, /novel-a\/u000001/);
  assert.match(out, /她推门进来/);
}

// 16. read-unit 缺参数报错
{
  assert.throws(() => run({ action: 'read-unit', source_id: 'novel-a' }), /需要 source_id 与 unit_id/);
}

// 17. commit dry_run 不写盘
{
  const before = readLibraryState(dir).stage;
  const quote = '她推门进来，雨水顺着伞骨往下滴。';
  const out = run({
    action: 'commit',
    dry_run: true,
    records: [{ id: 'char-dry', kind: 'character', name: '测试人', realm: 'canon', status: 'confirmed', body: '不该被写入', evidence: [{ source_id: 'novel-a', unit_id: 'u000001', quote }] }],
  });
  assert.match(out, /dry_run/);
  assert.ok(!fs.existsSync(path.join(dir, '.card-build/library/records/char-dry.md')));
  assert.equal(readLibraryState(dir).stage, before);
}

// 18. write 输出解释文件结构
{
  const out = run({ action: 'write', scheme: 'B', startPhase: 0 });
  assert.match(out, /文件结构/);
  assert.match(out, /entries/);
  assert.match(out, /前 3 条样例/);
}

// 19. propose 在已有记录时也要先确认（换新目录验证）
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-tool2-'));
  fs.writeFileSync(path.join(dir2, 'n.txt'), ['第一章 A', '甲'.repeat(600), '第二章 B', '乙'.repeat(600)].join('\n'), 'utf8');
  libraryAction({ out: dir2, action: 'ingest', file: 'n.txt', id: 's1', kind: 'novel' });
  const q = '甲'.repeat(10);
  libraryAction({ out: dir2, action: 'commit', records: [{ id: 'c1', kind: 'character', name: '甲', realm: 'canon', status: 'confirmed', body: 'x', evidence: [{ source_id: 's1', unit_id: 'u000001', quote: q }] }] });
  assert.throws(() => libraryAction({ out: dir2, action: 'visual', visual: [] }), /世界书还没写入/);
  fs.rmSync(dir2, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('library tool tests passed');

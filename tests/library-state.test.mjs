import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultState, readLibraryState, writeLibraryState, patchLibraryState, setStage,
  setDepth, confirm, pause, resume, addUsage, nextBatch, summarize, STAGES, statePath,
} from '../lib/library/state.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-state-'));

// 1. 默认状态
{
  const s = readLibraryState(dir);
  assert.equal(s.stage, 'P0');
  assert.equal(s.depth, '标准');
  assert.equal(s.paused, false);
  assert.deepEqual(s.confirmed, { records: false, proposal: false, visual: false });
  assert.deepEqual(Object.keys(defaultState()).sort(), Object.keys(s).sort());
}

// 2. 写入后可读回，且带更新时间
{
  writeLibraryState(dir, { ...defaultState(), stage: 'P1' });
  const s = readLibraryState(dir);
  assert.equal(s.stage, 'P1');
  assert.ok(s.updatedAt);
  assert.ok(fs.existsSync(statePath(dir)));
}

// 3. 阶段推进与历史
{
  setStage(dir, 'P2', '条目抽取完成');
  const s = readLibraryState(dir);
  assert.equal(s.stage, 'P2');
  assert.ok(s.history.some((h) => h.to === 'P2'));
}

// 4. 未知阶段被拒
{
  assert.throws(() => setStage(dir, 'P9'), /未知阶段/);
  assert.equal(readLibraryState(dir).stage, 'P2');
}

// 5. 不允许静默回退
{
  assert.throws(() => setStage(dir, 'P0'), /不能从 P2 回退/);
}

// 6. 深度三档
{
  setDepth(dir, '深读');
  assert.equal(readLibraryState(dir).depth, '深读');
  assert.throws(() => setDepth(dir, '超深'), /未知深度/);
}

// 7. 确认标记
{
  confirm(dir, 'records');
  assert.equal(readLibraryState(dir).confirmed.records, true);
  assert.equal(readLibraryState(dir).confirmed.proposal, false);
  assert.throws(() => confirm(dir, 'nonsense'), /未知确认项/);
}

// 8. 暂停与恢复
{
  pause(dir);
  assert.equal(readLibraryState(dir).paused, true);
  resume(dir);
  assert.equal(readLibraryState(dir).paused, false);
}

// 9. 用量累加（measured / estimated / unavailable）
{
  addUsage(dir, { attempt_id: 'a1', kind: 'measured', input_tokens: 100, output_tokens: 50, calls: 1 });
  addUsage(dir, { attempt_id: 'a2', kind: 'estimated', input_tokens: 200, output_tokens: null, calls: 2 });
  let s = readLibraryState(dir);
  assert.equal(s.batches.calls, 3);
  assert.equal(s.batches.tokens.input, 300);
  assert.equal(s.batches.tokens.output, 50);

  // 同一 attempt 重复上报不重复计入
  addUsage(dir, { attempt_id: 'a1', kind: 'measured', input_tokens: 100, output_tokens: 50 });
  s = readLibraryState(dir);
  assert.equal(s.batches.calls, 3);
  assert.equal(s.batches.tokens.input, 300);
}

// 10. 默认不接受无上限批次：max 为 0 时不阻断，设上限后阻断
{
  nextBatch(dir);
  nextBatch(dir);
  let s = readLibraryState(dir);
  assert.equal(s.batches.used, 2);
  patchLibraryState(dir, { batches: { ...s.batches, max: 2 } });
  const blocked = nextBatch(dir);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /上限/);
}

// 11. 状态摘要给出下一步
{
  const sum = summarize(dir);
  assert.equal(sum.stage, 'P2');
  // 前面的用例已确认过条目清单，此时应提示进入方案生成
  assert.equal(sum.next, '生成两套取舍方案（propose）');
}

// 12. 阶段枚举与提示文案
{
  assert.deepEqual(STAGES, ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  setStage(dir, 'P3');
  assert.equal(summarize(dir).next, '选定取舍方案 A 或 B（approve）');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('library state tests passed');

// 资料库状态：阶段、深度、批次用量、确认标记、暂停与恢复。
import fs from 'node:fs';
import path from 'node:path';

export const STAGES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
export const STAGE_NAMES = {
  P0: '导入材料',
  P1: '切分与确认',
  P2: '抽取条目',
  P3: '取舍方案',
  P4: '写入世界书',
  P5: '视觉参考',
  P6: '交付报告',
};
export const DEPTHS = ['快速', '标准', '深读'];
export const CONFIRM_KEYS = ['records', 'proposal', 'visual'];

export function libraryRoot(projectDir) {
  return path.join(projectDir, '.card-build', 'library');
}

export function statePath(projectDir) {
  return path.join(libraryRoot(projectDir), 'state.json');
}

export function defaultState() {
  return {
    version: 1,
    stage: 'P0',
    depth: '标准',
    paused: false,
    batches: { used: 0, max: 0, calls: 0, tokens: { input: 0, output: 0 }, attempts: [] },
    confirmed: { records: false, proposal: false, visual: false },
    proposal: null,
    history: [],
    updatedAt: null,
  };
}

export function readLibraryState(projectDir) {
  const p = statePath(projectDir);
  if (!fs.existsSync(p)) return defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...defaultState(), ...raw, confirmed: { ...defaultState().confirmed, ...(raw.confirmed || {}) } };
  } catch {
    return defaultState();
  }
}

export function writeLibraryState(projectDir, state) {
  fs.mkdirSync(libraryRoot(projectDir), { recursive: true });
  const next = { ...defaultState(), ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath(projectDir), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

export function patchLibraryState(projectDir, patch) {
  const cur = readLibraryState(projectDir);
  return writeLibraryState(projectDir, { ...cur, ...patch });
}

export function setStage(projectDir, stage, note = '') {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}（可选 ${STAGES.join(' / ')}）`);
  const cur = readLibraryState(projectDir);
  if (STAGES.indexOf(stage) < STAGES.indexOf(cur.stage)) {
    throw new Error(`不能从 ${cur.stage} 回退到 ${stage}；如需重做，请用 resume 或新建资料库`);
  }
  const history = [...(cur.history || []), { at: new Date().toISOString(), from: cur.stage, to: stage, note }].slice(-30);
  return writeLibraryState(projectDir, { ...cur, stage, history });
}

export function setDepth(projectDir, depth) {
  if (!DEPTHS.includes(depth)) throw new Error(`未知深度：${depth}（可选 ${DEPTHS.join(' / ')}）`);
  return patchLibraryState(projectDir, { depth });
}

export function confirm(projectDir, key, value = true) {
  if (!CONFIRM_KEYS.includes(key)) throw new Error(`未知确认项：${key}（可选 ${CONFIRM_KEYS.join(' / ')}）`);
  const cur = readLibraryState(projectDir);
  return writeLibraryState(projectDir, { ...cur, confirmed: { ...cur.confirmed, [key]: value } });
}

export function setPlan(projectDir, plan) {
  return patchLibraryState(projectDir, { proposal: plan });
}

export function pause(projectDir) {
  return patchLibraryState(projectDir, { paused: true });
}

export function resume(projectDir) {
  const cur = readLibraryState(projectDir);
  if (!cur.paused) return cur;
  return patchLibraryState(projectDir, { paused: false });
}

/**
 * 记一次用量。attempt_id 相同则忽略（防重复上报）。
 * kind: measured / estimated / unavailable
 */
export function addUsage(projectDir, { attempt_id: attemptId, batch_id: batchId = '', kind = 'estimated', calls = 1, input_tokens: input = null, output_tokens: output = null } = {}) {
  if (!attemptId) throw new Error('addUsage 需要 attempt_id');
  if (!['measured', 'estimated', 'unavailable'].includes(kind)) throw new Error(`未知用量类型：${kind}`);
  const cur = readLibraryState(projectDir);
  const attempts = cur.batches.attempts || [];
  if (attempts.some((a) => a.attempt_id === attemptId)) return cur;

  const nextAttempt = { attempt_id: attemptId, batch_id: batchId, kind, calls, input_tokens: input, output_tokens: output, at: new Date().toISOString() };
  const tokens = {
    input: cur.batches.tokens.input + (typeof input === 'number' ? input : 0),
    output: cur.batches.tokens.output + (typeof output === 'number' ? output : 0),
  };
  return writeLibraryState(projectDir, {
    ...cur,
    batches: { ...cur.batches, calls: cur.batches.calls + calls, tokens, attempts: [...attempts, nextAttempt].slice(-200) },
  });
}

export function nextBatch(projectDir) {
  const cur = readLibraryState(projectDir);
  const used = cur.batches.used;
  if (cur.batches.max && used >= cur.batches.max) {
    return { ok: false, reason: `已达批次上限 ${cur.batches.max}，不再开新批次` };
  }
  const next = { ...cur, batches: { ...cur.batches, used: used + 1 } };
  writeLibraryState(projectDir, next);
  return { ok: true, batch_id: `b${String(used + 1).padStart(3, '0')}`, state: next };
}

export function summarize(projectDir) {
  const s = readLibraryState(projectDir);
  return {
    stage: s.stage,
    stageName: STAGE_NAMES[s.stage] || s.stage,
    depth: s.depth,
    paused: s.paused,
    confirmed: s.confirmed,
    plan: s.proposal ? s.proposal.scheme : null,
    batches: { used: s.batches.used, max: s.batches.max, calls: s.batches.calls, tokens: s.batches.tokens },
    next:
      s.stage === 'P2' && !s.confirmed.records ? '确认条目清单'
        : s.stage === 'P3' && !s.confirmed.proposal ? '选定取舍方案（A / B）'
          : s.stage === 'P5' && !s.confirmed.visual ? '确认视觉参考'
            : '继续下一步',
  };
}

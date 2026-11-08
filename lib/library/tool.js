// 资料库工具入口：把六个模块串成可用动作。
// 输出一律是给人看的文本；出错直接抛，由外层转成 error。
import fs from 'node:fs';
import path from 'node:path';
import { registerSource, readSource, splitText, libraryDir, sourcesDir } from './sources.js';
import { writeRecord, listRecords, readRecord, rebuildIndex, verifyEvidence, unresolvedConflicts } from './records.js';
import { allocate, detectComplexity, downgradePlan, PROFILES, SCHEMES, recordChars } from './budget.js';
import { buildEntries } from './mapping.js';
import { lintLibrary } from './validate.js';
import {
  readLibraryState, setStage, setDepth, confirm, pause, resume, summarize, nextBatch, addUsage, STAGES, STAGE_NAMES,
} from './state.js';

const fmt = (n) => String(n);

function rootOf(args) {
  const out = args.out || args.__cwd;
  if (!out) throw new Error('需要作品目录：请传 out，或在会话工作区里运行');
  return path.resolve(out);
}

function readVisual(projectDir) {
  const p = path.join(libraryDir(projectDir), 'visual.json');
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

function loadPlan(projectDir) {
  const p = path.join(libraryDir(projectDir), 'plan.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writePlan(projectDir, plan) {
  fs.mkdirSync(libraryDir(projectDir), { recursive: true });
  fs.writeFileSync(path.join(libraryDir(projectDir), 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

function schemeTable(a, b) {
  const row = (p) =>
    `  ${p.schemeName.padEnd(5, ' ')} 常驻 ${fmt(p.usage.residentChars)}/${fmt(p.residentBudget)} 字（${p.usage.residentCount} 条），触发 ${fmt(p.usage.conditionalCount)} 条，背景 ${fmt(p.usage.backgroundCount)} 条`;
  return `方案对比（${PROFILES.simple.label} ${PROFILES.simple.total}/${PROFILES.simple.entry} 字，${PROFILES.complex.label} ${PROFILES.complex.total}/${PROFILES.complex.entry} 字）：\n${row(a)}\n${row(b)}`;
}

function actionStatus(projectDir) {
  const s = summarize(projectDir);
  const records = listRecords(projectDir);
  const sources = fs.existsSync(sourcesDir(projectDir))
    ? fs.readdirSync(sourcesDir(projectDir)).filter((f) => f.endsWith('.json'))
    : [];
  return [
    `阶段：${s.stage} ${s.stageName}`,
    `深度：${s.depth}｜暂停：${s.paused ? '是' : '否'}`,
    `材料：${sources.length} 份｜条目：${records.length} 条`,
    `确认：条目清单 ${s.confirmed.records ? '已确认' : '未确认'}，取舍方案 ${s.confirmed.proposal ? '已确认' : '未确认'}，视觉参考 ${s.confirmed.visual ? '已确认' : '未确认'}`,
    `批次：已用 ${s.batches.used}${s.batches.max ? '/' + s.batches.max : ''}｜调用 ${s.batches.calls} 次`,
    `下一步：${s.next}`,
  ].join('\n');
}

function actionIngest(projectDir, args) {
  const id = args.id || 'material-1';
  const kind = args.kind || 'novel';
  const file = args.file ? path.resolve(projectDir, args.file) : null;
  if (!file && !args.text) throw new Error('ingest 需要 file（材料路径）或 text（直接给正文）');
  if (file && !fs.existsSync(file)) throw new Error(`材料文件不存在：${file}`);

  const meta = registerSource(projectDir, {
    id,
    kind,
    title: args.title || '',
    realm: args.realm || 'unknown',
    continuity: args.continuity || '',
    edition: args.edition || '',
    phase: typeof args.phase === 'number' ? args.phase : null,
    filePath: file || undefined,
    text: file ? undefined : String(args.text),
  });
  setStage(projectDir, 'P1', `导入材料 ${id}`);

  const { meta: back, text } = readSource(projectDir, id);
  const preview = back.units.slice(0, 8).map((u) => {
    const head = text.slice(u.start, Math.min(u.end, u.start + 40)).replace(/\n/g, ' ');
    return `  ${u.id} ${u.chars} 字｜${u.title || '（无标题）'}｜${head}…`;
  });
  return [
    `已导入材料 ${id}（${kind}，${back.encoding}，${fmt(back.chars)} 字）→ ${path.relative(projectDir, sourcesDir(projectDir))}/${id}.json`,
    `切分：${back.units.length} 个单元（统计 ${JSON.stringify(back.stats)}）`,
    preview.length ? '前几个单元：\n' + preview.join('\n') : '（没有切出单元）',
    '',
    '请把切分结果给用户看一眼，确认章节/集/条目切得对不对；确认后用 commit 写入抽取出的条目。',
  ].join('\n');
}

function actionCommit(projectDir, args) {
  const records = Array.isArray(args.records) ? args.records : [];
  if (!records.length) throw new Error('commit 需要 records 数组');
  const written = [];
  const rejected = [];
  for (const rec of records) {
    try {
      const problems = verifyEvidence(projectDir, rec);
      if (problems.length) {
        rejected.push({ id: rec.id, problems: problems.map((p) => p.message) });
        continue;
      }
      const r = writeRecord(projectDir, rec);
      written.push(r.id);
    } catch (e) {
      rejected.push({ id: rec.id || '(无 id)', problems: [e.message] });
    }
  }
  const idx = rebuildIndex(projectDir);
  if (written.length) setStage(projectDir, 'P2', `入库 ${written.length} 条`);

  const lines = [`入库 ${written.length} 条，拒收 ${rejected.length} 条；索引 ${idx.count} 条 → ${path.relative(projectDir, idx.file)}`];
  if (rejected.length) {
    lines.push('被拒收的条目：');
    for (const r of rejected) lines.push(`  ✗ ${r.id}：${r.problems.join('；')}`);
    lines.push('原因：这些条目的原文引文对不上，或 ID/字段不合法。两条路：① 回到原文重新摘一句逐字一致的引文；② 删掉这条。');
  }
  return lines.join('\n');
}

function actionAllocate(projectDir, args) {
  const records = listRecords(projectDir);
  if (!records.length) throw new Error('还没有资料条目，先 commit 再分配预算');
  const profile = detectComplexity(records, { complexity: args.complexity });
  const startPhase = typeof args.startPhase === 'number' ? args.startPhase : 0;
  const a = allocate(records, { scheme: 'A', profile, startPhase });
  const b = allocate(records, { scheme: 'B', profile, startPhase });
  const chosen = args.scheme === 'B' ? b : a;
  writePlan(projectDir, chosen);
  return [
    schemeTable(a, b),
    '',
    `当前落盘：方案 ${chosen.scheme}（${chosen.schemeName}）`,
    downgradePlan(chosen).text,
    chosen.notes.length ? '提醒：\n' + chosen.notes.map((n) => '  · ' + n).join('\n') : '',
  ].filter(Boolean).join('\n');
}

function actionPropose(projectDir, args) {
  const records = listRecords(projectDir);
  if (!records.length) throw new Error('还没有资料条目，先 commit');
  const profile = detectComplexity(records, { complexity: args.complexity });
  const startPhase = typeof args.startPhase === 'number' ? args.startPhase : 0;
  const a = allocate(records, { scheme: 'A', profile, startPhase });
  const b = allocate(records, { scheme: 'B', profile, startPhase });
  const visual = readVisual(projectDir);
  const sources = fs.existsSync(sourcesDir(projectDir))
    ? fs.readdirSync(sourcesDir(projectDir)).filter((f) => f.endsWith('.json'))
    : [];

  const md = [
    '# 资料库取舍方案',
    '',
    `- 材料：${sources.length} 份`,
    `- 条目：${records.length} 条（${Object.entries(records.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v}`).join('，')}）`,
    `- 预算档：${profile.label}（常驻合计 ${profile.total} 字，单条 ${profile.entry} 字）`,
    `- 开局阶段：${startPhase}`,
    '',
    '## 方案 A · 沉浸优先',
    '',
    `常驻预算 ${a.residentBudget} 字，常驻 ${a.usage.residentCount} 条，触发 ${a.usage.conditionalCount} 条。`,
    '',
    '## 方案 B · 轻量优先',
    '',
    `常驻预算 ${b.residentBudget} 字，常驻 ${b.usage.residentCount} 条，触发 ${b.usage.conditionalCount} 条。`,
    '',
    '## 常驻清单（按方案）',
    '',
    '| 方案 A | 方案 B |',
    '|---|---|',
    ...Array.from({ length: Math.max(a.resident.length, b.resident.length) }, (_, i) =>
      `| ${a.resident[i] ? `${a.resident[i].name || a.resident[i].id}（${a.resident[i].chars} 字）` : ''} | ${b.resident[i] ? `${b.resident[i].name || b.resident[i].id}（${b.resident[i].chars} 字）` : ''} |`),
    '',
    '## 视觉参考',
    '',
    visual.length ? visual.map((v) => `- ${v.id}｜${v.use || '未标用途'}｜${v.note || '未写借什么'}`).join('\n') : '（暂无）',
    '',
    '## 需要你确认',
    '',
    '选 A 还是 B？确认后我用 approve 记下来，再写入世界书。',
    '',
  ].join('\n');

  fs.mkdirSync(libraryDir(projectDir), { recursive: true });
  const file = path.join(libraryDir(projectDir), 'library-proposal.md');
  fs.writeFileSync(file, md, 'utf8');
  setStage(projectDir, 'P3', '生成取舍方案');
  return [
    `方案文档已生成 → ${path.relative(projectDir, file)}`,
    schemeTable(a, b),
    '',
    '把这份方案给用户看，让他选 A 或 B；选定后调用 approve。',
  ].join('\n');
}

function actionApprove(projectDir, args) {
  const scheme = args.scheme === 'B' ? 'B' : 'A';
  const records = listRecords(projectDir);
  const profile = detectComplexity(records, { complexity: args.complexity });
  const startPhase = typeof args.startPhase === 'number' ? args.startPhase : 0;
  const plan = allocate(records, { scheme, profile, startPhase });
  writePlan(projectDir, plan);
  confirm(projectDir, 'proposal');
  return `已记录：方案 ${plan.scheme}（${plan.schemeName}），常驻 ${plan.usage.residentChars}/${plan.residentBudget} 字，触发 ${plan.usage.conditionalCount} 条。`;
}

function actionWrite(projectDir, args) {
  const records = listRecords(projectDir);
  if (!records.length) throw new Error('还没有资料条目');
  const startPhase = typeof args.startPhase === 'number' ? args.startPhase : 0;
  let plan = loadPlan(projectDir);
  if (!plan || (args.scheme && plan.scheme !== args.scheme)) {
    const scheme = args.scheme === 'B' ? 'B' : (plan && plan.scheme) || 'A';
    plan = allocate(records, { scheme, profile: detectComplexity(records, { complexity: args.complexity }), startPhase });
    writePlan(projectDir, plan);
  }
  const built = buildEntries(plan, records, { startPhase });
  const visual = readVisual(projectDir);
  const diagnostics = lintLibrary({ projectDir, records, plan, visual, startPhase });

  fs.mkdirSync(libraryDir(projectDir), { recursive: true });
  const outFile = path.join(libraryDir(projectDir), 'wb-entries.json');
  fs.writeFileSync(outFile, JSON.stringify({ scheme: plan.scheme, startPhase, entries: built.entries, meta: built.meta, skipped: built.skipped }, null, 2) + '\n', 'utf8');
  setStage(projectDir, 'P4', `写入 ${built.entries.length} 条世界书条目`);

  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warns = diagnostics.filter((d) => d.severity !== 'error');
  const lines = [
    `已生成世界书条目 ${built.entries.length} 条 → ${path.relative(projectDir, outFile)}`,
    `常驻 ${fmt(built.usage.residentChars)} 字，触发部分 ${fmt(built.usage.conditionalChars)} 字；跳过 ${built.skipped.length} 条`,
  ];
  if (built.skipped.length) lines.push('跳过：' + built.skipped.map((s) => `${s.id}（${s.reason}）`).join('，'));
  if (errors.length) {
    lines.push(`校验未通过 ${errors.length} 条：`);
    for (const e of errors) lines.push(`  ✗ ${e.id} ${e.message}`);
  }
  if (warns.length) {
    lines.push(`提醒 ${warns.length} 条：`);
    for (const w of warns) lines.push(`  ! ${w.id} ${w.message}`);
  }
  if (!errors.length) lines.push('这些条目可以直接交给第一部分放进 wb 字段。');
  return lines.join('\n');
}

function actionVisual(projectDir, args) {
  const items = Array.isArray(args.visual) ? args.visual : [];
  fs.mkdirSync(libraryDir(projectDir), { recursive: true });
  const file = path.join(libraryDir(projectDir), 'visual.json');
  fs.writeFileSync(file, JSON.stringify({ items }, null, 2) + '\n', 'utf8');

  const missing = items.filter((v) => !v.use || !v.note);
  const md = [
    '# 视觉参考交付',
    '',
    items.length ? items.map((v) => `- ${v.id}｜${v.kind || '未分类'}｜用途 ${v.use || '未标'}｜${v.note || '未写借什么'}${v.source ? `｜来源 ${v.source}` : ''}`).join('\n') : '（暂无）',
    '',
    '这些参考只作为第二、三部分设计方案的依据，不直接使用原图。',
    '',
  ].join('\n');
  const mdFile = path.join(libraryDir(projectDir), 'visual-proposal.md');
  fs.writeFileSync(mdFile, md, 'utf8');
  if (items.length) setStage(projectDir, 'P5', `视觉参考 ${items.length} 条`);

  const lines = [`已保存视觉参考 ${items.length} 条 → ${path.relative(projectDir, file)}`, `交付文档 → ${path.relative(projectDir, mdFile)}`];
  if (missing.length) lines.push(`有 ${missing.length} 条缺 use 或 note：${missing.map((v) => v.id).join('、')}。补齐后再交给第二、三部分。`);
  return lines.join('\n');
}

export function libraryAction(args = {}) {
  const projectDir = rootOf(args);
  const act = String(args.action || 'status');
  switch (act) {
    case 'status': return actionStatus(projectDir);
    case 'ingest': return actionIngest(projectDir, args);
    case 'commit': return actionCommit(projectDir, args);
    case 'allocate': return actionAllocate(projectDir, args);
    case 'propose': return actionPropose(projectDir, args);
    case 'approve': return actionApprove(projectDir, args);
    case 'write': return actionWrite(projectDir, args);
    case 'visual': return actionVisual(projectDir, args);
    case 'pause': pause(projectDir); return '已暂停资料库流程；材料与条目都保留。';
    case 'resume': resume(projectDir); return '已恢复，接着上次的阶段继续。';
    case 'next-batch': {
      const r = nextBatch(projectDir);
      return r.ok ? `已开批次 ${r.batch_id}` : `未开新批次：${r.reason}`;
    }
    case 'usage': {
      const r = addUsage(projectDir, {
        attempt_id: args.attempt_id || `a${Date.now()}`,
        batch_id: args.batch_id || '',
        kind: args.usage_kind || 'estimated',
        calls: Number(args.calls || 1),
        input_tokens: typeof args.input_tokens === 'number' ? args.input_tokens : null,
        output_tokens: typeof args.output_tokens === 'number' ? args.output_tokens : null,
      });
      return `用量已记：累计调用 ${r.batches.calls} 次，输入 ${r.batches.tokens.input}，输出 ${r.batches.tokens.output}`;
    }
    default:
      return `未知动作 ${act}。可用：status / ingest / commit / allocate / propose / approve / write / visual / pause / resume / next-batch / usage`;
  }
}

export { STAGES, STAGE_NAMES };

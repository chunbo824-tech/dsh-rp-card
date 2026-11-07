import fs from 'node:fs';
import path from 'node:path';

/* ============================================================
 * 角色卡评估（v1.1 框架的机械部分）
 * 评估人只选档位并给原文引用；折算、N/A、预设缩放、封顶、等级由本模块算。
 * 工程审计部分直接从 card.json 抽取硬指标，不依赖主观判断。
 * ============================================================ */

export const DIMENSIONS = [
  { id: 'F1', module: 'F', max: 3, label: '名称' },
  { id: 'F2', module: 'F', max: 4, label: '简介' },
  { id: 'F3', module: 'F', max: 3, label: '标签' },
  { id: 'F4', module: 'F', max: 2, label: '视觉资产' },
  { id: 'F5', module: 'F', max: 3, label: '详细介绍页' },
  { id: 'S1', module: 'S', max: 6, label: '世界设定' },
  { id: 'S2', module: 'S', max: 4, label: '势力与区域' },
  { id: 'S3', module: 'S', max: 4, label: '历史与背景' },
  { id: 'S4', module: 'S', max: 5, label: '世界观约束' },
  { id: 'S5', module: 'S', max: 3, label: '角色外貌' },
  { id: 'S6', module: 'S', max: 4, label: '角色性格' },
  { id: 'S7', module: 'S', max: 2, label: '角色背景' },
  { id: 'S8', module: 'S', max: 2, label: '语言习惯' },
  { id: 'O1', module: 'O', max: 6, label: '文风定义' },
  { id: 'O2', module: 'O', max: 4, label: '阶段化设计' },
  { id: 'O3', module: 'O', max: 3, label: '规则优先级' },
  { id: 'O4', module: 'O', max: 3, label: '硬软规则区分' },
  { id: 'O5', module: 'O', max: 4, label: '约束正向化' },
  { id: 'O6', module: 'O', max: 3, label: '思维链' },
  { id: 'O7', module: 'O', max: 2, label: '玩家能动性' },
  { id: 'M1', module: 'M', max: 4, label: '字段必要性' },
  { id: 'M2', module: 'M', max: 3, label: '更新频率区分' },
  { id: 'M3', module: 'M', max: 5, label: '记忆区架构' },
  { id: 'M4', module: 'M', max: 3, label: '一致性回溯' },
  { id: 'M5', module: 'M', max: 3, label: '玩法系统' },
  { id: 'M6', module: 'M', max: 2, label: '展示层工程' },
  { id: 'T1', module: 'T', max: 3, label: '排列顺序' },
  { id: 'T2', module: 'T', max: 3, label: '前后置词精简度' },
  { id: 'T3', module: 'T', max: 2, label: '去重与压缩' },
  { id: 'T4', module: 'T', max: 2, label: '世界书分工' },
  { id: 'X1', module: 'X', max: 3, label: '字面量自触发' },
  { id: 'X2', module: 'X', max: 4, label: '第二输出通道' },
  { id: 'X3', module: 'X', max: 3, label: '渲染层正则' },
];

export const MODULE_ORDER = ['F', 'S', 'O', 'M', 'T'];
export const DEFAULT_MODULE_MAX = { F: 15, S: 30, O: 25, M: 20, T: 10 };

export const PRESETS = {
  balanced: { label: '均衡（默认）', max: { F: 15, S: 30, O: 25, M: 20, T: 10 } },
  plot: { label: '剧情驱动型', max: { F: 12, S: 33, O: 28, M: 17, T: 10 } },
  character: { label: '角色驱动型', max: { F: 15, S: 32, O: 22, M: 20, T: 11 } },
  gameplay: { label: '玩法驱动型', max: { F: 12, S: 25, O: 22, M: 31, T: 10 } },
  ai_summary: { label: '开启 AI 总结', max: { F: 13, S: 28, O: 24, M: 25, T: 10 } },
};

export const NA_ALLOWED = new Set(['S2', 'S5', 'S6', 'S7', 'S8', 'M5', 'X1', 'X2', 'X3']);

export const GRADES = [
  { grade: 'S', min: 85 },
  { grade: 'A', min: 70 },
  { grade: 'B', min: 55 },
  { grade: 'C', min: 40 },
  { grade: 'D', min: 0 },
];

const dim = (id) => DIMENSIONS.find((d) => d.id === id);
const round1 = (n) => Math.round(n * 10) / 10;

/** 档位合法性与证据完整性校验。 */
export function validateAnchors(anchors = {}, evidence = {}, na = []) {
  const errors = [];
  const naSet = new Set(na.map((x) => String(x).toUpperCase()));
  for (const id of naSet) {
    if (!dim(id)) errors.push(`N/A 维度不存在：${id}`);
    else if (!NA_ALLOWED.has(id)) errors.push(`该维度不允许 N/A：${id}`);
  }
  for (const d of DIMENSIONS) {
    if (naSet.has(d.id)) {
      if (!String(evidence[d.id] || '').trim()) errors.push(`N/A 维度需写理由与原文引用：${d.id}`);
      continue;
    }
    const raw = anchors[d.id];
    if (raw === undefined || raw === null || raw === '') {
      errors.push(`缺少档位：${d.id}`);
      continue;
    }
    const n = Number(raw);
    if (![0, 1, 3, 5].includes(n)) errors.push(`档位只能取 0/1/3/5：${d.id} 给了 ${raw}`);
    if (!String(evidence[d.id] || '').trim()) errors.push(`缺少证据引用：${d.id}`);
  }
  return errors;
}

/** 机械折算：返回各模块得分、基础分、扩展分、总分与等级。 */
export function computeScore({ anchors = {}, na = [], preset = 'balanced', moduleMax } = {}) {
  const p = PRESETS[preset] || PRESETS.balanced;
  const presetMax = moduleMax || p.max;
  const naSet = new Set(na.map((x) => String(x).toUpperCase()));

  const modules = {};
  for (const m of MODULE_ORDER) {
    const dims = DIMENSIONS.filter((d) => d.module === m);
    let raw = 0;
    let validMax = 0;
    let naMax = 0;
    for (const d of dims) {
      if (naSet.has(d.id)) {
        naMax += d.max;
        continue;
      }
      const a = Number(anchors[d.id]);
      raw += (a / 5) * d.max;
      validMax += d.max;
    }
    const target = presetMax[m];
    const score = validMax === 0 ? 0 : round1((raw / validMax) * target);
    modules[m] = {
      score,
      presetMax: target,
      defaultMax: DEFAULT_MODULE_MAX[m],
      validMax,
      naMax,
      lowConfidence: naMax > DEFAULT_MODULE_MAX[m] * 0.5,
    };
  }

  const xDims = DIMENSIONS.filter((d) => d.module === 'X');
  let ext = 0;
  let extMax = 0;
  for (const d of xDims) {
    if (naSet.has(d.id)) continue;
    ext += (Number(anchors[d.id]) / 5) * d.max;
    extMax += d.max;
  }
  const baseRaw = MODULE_ORDER.reduce((s, m) => s + modules[m].score, 0);
  const base = round1(baseRaw);
  const total = Math.min(100, Math.round(base + ext));
  const grade = (GRADES.find((g) => total >= g.min) || GRADES[GRADES.length - 1]).grade;

  return { modules, base, ext: round1(ext), extMax, total, grade, preset: p.label };
}

/* ---------------- 工程审计 ---------------- */

const CJK_TOKEN = { min: 1.0, max: 1.7 };
const textOf = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const chars = (s) => [...textOf(s)].length;

function loreEntries(card) {
  const wb = card && (card.lore_bk || card.wb);
  return Array.isArray(wb) ? wb : [];
}

function scanEnv(text, where, warnings) {
  const s = textOf(text);
  const hits = [];
  if (/<script[\s>]/i.test(s)) hits.push('<script>');
  if (/localStorage|sessionStorage/i.test(s)) hits.push('浏览器存储');
  if (/javascript:/i.test(s)) hits.push('javascript: 协议');
  if (/\son[a-z]+\s*=/i.test(s)) hits.push('内联事件属性');
  const ext = s.match(/https?:\/\/[^\s"'<>)]+/g);
  if (ext && ext.length) hits.push(`外链 ${ext.length} 处`);
  for (const h of hits) warnings.push({ code: 'ENV', where, message: `含 ${h}`, dimension: where === 'desc' ? 'F5' : 'M6' });
  return hits;
}

/** 硬指标审计：不判断好坏，只把可算的算出来。 */
export function auditCard(card, opts = {}) {
  const warnings = [];
  const metrics = {};
  const ppt = textOf(card.pre_prompt || card.ppt);
  const ptx = textOf(card.ptx);
  const post = textOf(card.post_text);
  const desc = textOf(card.desc);
  const entries = loreEntries(card);
  const regex = Array.isArray(card.rgx_rep) ? card.rgx_rep : [];

  metrics.chars = {
    pre_prompt: chars(ppt),
    ptx: chars(ptx),
    post_text: chars(post),
    desc: chars(desc),
    worldbook_value: entries.reduce((s, e) => s + chars(e && e.value), 0),
    regex_total: regex.length,
  };

  const coreChars = metrics.chars.pre_prompt + metrics.chars.ptx + metrics.chars.post_text;
  metrics.token = {
    perTurnMin: Math.round(coreChars * CJK_TOKEN.min),
    perTurnMax: Math.round(coreChars * CJK_TOKEN.max),
    note: '仅按提示词+前后置词估算；世界书按触发情况另计，AI 输出 token 不计入',
  };

  const rounds = Number.isFinite(opts.memoryRounds) && opts.memoryRounds > 0
    ? opts.memoryRounds
    : (Number.isFinite(opts.memorySetting) ? Math.ceil(opts.memorySetting / 2) : null);
  const amp = rounds === null ? null : rounds + 1;
  metrics.prefixSuffix = {
    length: metrics.chars.ptx + metrics.chars.post_text,
    rounds: opts.aiSummary ? 1 : rounds,
    amplification: amp,
    level: amp === null ? 'unknown' : amp > 10 ? 'G3 待判' : amp > 5 ? 'T2 提醒' : 'ok',
  };
  if (amp !== null && amp > 5) {
    warnings.push({ code: 'AMP', where: 'ptx+post_text', message: `前后置词放大 ${amp} 倍（超过 5 倍应写进报告）`, dimension: 'T2' });
  }

  const byRegion = {};
  const byMatch = {};
  let sortSet = 0;
  let depthSet = 0;
  let probNot100 = 0;
  for (const e of entries) {
    const kr = Number(e && e.key_region);
    byRegion[kr] = (byRegion[kr] || 0) + 1;
    const mt = Number(e && e.match_type);
    byMatch[mt] = (byMatch[mt] || 0) + 1;
    if (Number(e && e.sort) !== 0) sortSet += 1;
    if (Number(e && e.depth) !== 0) depthSet += 1;
    if (Number(e && e.probability) !== 100) probNot100 += 1;
    if (kr === 0) warnings.push({ code: 'WB', where: 'key_region=0', message: 'key_region=0 不匹配任何方向', dimension: 'T4' });
  }
  metrics.worldbook = { count: entries.length, byRegion, byMatch, sortSet, depthSet, probNot100 };

  // X1：AI 区域条目的字面量互相包含（子串碰撞）
  const aiKeys = entries
    .filter((e) => Number(e && e.key_region) === 4 && Number(e && e.match_type) !== 3 && e && e.key)
    .map((e) => String(e.key));
  const collisions = [];
  for (const a of aiKeys) {
    for (const b of aiKeys) {
      if (a !== b && b.includes(a)) collisions.push(`${a} ⊂ ${b}`);
    }
  }
  metrics.selfTrigger = { aiRegionEntries: aiKeys.length, collisions };
  for (const c of collisions.slice(0, 10)) {
    warnings.push({ code: 'X1', where: 'worldbook', message: `触发词子串碰撞：${c}`, dimension: 'X1' });
  }

  const renderOnly = regex.filter((r) => r && r.is_only_render === true).length;
  const dangerous = [];
  for (const r of regex) {
    const p = textOf(r && r.match_regex);
    if (!p) continue;
    try {
      new RegExp(p);
    } catch (e) {
      dangerous.push(`正则无法编译：${p.slice(0, 40)}`);
    }
    if (/\([^)]*[+*][^)]*\)[+*]/.test(p)) dangerous.push(`嵌套量词疑似灾难性回溯：${p.slice(0, 40)}`);
  }
  metrics.render = { total: regex.length, onlyRenderTrue: renderOnly, onlyRenderFalse: regex.length - renderOnly, dangerous };

  scanEnv(post, 'post_text', warnings);
  scanEnv(ppt, 'pre_prompt', warnings);
  scanEnv(desc, 'desc', warnings);

  const json = textOf(card.ai_v_json);
  let schemaOk = false;
  if (json.trim()) {
    try {
      JSON.parse(json);
      schemaOk = true;
    } catch {
      warnings.push({ code: 'X2', where: 'ai_v_json', message: 'ai_v_json 不是合法 JSON', dimension: 'X2' });
    }
  }
  metrics.dataChannel = {
    enabled: Boolean(card.extend && card.extend.ai_variable_enabled),
    templateChars: chars(card.ai_variable_tmpl),
    jsonChars: chars(json),
    schemaOk,
  };

  metrics.gateHints = {
    G3: metrics.prefixSuffix.length > 0 && amp !== null && amp > 10 ? '前后置词偏长且放大倍数高，需人工判定是否违规' : '未见明显滥用',
  };

  return { metrics, warnings, note: '本审计只给硬指标，档位仍需评估人按锚点判定并附原文引用。' };
}

/* ---------------- 报告 ---------------- */

function scorecardText(r, input) {
  const lines = [];
  const pick = (ids) => ids.map((id) => {
    const d = dim(id);
    const a = input.na && input.na.includes(id) ? 'N/A' : String(input.anchors[id]);
    const s = input.na && input.na.includes(id) ? 'N/A' : round1((Number(input.anchors[id]) / 5) * d.max);
    return `${id} ${d.label}\t[${a}]\t${s}/${d.max}`;
  });
  lines.push('【F 门面层】', ...pick(['F1', 'F2', 'F3', 'F4', 'F5']), `小计 ${r.modules.F.score}/${r.modules.F.presetMax}${r.modules.F.lowConfidence ? '（低置信）' : ''}`, '');
  lines.push('【S 世界与角色设定】', ...pick(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']), `小计 ${r.modules.S.score}/${r.modules.S.presetMax}${r.modules.S.lowConfidence ? '（低置信）' : ''}`, '');
  lines.push('【O 输出要求与规则】', ...pick(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7']), `小计 ${r.modules.O.score}/${r.modules.O.presetMax}${r.modules.O.lowConfidence ? '（低置信）' : ''}`, '');
  lines.push('【M 状态栏·记忆·玩法】', ...pick(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']), `小计 ${r.modules.M.score}/${r.modules.M.presetMax}${r.modules.M.lowConfidence ? '（低置信）' : ''}`, '');
  lines.push('【T 工程与 token 效率】', ...pick(['T1', 'T2', 'T3', 'T4']), `小计 ${r.modules.T.score}/${r.modules.T.presetMax}${r.modules.T.lowConfidence ? '（低置信）' : ''}`, '');
  lines.push('【X 扩展】', ...pick(['X1', 'X2', 'X3']), `小计 ${r.ext}/${r.extMax}`, '');
  return lines.join('\n');
}

export function renderEvaluationReport(result, input, audit) {
  const lines = [];
  lines.push('# 角色卡评估报告', '');
  lines.push(`- 作品：${input.title || '（未命名）'}`);
  lines.push(`- 评估日期：${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- 权重预设：${result.preset}`);
  lines.push(`- 总分：**${result.total} / 100**（基础 ${result.base} + 扩展 ${result.ext}），等级 **${result.grade}**`, '');
  lines.push('## 一、评分卡', '');
  lines.push(scorecardText(result, input));
  const na = (input.na || []).length ? (input.na || []).join('、') : '无';
  lines.push(`【N/A】${na}`);
  for (const id of input.na || []) lines.push(`- ${id}：${String(input.evidence[id] || '').trim()}`);
  const low = MODULE_ORDER.filter((m) => result.modules[m].lowConfidence);
  lines.push(`【低置信模块】${low.length ? low.map((m) => result.modules[m].score !== undefined ? `${m}（N/A 占比过高）` : m).join('、') : '无'}`);
  lines.push('', '## 二、工程审计（硬指标）', '');
  if (audit) {
    const m = audit.metrics;
    lines.push(`- 每轮固定开销估算：${m.token.perTurnMin}–${m.token.perTurnMax} token（${m.token.note}）`);
    lines.push(`- 前后置词：合计 ${m.prefixSuffix.length} 字，加载 ${m.prefixSuffix.rounds ?? '未知'} 轮 → 放大 ${m.prefixSuffix.amplification ?? '未知'} 倍（${m.prefixSuffix.level}）`);
    lines.push(`- 世界书：${m.worldbook.count} 条；触发区分布 ${JSON.stringify(m.worldbook.byRegion)}；设过 sort ${m.worldbook.sortSet} 条、depth ${m.worldbook.depthSet} 条、probability≠100 ${m.worldbook.probNot100} 条`);
    lines.push(`- 渲染层：${m.render.total} 条（is_only_render true ${m.render.onlyRenderTrue} / false ${m.render.onlyRenderFalse}）；危险项 ${m.render.dangerous.length ? m.render.dangerous.join('；') : '无'}`);
    lines.push(`- 自触发：AI 区条目 ${m.selfTrigger.aiRegionEntries} 条；子串碰撞 ${m.selfTrigger.collisions.length ? m.selfTrigger.collisions.slice(0, 10).join('、') : '无'}`);
    lines.push(`- 数据通道：${m.dataChannel.enabled ? '启用' : '未启用'}；模板 ${m.dataChannel.templateChars} 字、JSON ${m.dataChannel.jsonChars} 字、schema ${m.dataChannel.schemaOk ? '可解析' : '不可解析'}`);
    if (audit.warnings.length) {
      lines.push('', '### 审计告警');
      for (const w of audit.warnings) lines.push(`- [${w.dimension}] ${w.where}：${w.message}`);
    }
  } else {
    lines.push('- 未执行审计（可先调用 audit 再提交评分）。');
  }
  lines.push('', '## 三、诊断');
  lines.push('');
  lines.push('### 做得好的三点');
  lines.push(String(input.strengths || '（待填，附原文引用）'));
  lines.push('', '### 拖后腿的三点');
  lines.push(String(input.weaknesses || '（待填，附原文引用与命中维度）'));
  lines.push('', '### 三条最高杠杆改进建议');
  lines.push(String(input.advice || '（按改动量÷收益排序，填三条）'));
  lines.push('', '### 不要改的地方');
  lines.push(String(input.keep || '（列出已经做对、改动反而有风险的部分）'));
  lines.push('', '## 四、证据引用');
  for (const d of DIMENSIONS) {
    const ev = String(input.evidence[d.id] || '').trim();
    if (ev) lines.push(`- ${d.id} ${d.label}：${ev}`);
  }
  lines.push('', '---', '', '本报告只衡量工程完成度，不衡量作品价值。');
  return lines.join('\n') + '\n';
}

/* ---------------- action ---------------- */

function readCard(out) {
  const f = path.join(out, 'card.json');
  if (!fs.existsSync(f)) throw new Error('尚未组装：找不到 card.json，请先 assemble');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function evaluateAction(args, out) {
  const act = String((args && args.action) || 'audit');
  if (act === 'audit') {
    const card = readCard(out);
    const audit = auditCard(card, {
      memoryRounds: Number(args.memory_rounds),
      memorySetting: Number(args.memory_setting),
      aiSummary: Boolean(args.ai_summary),
    });
    const file = path.join(out, 'qa', 'audit.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(audit, null, 2), 'utf8');
    return { action: 'audit', file: path.relative(out, file).split(path.sep).join('/'), ...audit };
  }

  if (act === 'submit') {
    const anchors = args.anchors || {};
    const evidence = args.evidence || {};
    const na = (args.na || []).map((x) => String(x).toUpperCase());
    const errors = validateAnchors(anchors, evidence, na);
    const gate = args.gates || {};
    const gateFail = ['G1', 'G2', 'G3'].filter((g) => gate[g] === false);
    if (errors.length) throw new Error('评分不完整：\n- ' + errors.join('\n- '));
    if (gateFail.length) {
      throw new Error(`准入未通过（${gateFail.join('、')}）：按框架应判不合格并终止评分，请修正作品后重评。`);
    }
    const result = computeScore({ anchors, na, preset: args.preset || 'balanced' });
    const card = readCard(out);
    const audit = auditCard(card, {
      memoryRounds: Number(args.memory_rounds),
      memorySetting: Number(args.memory_setting),
      aiSummary: Boolean(args.ai_summary),
    });
    const input = { ...args, na, anchors, evidence, title: args.title || card.name };
    const report = renderEvaluationReport(result, input, audit);
    const file = path.join(out, 'qa', 'evaluation.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, report, 'utf8');
    return {
      action: 'submit',
      file: path.relative(out, file).split(path.sep).join('/'),
      total: result.total,
      base: result.base,
      ext: result.ext,
      grade: result.grade,
      modules: result.modules,
      lowConfidence: MODULE_ORDER.filter((m) => result.modules[m].lowConfidence),
      warnings: audit.warnings.length,
      note: '报告已写入；分值只反映工程完成度，不衡量作品价值。',
    };
  }

  throw new Error(`未知 action：${act}（可用 audit / submit）`);
}

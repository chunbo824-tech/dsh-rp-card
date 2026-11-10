import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  V2_KEY_ORDER,
  FIELD_ALIASES,
  PLATFORM_KEY_ALIASES,
  LEGACY_PLATFORM_SETTING_KEYS,
  BACKGROUND_FIELDS,
  pickField,
  pickPanelFlag,
  pickBackground,
  normalizeLoreEntry,
  normalizeRegexRules,
  toPlatform,
  sha256,
  atomicWrite,
  lintWorldbook,
  lintRegex,
  lintChatCss,
  lintRoutingConflict,
  lintWritingCues,
  detectComplexity,
  wbTokens,
  WB_BUDGET_PROFILES,
} from './core.js';
import { auditCard } from './evaluate.js';

/* ============================================================
 * 上传卡评估与优化（1.7.0）
 *
 * 定位：用户把自己做的卡（平台导出的 JSON 或粘贴的 JSON）交进来，
 * 先算清「哪里不合逻辑、每轮要花多少」，再按优先级给优化方案，
 * agent 改写后由本模块重新审计并产出可导入的 v2 文件。
 *
 * 原则：
 * - 工具不调模型：审计、预算、比较、导出都由代码算；改写由 agent 做。
 * - 不伪造平台结论：体量与常驻都是内部相对量，报告里必须写明口径。
 * - 改写不引入新错：apply 会把优化版再审计一遍，新增 error 直接拒收（force 除外）。
 * ============================================================ */

export const REVIEW_VERSION = 1;
export const REVIEW_DIR = '.card-build/review';
export const REVIEW_ACTIONS = ['status', 'ingest', 'audit', 'plan', 'apply', 'export'];
export const REVIEW_PHASES = ['not_started', 'ingested', 'audited', 'planned', 'applied', 'exported'];

/** 平台记忆长度未给参数时的估算默认值（按 5 轮历史）。 */
export const DEFAULT_MEMORY_ROUNDS = 5;

/** 体量提醒门槛：只作提醒，不阻断。 */
export const PPT_WARN_CHARS = 6000;
export const GROWTH_WARN_CHARS = 1500;
export const AMP_WARN = 5;
export const AMP_HIGH = 10;
export const OPENING_WARN_CHARS = 3000;
export const DESC_WARN_CHARS = 300000;
export const CSS_WARN_CHARS = 200000;

/** 内部相对体量：1 个中文字约 1.0–1.7 个单位，只用于同一张卡前后对比。 */
const CJK_TOKEN = { min: 1.0, max: 1.7 };

const CARD_STRING_FIELDS = [
  'title', 'ppt', 'ptx', 'post_text', 'opening_statement',
  'desc', 'built_in_css', 'ai_variable_tmpl', 'ai_v_prompt', 'ai_v_json',
];

const CARD_FIELDS = [...CARD_STRING_FIELDS, 'wb', 'rgx_rep', 'ext', 'bg_img', 'mobile_bg'];

/** 导出时必须由优化版覆盖的字段；其余平台键从原导出件原样保留。 */
const MANAGED_PLATFORM_KEYS = new Set([
  'name', 'pre_prompt', 'ptx', 'post_text', 'opening_statement', 'lore_bk',
  'desc', 'built_in_css', 'rgx_rep', 'ai_variable_tmpl', 'ai_variable_prompt',
  'ai_v_json', 'extend', 'bg_img', 'mobile_bg',
]);

const KNOWN_RAW_KEYS = new Set([
  ...V2_KEY_ORDER,
  ...Object.values(FIELD_ALIASES).flat(),
  ...Object.keys(PLATFORM_KEY_ALIASES),
  ...LEGACY_PLATFORM_SETTING_KEYS,
  ...CARD_FIELDS,
  'ext', 'extend', 'bg_image', 'bg_mobile', 'back_img', 'bgimg', 'bg_mb',
  'pre_prompt', 'lore_bk', 'ai_variable_prompt',
]);

/** 这些旧键已经被 FIELD_ALIASES/BACKGROUND_FIELDS 吃掉，不能再作为额外字段追加。 */
const MANAGED_RAW_ALIASES = new Set([
  ...Object.values(FIELD_ALIASES).flat(),
  ...Object.values(BACKGROUND_FIELDS).flat(),
  'ext', 'extend',
]);

const LAYER_ORDER = { logic: 0, consumption: 1, structure: 2 };
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const PRIORITY_OF = { error: 'must', warning: 'should', info: 'optional' };
const PRIORITY_ORDER = { must: 0, should: 1, optional: 2 };

/** 可以机械修的项：agent 照做即可，不需要创作判断。 */
export const AUTO_FIXABLE = new Set(['RV106', 'RV109', 'RV115']);

const REVIEW_FILES = {
  state: 'state.json',
  raw: 'source.raw.json',
  source: 'source.json',
  meta: 'source-meta.json',
  audit: 'audit.json',
  auditMd: 'audit.md',
  plan: 'plan.json',
  planMd: 'plan.md',
  optimized: 'optimized.json',
  compare: 'compare.md',
  compareJson: 'compare.json',
  export: 'card.optimized.v2.json',
  exportSource: 'card.optimized.source.json',
  report: 'review-report.md',
};

const charLen = (s) => [...(typeof s === 'string' ? s : s == null ? '' : String(s))].length;
const round = (n) => Math.round(n);
const textOf = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function relPath(out, abs) {
  return path.relative(out, abs).split(path.sep).join('/');
}

function reviewDir(out) {
  return path.join(out, REVIEW_DIR);
}

function reviewFile(out, key) {
  return path.join(reviewDir(out), REVIEW_FILES[key]);
}

function ensureDir(out) {
  fs.mkdirSync(reviewDir(out), { recursive: true });
}

function removeReviewFiles(out, keys) {
  for (const key of keys) {
    const file = reviewFile(out, key);
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch { /* 删不掉就留着，闸门仍会挡住旧状态 */ }
  }
}

/** 重新读入或重新审计后，下游产物（方案/改写版/导出件）全部作废并删掉，避免误导入旧文件。 */
function clearDownstream(out) {
  removeReviewFiles(out, ['plan', 'planMd', 'optimized', 'compare', 'compareJson', 'export', 'exportSource', 'report']);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** 读关键文件：缺文件或坏 JSON 都给「问题 + 原因 + 两条路」，不抛底层 ENOENT。 */
function readJsonSafe(file, what, roads) {
  if (!fs.existsSync(file)) {
    throw new Error(`${what}不存在：${file}。原因：上一步没有成功，或文件被删除/移动。两条路：${roads}。`);
  }
  try {
    return readJson(file);
  } catch (e) {
    throw new Error(`${what}内容损坏：${file}。原因：不是合法 JSON，常见于手工编辑或写入中断。两条路：${roads}。原始错误：${e.message}`);
  }
}

function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2));
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/* ---------------- 读入与归一 ---------------- */

function looksLikeCard(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return ['title', 'ppt', 'post_text', 'wb'].some((f) => pickField(obj, f) !== undefined);
}

/**
 * 解析用户上传的卡片 JSON：容忍 BOM、数组、以及 { card | data | result | payload } 包装。
 * 解析失败时给出可执行的两条路，而不是只说“格式不对”。
 */
export function parseCardJson(text) {
  const cleaned = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
  if (!cleaned) {
    throw new Error('卡片内容是空的。原因：没有读到任何文件内容，常见于只给了文件名但文件不存在，或粘贴时只粘了路径。两条路：① 用 `--file <完整路径>` 指向平台导出的 JSON；② 把 JSON 正文直接放进 `--text`。');
  }
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`卡片不是合法 JSON：${e.message}。原因：平台导出件是 JSON，但粘贴或另存时可能混入了说明文字、被聊天软件截断、或换行被破坏。两条路：① 回到平台重新导出这份卡，再用文件路径导入；② 用文本编辑器打开导出文件，确认首尾是 { 与 } 后再试。`);
  }

  let obj = data;
  if (Array.isArray(obj)) obj = obj[0];
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && !looksLikeCard(obj)) {
    for (const key of ['card', 'data', 'result', 'payload']) {
      const inner = obj[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner) && looksLikeCard(inner)) {
        obj = inner;
        break;
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('卡片 JSON 的顶层必须是一个对象。原因：读到的顶层是数组或基础类型，不是一份卡。两条路：① 确认导出的是「卡片」而不是「作品列表」；② 把数组里的那张卡单独存成一个对象再导入。');
  }
  return obj;
}

/** 识别格式：平台新版 v2 导出件 / 平台旧版键名导出件 / 内部规范结构 / 无法识别。 */
export function detectCardFormat(obj) {
  if (!obj || typeof obj !== 'object') return 'unknown';
  // 旧版导出件用过 nm / pre_text / post_tx / world_book / inner_css / ai_v_template / greet_st。
  const legacy = ['nm', 'pre_text', 'post_tx', 'world_book', 'inner_css', 'ai_v_template', 'greet_st']
    .some((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (legacy) return 'legacy';
  const v2 = ['name', 'pre_prompt', 'lore_bk'].some((k) => Object.prototype.hasOwnProperty.call(obj, k));
  const internal = ['title', 'ppt', 'wb'].some((k) => Object.prototype.hasOwnProperty.call(obj, k));
  if (v2) return 'v2';
  if (internal) return 'internal';
  return looksLikeCard(obj) ? 'v2' : 'unknown';
}

/** 记录某个规范字段实际命中的别名键名，便于排查字段漂移。 */
function pickedKey(source, canonical) {
  for (const key of FIELD_ALIASES[canonical] || [canonical]) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) return key;
  }
  return null;
}

/**
 * 把任意已知格式归一成内部规范卡；同时给出读入元信息（格式、别名命中、未知键）。
 * 注意：这是“整卡”归一，缺的字段会变成空串；不要拿它处理“只改几个字段”的补丁。
 */
export function normalizeReviewCard(obj) {
  const source = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const card = {};
  const fieldMap = {};
  for (const f of CARD_STRING_FIELDS) {
    const raw = pickField(source, f);
    card[f] = textOf(raw);
    const key = pickedKey(source, f);
    if (key) fieldMap[f] = key;
  }
  const rawWbValue = pickField(source, 'wb');
  const rawWb = rawWbValue === null ? undefined : rawWbValue;
  card.wb = Array.isArray(rawWb) ? rawWb.map((e, i) => normalizeLoreEntry(e, i)) : [];
  const rawRgxValue = pickField(source, 'rgx_rep');
  const rawRgx = rawRgxValue === null ? undefined : rawRgxValue;
  card.rgx_rep = normalizeRegexRules(rawRgx);
  const flag = pickPanelFlag(source);
  card.ext = { ai_variable_enabled: flag === true };
  const bg = pickBackground(source);
  card.bg_img = bg.bg_img || '';
  card.mobile_bg = bg.mobile_bg || '';

  const format = detectCardFormat(source);
  const recognized = card.ppt.trim() !== '' || card.post_text.trim() !== '' || card.wb.length > 0 || card.title.trim() !== '';
  const unknownKeys = Object.keys(source).filter((k) => !KNOWN_RAW_KEYS.has(k));
  const meta = {
    format,
    recognized,
    unknownKeys,
    fieldMap,
    topKeys: Object.keys(source).slice(0, 60),
    wbWasArray: rawWb === undefined ? null : Array.isArray(rawWb),
    rawRgxWasArray: rawRgx === undefined ? null : Array.isArray(rawRgx),
    panelFlag: typeof flag === 'boolean' ? flag : null,
    hasBackground: Boolean(card.bg_img || card.mobile_bg),
    readAt: new Date().toISOString(),
  };
  return { card, meta };
}

/**
 * 只归一“补丁”里出现的字段；没出现的字段保持 undefined，避免整卡覆盖。
 * 数组（wb / rgx_rep）按整体替换处理，这是最容易预期、也最不容易出错的语义。
 */
export function normalizePatch(obj) {
  const source = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const patch = {};
  for (const f of CARD_STRING_FIELDS) {
    const raw = pickField(source, f);
    if (raw !== undefined) patch[f] = textOf(raw);
  }
  const rawWb = pickField(source, 'wb');
  if (rawWb !== undefined) {
    if (!Array.isArray(rawWb)) throw new Error('补丁里的世界书字段不是数组。原因：wb / lore_bk 按整组替换处理，必须是数组；传入对象或字符串会被平台忽略，也会让改写版悄悄丢掉世界书。两条路：① 把 wb 写成数组（哪怕只有一条也要用 [ ] 包起来）；② 不提交这个字段，保持原卡世界书不变。');
    patch.wb = rawWb.map((e, i) => normalizeLoreEntry(e, i));
  }
  const rawRgx = pickField(source, 'rgx_rep');
  if (rawRgx !== undefined) {
    if (!Array.isArray(rawRgx)) throw new Error('补丁里的正则字段不是数组。原因：rgx_rep 按整组替换处理，必须是数组；类型不对会让改写版的正则被清空。两条路：① 把 rgx_rep 写成数组；② 不提交这个字段，保持原卡正则不变。');
    patch.rgx_rep = normalizeRegexRules(rawRgx);
  }
  const flag = pickPanelFlag(source);
  if (typeof flag === 'boolean') patch.ext = { ai_variable_enabled: flag };
  const bg = pickBackground(source);
  if (bg.bg_img) patch.bg_img = bg.bg_img;
  if (bg.mobile_bg) patch.mobile_bg = bg.mobile_bg;
  return patch;
}

function mergeCardPatch(card, patch) {
  const out = { ...card };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'ext') out.ext = { ...(card.ext || {}), ...(v || {}) };
    else out[k] = v;
  }
  return out;
}

/* ---------------- 未登记别名候选（本机，不随包发布） ---------------- */

export const ALIAS_SUGGESTIONS_FILE = 'alias-suggestions.json';

const ALIAS_SUGGEST_RULES = [
  ['title', /^(nm|name|card_?name|title)$/i],
  ['ppt', /^(pre_?prompt|ppt|system_?prompt|main_?prompt)$/i],
  ['ptx', /^(pre_?text|ptx|prefix)/i],
  ['post_text', /^(potx|post|suffix|尾缀|后置)/i],
  ['opening_statement', /^(opening|greet_?st|greeting)/i],
  ['wb', /^(world_?book|lore_?bk|wb|worldbook)$/i],
  ['desc', /^(desc|description|intro)$/i],
  ['built_in_css', /^(inner_?css|built_?in_?css|builtin_?css|css)$/i],
  ['rgx_rep', /^(rgx_?rep|regex_?replaces|regex)/i],
  ['ai_variable_tmpl', /^(ai_v_?template|ai_variable_?tmpl)/i],
  ['ai_v_prompt', /^(ai_v_?prompt|ai_variable_?prompt)/i],
  ['ai_v_json', /^(ai_v_?json|ai_variable_?json)/i],
  ['bg_img', /^(bg_?image|back_?img|bgimg|image_?bk)$/i],
  ['mobile_bg', /^(mobile_?bg|bgmob|bg_?mobile|bg_?mb)$/i],
];

/** 猜测未登记键最可能对应哪个规范字段；只写候选表，不自动改别名。 */
export function suggestCanonicalField(key) {
  const k = textOf(key);
  for (const [field, re] of ALIAS_SUGGEST_RULES) {
    if (re.test(k)) return field;
  }
  return null;
}

/** 记录未登记别名到 <out>/.card-build/alias-suggestions.json（gitignore，不进包）。 */
export function recordAliasSuggestions(out, meta, raw, sourceName) {
  const unknown = (meta && meta.unknownKeys) || [];
  if (!unknown.length) return null;
  const file = path.join(out, '.card-build', ALIAS_SUGGESTIONS_FILE);
  let data = {
    version: 1,
    note: '本机别名候选，不随插件发布；确认后把别名补进 lib/core.js 的 FIELD_ALIASES 并加测试，再发布框架。',
    updatedAt: '',
    suggestions: [],
  };
  if (fs.existsSync(file)) {
    try {
      const old = readJson(file);
      if (old && Array.isArray(old.suggestions)) data = { ...data, ...old };
    } catch { /* 坏文件重建，不阻断 ingest */ }
  }
  const map = new Map(data.suggestions.map((s) => [String(s && s.key), s]));
  const now = new Date().toISOString();
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const key of unknown) {
    const suggested = suggestCanonicalField(key);
    const value = src[key];
    const valueType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const chars = typeof value === 'string' ? value.length : Array.isArray(value) ? value.length : 0;
    const existing = map.get(key);
    if (existing) {
      existing.lastSeen = now;
      existing.count = (Number(existing.count) || 1) + 1;
      if (sourceName && !(existing.cards || []).includes(sourceName)) {
        existing.cards = [...(existing.cards || []), sourceName].slice(-10);
      }
      if (!existing.suggested && suggested) existing.suggested = suggested;
    } else {
      map.set(key, {
        key,
        suggested,
        valueType,
        chars,
        sample: typeof value === 'string' ? value.slice(0, 60) : '',
        firstSeen: now,
        lastSeen: now,
        count: 1,
        cards: sourceName ? [sourceName] : [],
      });
    }
  }
  data.updatedAt = now;
  data.suggestions = [...map.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, data);
  return { file: relPath(out, file), count: data.suggestions.length };
}

/* ---------------- 体量估算（内部相对量） ---------------- */

function resolveMemory(state, args = {}) {
  const roundsRaw = args.memory_rounds !== undefined ? args.memory_rounds : args.memoryRounds;
  const settingRaw = args.memory_setting !== undefined ? args.memory_setting : args.memorySetting;
  const roundsArg = Number(roundsRaw);
  const settingArg = Number(settingRaw);
  const summaryRaw = args.ai_summary !== undefined ? args.ai_summary : args.aiSummary;
  const aiSummary = summaryRaw !== undefined
    ? Boolean(summaryRaw)
    : Boolean(state && state.memory && state.memory.aiSummary);

  let rounds;
  let source;
  if (Number.isFinite(roundsArg) && roundsArg > 0) {
    rounds = Math.floor(roundsArg);
    source = 'memory_rounds';
  } else if (Number.isFinite(settingArg) && settingArg > 0) {
    // 平台历史按“消息”计数：一个玩家输入、一次 AI 输出各自算一条，不折算成一对。
    rounds = Math.max(1, Math.floor(settingArg));
    source = 'memory_setting';
  } else if (state && state.memory && Number.isFinite(state.memory.rounds) && state.memory.rounds > 0) {
    rounds = state.memory.rounds;
    source = state.memory.source || 'state';
  } else {
    rounds = DEFAULT_MEMORY_ROUNDS;
    source = 'default';
  }
  if (aiSummary) {
    rounds = 1;
    source = 'ai_summary';
  }
  const playerInputChars = Number.isFinite(args.player_input_chars)
    ? Math.max(0, Math.floor(args.player_input_chars))
    : (Number.isFinite(state && state.memory && state.memory.playerInputChars) ? state.memory.playerInputChars : undefined);
  const aiOutputChars = Number.isFinite(args.ai_output_chars)
    ? Math.max(0, Math.floor(args.ai_output_chars))
    : (Number.isFinite(state && state.memory && state.memory.aiOutputChars) ? state.memory.aiOutputChars : undefined);
  return {
    rounds,
    unit: 'message',
    aiSummary,
    source,
    playerInputChars,
    aiOutputChars,
    label: aiSummary ? '开启 AI 总结（历史固定 1 条）' : (source === 'default' ? '默认按 5 条历史消息估算' : `按 ${rounds} 条历史消息估算`),
  };
}

/** 从正则触发词里抽出会原样出现在文本中的字面量（用于判断是否每轮命中）。 */
export function regexLiterals(pattern) {
  let s = String(pattern || '');
  s = s.replace(/\\([dDsSwWbBnrtfv])/g, ' ').replace(/\\(.)/g, '$1');
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\(\?[^)]*\)/g, ' ');
  s = s.replace(/[(){}|^$*+?.\\]/g, ' ');
  const out = [];
  for (const m of s.matchAll(/[\u4e00-\u9fffA-Za-z0-9]{2,}/g)) out.push(m[0]);
  return [...new Set(out)].slice(0, 20);
}

function entryTokens(entry) {
  const key = textOf(entry && entry.key);
  if (!key) return [];
  if (key.startsWith('_or_') || key.startsWith('_and_')) return wbTokens(key).slice(0, 50);
  return regexLiterals(key);
}

function isOn(entry) {
  return !entry || entry.enable !== false;
}

/** 估算单条世界书的触发面：常驻 / 条件 / 停用。 */
function classifyEntry(entry, card) {
  const tokens = entryTokens(entry);
  const kr = Number(entry.key_region);
  const aiSide = kr === 4 || kr === 6;
  const userSide = kr === 2 || kr === 6;
  const post = textOf(card.post_text);
  const ptx = textOf(card.ptx);
  const ppt = textOf(card.ppt);
  const inPost = tokens.filter((t) => post.includes(t));
  const inPtx = tokens.filter((t) => ptx.includes(t));
  const inPpt = tokens.filter((t) => ppt.includes(t));
  const andMode = Number(entry.match_type) === 1;
  const resident = isOn(entry) && tokens.length > 0 && (
    andMode
      ? (aiSide && inPost.length === tokens.length) || (userSide && inPtx.length === tokens.length)
      : (aiSide && inPost.length > 0) || (userSide && inPtx.length > 0)
  );
  return { tokens, inPost, inPtx, inPpt, resident };
}

/** 每轮体量估算（内部相对量）+ 世界书分布。不宣称平台 token 或积分消耗。 */
export function estimateMetrics(card, opts = {}) {
  const memory = opts.memory && Number.isFinite(opts.memory.rounds)
    ? opts.memory
    : resolveMemory(opts.state || null, opts);
  const rounds = memory.rounds;

  const chars = {};
  for (const f of CARD_STRING_FIELDS) chars[f] = charLen(card[f]);
  chars.worldbook_total = (card.wb || []).reduce((s, e) => s + charLen(e && e.value), 0);

  const entries = Array.isArray(card.wb) ? card.wb : [];
  const classified = entries.map((e, i) => ({ i, entry: e, ...classifyEntry(e, card) }));
  const resident = classified.filter((x) => x.resident);
  const residentChars = resident.reduce((s, x) => s + charLen(x.entry.value), 0);
  const enabled = entries.filter(isOn).length;
  const enabledChars = entries.filter(isOn).reduce((s, e) => s + charLen(e && e.value), 0);
  const disabledChars = Math.max(0, chars.worldbook_total - enabledChars);
  const budgetProfileKey = detectComplexity(card);
  const budget = WB_BUDGET_PROFILES[budgetProfileKey] || WB_BUDGET_PROFILES.simple;

  chars.worldbook_resident = residentChars;
  const fixedChars = chars.ppt + chars.ptx + chars.post_text;
  const panelEnabled = Boolean(card.ext && card.ext.ai_variable_enabled);
  // 变量面板：只有「变量提示词」明确是每轮注入 AI 的；面板模板是浏览器端的皮肤，
  // Schema 是否进上下文未确认，两者都不计入体量，只作为展示层体积报告。
  const panelChars = panelEnabled ? chars.ai_v_prompt : 0;
  // 平台当前轮注入 = 主提示词 + 前缀 + 本次玩家输入 + 后缀 + 触发世界书 + 变量提示词。
  // 历史 = 用户设置的历史消息条数；一个玩家输入、一个 AI 输出各算一条。
  const playerInputChars = Number.isFinite(opts.playerInputChars)
    ? Math.floor(opts.playerInputChars)
    : (Number.isFinite(memory.playerInputChars) ? Math.floor(memory.playerInputChars) : 100);
  const aiOutputChars = Number.isFinite(opts.aiOutputChars)
    ? Math.floor(opts.aiOutputChars)
    : (Number.isFinite(memory.aiOutputChars) ? Math.floor(memory.aiOutputChars) : 1000);
  const historyMessages = rounds;
  const historyUserMessages = Math.ceil(historyMessages / 2);
  const historyAiMessages = historyMessages - historyUserMessages;
  const historyChars = historyUserMessages * playerInputChars + historyAiMessages * aiOutputChars;
  const currentTurnChars = fixedChars + playerInputChars + residentChars + panelChars;
  const perTurnChars = currentTurnChars + historyChars;

  const token = {
    fixedChars,
    currentTurnChars,
    historyChars,
    historyMessages,
    historyUserMessages,
    historyAiMessages,
    playerInputChars,
    aiOutputChars,
    growthChars: historyChars,
    rounds,
    amplification: 1,
    growthAssumption: 'platform-current-turn-plus-message-history',
    residentChars,
    panelChars,
    perTurnChars,
    perTurnMin: round(perTurnChars * CJK_TOKEN.min),
    perTurnMax: round(perTurnChars * CJK_TOKEN.max),
    // AI 输出侧：只能按后置词模板估算「最低输出量」，实际正文通常更长。
    outputChars: chars.post_text,
    outputMin: round(chars.post_text * CJK_TOKEN.min),
    outputMax: round(chars.post_text * CJK_TOKEN.max),
    perTurnTotalMin: round(perTurnChars * CJK_TOKEN.min + chars.post_text * CJK_TOKEN.min),
    perTurnTotalMax: round(perTurnChars * CJK_TOKEN.max + chars.post_text * CJK_TOKEN.max),
    firstTurnMin: round(currentTurnChars * CJK_TOKEN.min),
    firstTurnMax: round(currentTurnChars * CJK_TOKEN.max),
    cjkPerChar: CJK_TOKEN,
    note: '内部按字符数折算成相对体量单位（1 个中文字约 1.0–1.7 个单位），只用于同一张卡的前后对比；这不是平台 token 或积分消耗，平台按积分计费，我们无法估算。公式按平台当前轮注入计算：当前轮 = ppt + ptx + 本次玩家输入 + post_text + 常驻世界书 + 变量提示词；历史 = 用户设置的历史消息条数（玩家输入与 AI 输出各算一条，分别用默认 100 / 1000 字估算，可用参数覆盖）。世界书条件条目触发时另加。输出只按后置词模板的最低量折算，实际正文更长。',
  };

  const variables = {
    enabled: panelEnabled,
    promptChars: chars.ai_v_prompt,
    schemaChars: chars.ai_v_json,
    skinChars: chars.ai_variable_tmpl,
    countedChars: panelChars,
    note: '变量提示词按每轮注入计入体量；模板（ai_variable_tmpl / ai_v_template）是面板皮肤、走浏览器，不计；Schema 是否进上下文未确认，未计入。',
  };

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
  }

  return {
    memory,
    chars,
    token,
    variables,
    worldbook: {
      count: entries.length,
      enabled,
      disabled: entries.length - enabled,
      residentCount: resident.length,
      residentChars,
      enabledChars,
      disabledChars,
      conditionalChars: Math.max(0, enabledChars - residentChars),
      budgetProfile: budgetProfileKey,
      residentBudget: budget.total,
      entryBudget: budget.entry,
      byRegion,
      byMatch,
      sortSet,
      depthSet,
      probNot100,
      longest: entries
        .map((e, i) => ({ index: i, group: textOf(e && e.group), key: textOf(e && e.key), chars: charLen(e && e.value) }))
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 5),
    },
    regex: {
      total: Array.isArray(card.rgx_rep) ? card.rgx_rep.length : 0,
      enabled: (card.rgx_rep || []).filter((r) => r && r.is_enable !== false).length,
      onlyRenderTrue: (card.rgx_rep || []).filter((r) => r && r.is_only_render === true).length,
      onlyRenderFalse: (card.rgx_rep || []).filter((r) => r && r.is_only_render !== true).length,
    },
    structure: {
      fields: Object.fromEntries(CARD_STRING_FIELDS.map((f) => [f, chars[f] > 0])),
      panelEnabled,
      background: Boolean(card.bg_img || card.mobile_bg),
    },
  };
}

/* ---------------- 审计 ---------------- */

function fixFor(code, issue) {
  if (issue && issue.fix) return issue.fix;
  if (/^WB/.test(code)) return '按世界书规则修正该条：匹配类型前缀（_and_/_or_）、触发方向（USER=2/AI=4/组队=6）、正文与触发词；修不了就删掉该条。';
  if (/^RGX/.test(code)) return '修正这条正则：补齐 is_enable 与 replace_text，保证表达式能编译；平台会跳过无效规则。';
  if (/^CSS/.test(code)) return '按聊天页样式规范修正锚点与状态变量；不改平台已登记 ID 之外的选择器。';
  if (code === 'CUE014') return '删掉这类针对 AI 自身的破限话术；要表达同一效果就改写成世界内设定。';
  if (code === 'CUE011') return '把自我审查痕迹改回正常描写；当前模型不写就换模型重写，不要保留删改版。';
  if (code === 'CUE009') return '删掉免责声明与内容警告：目标平台不需要，且会占上下文。';
  if (code === 'CUE013') return '补玩家代理边界：写清「停在玩家可接管的点」，并列禁止代做项。';
  if (code === 'CUE015') return '补【内容纪律】三行：必须呈现 / 允许出现 / 禁止出现。';
  if (code === 'CUE017') return '二选一：走模板派（删多余正则，直接给标签写 CSS）或走正则派（只输出纯文本锚点，由正则包结构）。';
  if (code === 'CUE018') return '改锚点让提示词输出它能匹配的纯文本，或删掉这条正则；只针对运行期数值的规则可忽略。';
  return '按提示修正。';
}

function pushUnique(issues, seen, issue) {
  const key = `${issue.code}|${issue.where}|${issue.message}`;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push(issue);
}

/**
 * 问题的稳定身份：用于判断改写后是不是「新增」。
 * 世界书按条目配置（key/方向/匹配类型）认，不按数组下标认——删掉前面的条目不应把旧问题算成新问题。
 */
function issueIdentity(issue, card) {
  const code = String(issue && issue.code);
  const where = String(issue && issue.where);
  const wbMatch = where.match(/^wb\[(\d+)\]$/);
  if (wbMatch) {
    const entry = (Array.isArray(card && card.wb) ? card.wb : [])[Number(wbMatch[1]) - 1];
    if (entry) {
      if (code.startsWith('WB') || code === 'RV204') {
        return `${code}|wb|${textOf(entry.match_type)}|${textOf(entry.key)}|${textOf(entry.key_region)}|${textOf(entry.value_region)}`;
      }
      return `${code}|wb|${textOf(entry.match_type)}|${textOf(entry.key)}|${sha256(textOf(entry.value))}`;
    }
  }
  const rgxMatch = where.match(/^rgx_rep\[(\d+)\]$/);
  if (rgxMatch) {
    const rule = (Array.isArray(card && card.rgx_rep) ? card.rgx_rep : [])[Number(rgxMatch[1]) - 1];
    if (rule) {
      return `${code}|rgx|${textOf(rule.match_regex)}|${textOf(rule.replace_text)}|${textOf(rule.scope)}|${String(rule.is_only_render)}`;
    }
  }
  return `${code}|${where}|${String(issue && issue.message).replace(/\d+/g, '#')}`;
}

/** 触发词符号完整性：只查能确定的结构错误；空格/冒号是否合法交给 AI 对照卡片自己的输出字段判断。 */
const BRACKET_PAIRS = [['【', '】'], ['[', ']'], ['「', '」'], ['《', '》'], ['（', '）'], ['(', ')']];

function triggerTokenProblem(token) {
  const t = textOf(token).trim();
  if (!t) return '空词';
  for (const [open, close] of BRACKET_PAIRS) {
    const o = (t.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const c = (t.match(new RegExp(`\\${close}`, 'g')) || []).length;
    if (o !== c) return `括号不成对（${open} ${o} 个 / ${close} ${c} 个）`;
  }
  return '';
}

/** 世界书正文里的「触发机制说明」：这类内容属于 ppt 的运行规则，不属于世界知识。 */
const TRIGGER_META_PATTERNS = [
  /玩家(?:的)?输入中(?:出现|包含|含有)[^\n。；;]{0,24}(?:标记|关键词|触发词)/,
  /(?:全角|半角)[^\n。；;]{0,24}(?:变体|形式)/,
  /(?:标记|关键词|触发词)[^\n。；;]{0,16}(?:视为|判定为|触发|加载)/,
  /(?:世界书|条目|本条)[^\n。；;]{0,12}(?:触发|加载|生效)/,
];

function triggerMetaHit(value) {
  const v = textOf(value);
  for (const re of TRIGGER_META_PATTERNS) {
    const m = v.match(re);
    if (m) return m[0];
  }
  return '';
}

/** 世界书正文里的全局优先级/防守性命令：如果必须每轮生效，应放 ppt，而不是按需条目。 */
const DEFENSIVE_PATTERNS = [
  /本轮视为[^\n。；;]{0,20}(请求|指令|触发|开始)/,
  /优先于[^\n。；;]{0,12}(普通剧情|剧情推进|其他规则)/,
  /(最高|第一)优先级/,
  /(必须优先|不得越过|一律按|必须首先)/,
];

function defensiveHit(value) {
  const v = textOf(value);
  for (const re of DEFENSIVE_PATTERNS) {
    const m = v.match(re);
    if (m) return m[0];
  }
  return '';
}

/** 嵌套量词的灾难性回溯风险分级。0=低风险，1=启发式疑似，2=高置信。 */
const SAFE_NESTED_WS = /\(\?:?[^)]*(?:\\r|\\n)[^)]*\[[^\]]*\][*+][^)]*\)[*+]/;
const HIGH_NESTED = /\((?:\.\*|\.\+|\\w[*+]|\\d[*+]|\\s[*+]|\[[^\]]*\][*+]|[A-Za-z0-9])[+*]\)[+*]/;
const ANY_NESTED = /\([^)]*[+*][^)]*\)[+*]/;

function catastrophicLevel(pattern) {
  const p = textOf(pattern);
  if (!p) return 0;
  // 常见安全形态：外层重复的组里必须出现换行，内层只是空白类；每轮都要消费 \n，不是指数回溯。
  if (SAFE_NESTED_WS.test(p)) return 0;
  if (HIGH_NESTED.test(p)) return 2;
  if (ANY_NESTED.test(p)) return 1;
  return 0;
}
function sectionCount(value) {
  return (textOf(value).match(/(^|\n)\s*(?:[一二三四五六七八九十]+、|#{1,3}\s|\d+[.．]\s)/g) || []).length;
}

/**
 * 上传卡审计：结构 + 体量 + 逻辑三层的机械检查。
 * 返回的 issues 带 code / layer / severity / where / message / fix / saving。
 */
export function auditReview(card, opts = {}) {
  const memory = opts.memory && Number.isFinite(opts.memory.rounds)
    ? opts.memory
    : resolveMemory(opts.state || null, opts);
  const meta = opts.meta || {};
  const metrics = estimateMetrics(card, { ...opts, memory });
  const issues = [];
  const seen = new Set();
  const add = (code, layer, severity, where, message, fix, extra = {}) => {
    pushUnique(issues, seen, { code, layer, severity, where, message, fix: fix || fixFor(code), ...extra });
  };

  /* --- 结构 --- */
  if (!textOf(card.title).trim()) add('RV001', 'structure', 'warning', 'title', '缺少卡名：平台列表与报告里都只能显示“未命名”。', '补 name（v2）或 title（内部结构）。');
  if (!textOf(card.ppt).trim()) add('RV002', 'structure', 'error', 'ppt', '主提示词为空：AI 拿不到任何运行规则，这张卡基本等于没做。', '把角色与世界的核心规则写进 pre_prompt（v2）或 ppt。');
  if (!textOf(card.post_text).trim()) add('RV003', 'structure', 'warning', 'post_text', '后缀词为空：没有每轮状态快照，长会话容易丢设定，聊天页也没有稳定锚点。', '补后置词，并以【时间地点】为固定首段。');
  if (!textOf(card.ptx).trim()) add('RV004', 'structure', 'info', 'ptx', '前缀词为空：不是错误，但少了一层每轮状态提醒。', '有状态栏需求时再补；不需要可以忽略。');

  // 开场白为空不是错误：有的前端初始化页会在内部生成开场指令并复制给玩家。
  // 静态检测到复制/剪贴板能力时视为已由前端处理；否则不报错，只生成一个待确认问题。
  const openingText = textOf(card.opening_statement).trim();
  const descText = textOf(card.desc);
  const frontendCopyDetected = /navigator\.clipboard|clipboard\.writeText|execCommand\s*\(\s*['"]copy|data-copy|复制(?:信息|指令|到对话|档案|开场|文本)?/i.test(descText);
  const questions = [];
  const guidance = [
    '触发词含空格、冒号或标题符号时，先找卡片自己规定的输出字段（ppt / ptx / post_text / ai_v_prompt）；和卡片格式一致的是格式锚，不一致才报错。插件不预设任何字段名。',
    '判断正文范围与触发词范围：正文只服务某个地点/状态、触发词却是通用行为词 → 提示可能同时触发；触发词是卡片规定的格式时，只有内容与该条目不一致才报错。',
  ];
  let openingCheck;
  if (!openingText) {
    if (frontendCopyDetected) {
      openingCheck = {
        empty: true,
        frontendCopyDetected: true,
        handledByFrontend: true,
        needsUserConfirmation: false,
        note: '开场白为空，但 desc 检测到复制/剪贴板功能：按前端已内置开场指令处理，不报错。',
      };
    } else {
      openingCheck = {
        empty: true,
        frontendCopyDetected: false,
        handledByFrontend: false,
        needsUserConfirmation: true,
        note: '开场白为空，desc 未检测到复制功能：不能确定前端是否已内置开场指令。不报错，先问用户确认。',
      };
      questions.push('开场白为空：前端网页是否已经内置开场指令，并带有复制功能？若是，确认后按已处理；若否，请补 opening_statement 或让前端生成开场文本。');
    }
  } else {
    openingCheck = {
      empty: false,
      frontendCopyDetected,
      handledByFrontend: false,
      needsUserConfirmation: false,
      note: '开场白非空，不需要确认。',
    };
  }

  const post = textOf(card.post_text);
  // 上传卡不一定用四部分模板：有的卡把前缀/后缀当作玩家输入定义，状态由世界书规则驱动。
  // 这类卡不能套用【时间地点】首段与 IDLE/CONTINUE/END 的框架约定，否则会误报并诱导改坏原卡。
  const inputDefinition = /【玩家输入】|PREFIX PROMPT|POSTFIX PROMPT/.test(post);
  const customPost = inputDefinition && !post.includes('【时间地点】');
  if (!customPost && post.trim() && !post.includes('【时间地点】')) {
    add('RV005', 'structure', 'warning', 'post_text', '后缀词里没有【时间地点】固定首段：聊天页类样式与正则需要稳定锚点，缺了只能靠猜。', '把【时间地点】放到后置词第一段，并写「时间：」「地点：」两个字段。');
  } else if (!customPost && post.includes('【时间地点】')) {
    const block = post.slice(post.indexOf('【时间地点】'));
    const miss = [];
    if (!/时间[：:]/.test(block)) miss.push('时间');
    if (!/地点[：:]/.test(block)) miss.push('地点');
    if (miss.length) add('RV006', 'structure', 'warning', 'post_text', `【时间地点】段缺少「${miss.join('、')}：」字段：格式不完整，玩家看到的状态会缺项。`, '补齐两个固定字段名，不要改成「时地」等其他写法。');
  }
  if (meta.wbWasArray === false) add('RV007', 'structure', 'error', 'wb', '世界书字段不是数组：平台会忽略或报错。', '把 lore_bk / wb 改成数组，每个元素一条。');
  // RV234：字段读成空，但原卡有疑似同义的未识别键。别名缺失时最危险：审计看到 0 字，导出会把整段丢掉。
  const unknown = (meta.unknownKeys || []).map(String);
  const suspicion = [
    ['post_text', /potx|post|suffix|后置|尾缀/i],
    ['ptx', /pre_?t|prefix|前置/i],
    ['desc', /desc|intro|description/i],
    ['opening_statement', /opening|greet/i],
    ['built_in_css', /inner_?css|builtin_?css/i],
  ];
  for (const [field, re] of suspicion) {
    if (textOf(card[field]).trim()) continue;
    const hit = unknown.filter((k) => re.test(k));
    if (!hit.length) continue;
    add('RV234', 'structure', 'warning', 'root', `${field} 为空，但原卡有未识别字段「${hit.join('、')}」：很可能是别名缺失或字段改名。直接审计会把 0 字当成真实空字段，导出时这段内容会丢失。`, `把该键补进 lib/core.js 的 FIELD_ALIASES（例如 potx → post_text），或在导出件里改成规范键名后重新 ingest；不要当作字段真的为空。`);
  }
  if ((meta.unknownKeys || []).length) {
    add('RV008', 'structure', 'info', 'root', `有 ${meta.unknownKeys.length} 个未识别字段：${meta.unknownKeys.slice(0, 8).join('、')}${meta.unknownKeys.length > 8 ? ' 等' : ''}。这些字段不会进入审计，导出时也不会写入优化版。`, '若它们属于平台设置且需要保留，导出时工具会原样保留已知的平台键；未知键请自行确认。');
  }

  /* --- 体量 --- */
  const c = metrics.chars;
  const t = metrics.token;
  if (c.ppt > PPT_WARN_CHARS) {
    add('RV101', 'consumption', 'warning', 'ppt', `主提示词 ${c.ppt} 字，超过 ${PPT_WARN_CHARS} 字的提醒线：它每轮都进上下文，是最贵的固定开销。`, '先删重复规则、把细则外置成按需世界书、合并同义条目；目标压到 3000 字以内。');
  }
  if (c.ptx + c.post_text > GROWTH_WARN_CHARS) {
    add('RV102', 'consumption', 'warning', 'ptx+post_text', `前缀词+后缀词合计 ${c.ptx + c.post_text} 字，每轮都要带：长会话里会反复累积。`, '压缩状态栏：只保留必要字段，删示例与说明文字，固定段落用占位模板。');
  }
  if (metrics.worldbook.residentChars > metrics.worldbook.residentBudget) {
    const over = metrics.worldbook.residentChars - metrics.worldbook.residentBudget;
    const profile = WB_BUDGET_PROFILES[metrics.worldbook.budgetProfile] || WB_BUDGET_PROFILES.simple;
    add('RV104', 'consumption', 'warning', 'wb', `世界书常驻合计 ${metrics.worldbook.residentChars} 字，超过${profile.label}预算 ${metrics.worldbook.residentBudget} 字/轮，超出 ${over} 字。这些条目会每轮加载。`, `按顺序削：① 改挂格式标记锚按状态加载；② 压缩重复否定清单；③ 把通用规则移进 ppt；④ 拆长条目。`, { saving: { chars: over, kind: 'perTurn' } });
  }
  const wb = Array.isArray(card.wb) ? card.wb : [];
  const longResident = [];
  wb.forEach((e, i) => {
    if (!isOn(e)) return;
    if (!classifyEntry(e, card).resident) return;
    const len = charLen(e && e.value);
    if (len > metrics.worldbook.entryBudget) longResident.push({ i, len });
  });
  longResident.slice(0, 10).forEach(({ i, len }) => {
    add('RV105', 'consumption', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条常驻正文 ${len} 字，超过单条上限 ${metrics.worldbook.entryBudget} 字。`, '拆成多条按主题，或改挂条件触发；单条过长会挤占正文空间。');
  });
  if (longResident.length > 10) {
    add('RV105', 'consumption', 'warning', 'wb', `另有 ${longResident.length - 10} 条常驻世界书超过单条上限 ${metrics.worldbook.entryBudget} 字，需要一起拆分或改条件触发。`, '按主题拆分；长清单类内容改挂格式标记锚或移进 ppt 的关键规则。');
  }

  const sig = new Map();
  wb.forEach((e, i) => {
    const s = `${Number(e.match_type)}|${textOf(e.key)}|${textOf(e.value)}`;
    if (!sig.has(s)) sig.set(s, []);
    sig.get(s).push(i);
  });
  for (const [, list] of sig) {
    if (list.length < 2) continue;
    const keep = list[0];
    for (const i of list.slice(1)) {
      add('RV106', 'consumption', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条与第 ${keep + 1} 条完全相同（触发条件与正文都一样）：触发时只会重复注入同一份内容。`, '删掉重复条目，保留一条即可。', { saving: { chars: charLen(wb[i].value), kind: 'perTrigger' } });
    }
  }
  const keyMap = new Map();
  wb.forEach((e, i) => {
    const k = `${Number(e.match_type)}|${textOf(e.key)}`;
    if (!keyMap.has(k)) keyMap.set(k, []);
    keyMap.get(k).push(i);
  });
  for (const [, list] of keyMap) {
    if (list.length < 2) continue;
    const values = new Set(list.map((i) => textOf(wb[i].value)));
    if (values.size < 2) continue; // 完全重复由 RV106 负责，这里只抓同 key 不同正文
    add('RV107', 'consumption', 'warning', `wb[${list.map((i) => i + 1).join('/')}]`, `第 ${list.map((i) => i + 1).join('、')} 条共用同一个触发条件但正文不同：触发时会一起加载，通常是复制旧条目后忘了改 key。`, '确认是否需要同时加载：不需要就合并正文或改掉其中一条的 key。');
  }

  const writeBack = (card.rgx_rep || [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && r.is_enable !== false && r.is_only_render !== true);
  if (writeBack.length) {
    add('RV108', 'consumption', 'warning', 'rgx_rep', `有 ${writeBack.length} 条正则没有标 is_only_render=true（第 ${writeBack.map((x) => x.i + 1).join('、')} 条）：替换结果可能回写进上下文，既增加体量，也可能被下一轮再匹配。`, '纯展示类替换统一标 is_only_render=true；需要回写的才保留 false。');
  }

  const lines = textOf(card.ppt).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 6);
  const lineCount = new Map();
  for (const l of lines) lineCount.set(l, (lineCount.get(l) || 0) + 1);
  const dupLines = [...lineCount.entries()].filter(([, n]) => n > 1);
  if (dupLines.length) {
    const saved = dupLines.reduce((s, [l, n]) => s + (n - 1) * (charLen(l) + 1), 0);
    add('RV109', 'consumption', 'warning', 'ppt', `主提示词里有 ${dupLines.length} 组重复行（共多出 ${saved} 字）：重复规则不会更有效，只会更贵。`, '每组只保留一条；如果是强调，用一句“以下规则优先级最高”代替重复。', { saving: { chars: saved, kind: 'perTurn' } });
  }

  // RV237：跨层重复候选（ppt / ptx / post_text）。只提示，不自动删；先问用户是否属于“靠近玩家输入的必要重复”。
  const crossSources = [
    ['ppt', textOf(card.ppt)],
    ['ptx', textOf(card.ptx)],
    ['post_text', textOf(card.post_text)],
  ];
  const normalizeCross = (s) => s.replace(/\d+(?:\.\d+)?/g, '#').replace(/[\s，。！？；：、,.!?;:"'“”‘’（）()【】\[\]<>《》]/g, '').toLowerCase();
  const splitCross = (text) => text.split(/\n+|(?<=[。！？!?；;])/).map((s) => s.trim()).filter((s) => s.length >= 30 && s.length <= 600);
  const crossMap = new Map();
  for (const [layer, text] of crossSources) {
    for (const segment of splitCross(text)) {
      const norm = normalizeCross(segment);
      if (norm.length < 24) continue;
      const item = crossMap.get(norm) || { sample: segment, layers: new Set(), chars: segment.length };
      item.layers.add(layer);
      crossMap.set(norm, item);
    }
  }
  const crossCandidates = [...crossMap.values()].filter((v) => v.layers.size >= 2);
  // 近似重复：只比较 ppt 与 ptx/post 的长段，阈值保守，避免把不同规则当成重复。
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
  };
  const pptSegs = splitCross(textOf(card.ppt)).map((s) => ({ raw: s, norm: normalizeCross(s) })).filter((x) => x.norm.length >= 24);
  for (const [layer, text] of [['ptx', textOf(card.ptx)], ['post_text', textOf(card.post_text)]]) {
    for (const segment of splitCross(text)) {
      const norm = normalizeCross(segment);
      if (norm.length < 24) continue;
      for (const p of pptSegs) {
        if (Math.abs(norm.length - p.norm.length) > Math.max(20, p.norm.length * 0.5)) continue;
        const score = jaccard(bigrams(norm), bigrams(p.norm));
        if (score < 0.82) continue;
        if (norm === p.norm || norm.includes(p.norm) || p.norm.includes(norm)) continue;
        if (crossCandidates.some((c) => normalizeCross(c.sample) === norm || normalizeCross(c.sample) === p.norm)) continue;
        crossCandidates.push({ sample: `${p.raw.slice(0, 40)}… / ${segment.slice(0, 40)}…`, layers: new Set(['ppt', layer]), chars: Math.max(p.raw.length, segment.length), near: true });
      }
    }
  }
  if (crossCandidates.length) {
    const examples = crossCandidates.slice(0, 4).map((c) => `${[...c.layers].join('↔')}「${c.sample.slice(0, 36)}…」`).join('；');
    add('RV237', 'consumption', 'info', 'ppt/ptx/post_text', `发现 ${crossCandidates.length} 组跨层重复候选：${examples}。这不是自动删除项；靠近玩家输入的重复可能是有意设计，先判断是“必要重复”还是“纯复制”。`, '先问用户：哪些是刻意放在前缀/后缀里以提高遵循率的必要重复，哪些只是复制主提示词；确认前不要自动改。');
    const q = '发现 ppt / ptx / post_text 跨层重复候选：请确认哪些是为了靠近玩家输入而有意保留的规则，哪些是纯复制；确认前不要自动删改。';
    if (!questions.includes(q)) questions.push(q);
  }

  const panelOn = Boolean(card.ext && card.ext.ai_variable_enabled);
  const panelText = [textOf(card.ai_variable_tmpl), textOf(card.ai_v_prompt), textOf(card.ai_v_json)].join('');
  if (panelOn && !textOf(card.ai_v_json).trim()) {
    add('RV110', 'consumption', 'warning', 'ai_v_json', '变量面板已开启，但 ai_v_json 为空：平台没有可渲染的字段定义，面板会显示空白或报错。', '补齐 JSON schema，或把 extend.ai_variable_enabled 关掉。');
  } else if (panelOn && textOf(card.ai_v_json).trim()) {
    try {
      JSON.parse(textOf(card.ai_v_json));
    } catch {
      add('RV110', 'consumption', 'warning', 'ai_v_json', '变量面板已开启，但 ai_v_json 不是合法 JSON：面板初始化会失败。', '修正 JSON 语法（引号、逗号、括号），或先关闭面板。');
    }
  }
  if (!panelOn && panelText.trim()) {
    add('RV111', 'consumption', 'info', 'ai_variable_*', '变量面板已关闭，但变量模板/定义里仍有内容：不会生效，只会让人误以为面板在工作。', '确认是否漏开面板；确定不用就把三个字段清空。');
  }
  if (c.opening_statement > OPENING_WARN_CHARS) add('RV112', 'consumption', 'info', 'opening_statement', `开场白 ${c.opening_statement} 字，偏长：只在首轮出现，但仍占首轮上下文。`, '开场白只交代场景与玩家能做的事，设定细节放世界书按需加载。');
  if (c.desc > DESC_WARN_CHARS || c.built_in_css > CSS_WARN_CHARS || c.ai_variable_tmpl > CSS_WARN_CHARS) {
    add('RV113', 'consumption', 'info', 'desc/built_in_css/ai_variable_tmpl', `展示层体积偏大（desc ${fmt(c.desc)} 字 / CSS ${fmt(c.built_in_css)} 字 / 面板模板 ${fmt(c.ai_variable_tmpl)} 字）：不占 AI 上下文，但会拖慢页面加载。`, '压缩图片为外链、删未使用的 CSS 与模板分支；面板模板只在需要时加载。');
  }
  wb.forEach((e, i) => {
    if (!textOf(e.value).trim()) add('RV115', 'consumption', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条正文为空：触发了也注入不了任何内容，白占一条。`, '补正文或删掉这条。');
  });
  const disabled = wb.filter((e) => e && e.enable === false).length;
  if (disabled) add('RV116', 'consumption', 'info', 'wb', `有 ${disabled} 条世界书是停用状态（enable=false）：不会触发，但会留在导出件里。`, '确认是否还需要；不需要就删掉，减少维护噪音。');

  /* --- 逻辑 --- */
  const residentNotes = [];
  const pptHits = [];
  const selfNotes = [];
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const cls = classifyEntry(e, card);
    if (!cls.tokens.length) return;
    const kr = Number(e.key_region);
    const aiSide = kr === 4 || kr === 6;
    const value = textOf(e.value);
    const selfHits = cls.tokens.filter((tk) => value.includes(tk));
    if (aiSide && selfHits.length) selfNotes.push({ i, hits: selfHits });
    if (cls.resident) residentNotes.push({ i, cls, body: textOf(e.value) });
    else if (cls.inPpt.length) pptHits.push({ i, cls });
  });
  selfNotes.slice(0, 8).forEach(({ i, hits }) => {
    add('RV201', 'logic', 'info', `wb[${i + 1}]`, `第 ${i + 1} 条触发词「${hits.join('、')}」出现在它自己的正文里。平台不会直接扫描条目正文；只有 AI 在回复中复述这个词时，下一轮才可能因 AI 区触发再次加载。这是一条间接风险，不是平台自动自触发循环。`, '先判断这条是否本来就应持续在场：是就保留；只有确认不想它常驻时，才改触发词或把方向改为仅玩家输入。不要仅因这条提示强制改词。');
  });
  if (selfNotes.length > 8) {
    const rest = selfNotes.slice(8).map((x) => x.i + 1);
    add('RV201', 'logic', 'info', `wb[${rest.slice(0, 8).join('/')}${rest.length > 8 ? ' 等' : ''}]`, `另有 ${rest.length} 条世界书的触发词出现在自己的正文里（第 ${rest.slice(0, 8).join('、')}${rest.length > 8 ? ' 等' : ''}，共 ${rest.length} 条）。平台不会直接扫描正文；这是 AI 复述后下一轮可能命中的间接风险，不是自动自触发。`, '逐条判断是否本来就需要持续加载；需要就保留，不需要再改词。不要按数量一刀切。');
  }
  residentNotes.slice(0, 10).forEach(({ i, cls, body }) => {
    const where = cls.inPost.length ? '后置词' : '前缀词';
    const hits = (cls.inPost.length ? cls.inPost : cls.inPtx).slice(0, 4).join('、');
    // 先判断内容角色：每轮都要的格式/状态规则，改成稀有触发词反而会让它缺场。
    const formatLike = /(状态栏|时间地点|输出格式|每轮|字段|IDLE|CONTINUE|END|系统等级|任务栏|记忆区)/.test(body);
    const fix = formatLike
      ? '先判断它是否必须每轮在场：是格式/状态/路由规则就保留常驻触发词，优先压缩体量，不要为了省体量改成稀有词；只有确实只服务某场景时才换内容锚。'
      : '先判断这段文本运行时是否每轮都需要：需要就保留常驻并按预算压缩；只是某场景知识才换成内容锚。拿不准就在方案里标出来问用户，不要直接改触发词。';
    add('RV202', 'logic', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条的触发词出现在${where}里（${hits}）：这两段每轮注入，所以它会每轮加载，而不是按需触发。`, fix);
  });
  if (residentNotes.length > 10) {
    const rest = residentNotes.slice(10).map((x) => x.i + 1);
    add('RV202', 'logic', 'warning', `wb[${rest.slice(0, 8).join('/')}${rest.length > 8 ? ' 等' : ''}]`, `另有 ${rest.length} 条世界书同样因触发词出现在前缀词/后置词里而每轮加载（第 ${rest.slice(0, 8).join('、')}${rest.length > 8 ? ' 等' : ''}，共 ${rest.length} 条）。`, '先逐条判断：必须在每轮在场的（格式/状态/路由）保留触发词并压缩体量；只服务特定场景的才换内容锚。不要一律改触发词。');
  }
  pptHits.slice(0, 5).forEach(({ i, cls }) => {
    add('RV203', 'logic', 'info', `wb[${i + 1}]`, `第 ${i + 1} 条的触发词出现在主提示词里（${cls.inPpt.slice(0, 4).join('、')}）：AI 复述提示词时可能命中，触发面不稳定。`, '确认这是有意的常驻；不是的话换成剧情专名。');
  });

  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const key = textOf(e.key);
    if (!key) return;
    if (Number(e.match_type) === 3 || !/^_(?:or|and)_/.test(key)) {
      try {
        new RegExp(key);
      } catch (err) {
        add('RV204', 'logic', 'error', `wb[${i + 1}]`, `第 ${i + 1} 条的正则触发词无法编译：${err.message}。这条永远不会触发。`, '修正正则语法，或改用 _or_ 关键词列表。');
      }
    }
  });

  // RV228：只查能确定的结构错误（括号/空词/重复）。空格、冒号、标题符号一律交给 AI 对照卡片自己的输出字段判断。
  const badTokens = [];
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const tokens = entryTokens(e);
    if (!tokens.length) return;
    const problems = [];
    for (const t of tokens) {
      const p = triggerTokenProblem(t);
      if (p) problems.push(`「${t}」${p}`);
    }
    if (new Set(tokens).size < tokens.length) problems.push('同一个词重复出现');
    if (problems.length) badTokens.push({ i, key: textOf(e.key), problems });
  });
  badTokens.slice(0, 10).forEach(({ i, key, problems }) => {
    const severe = problems.some((p) => p.includes('括号不成对'));
    add('RV228', 'logic', severe ? 'error' : 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条触发词有结构问题：${problems.join('；')}（key=${key}）。空格、冒号、标题符号是否合法，由 AI 对照卡片自己规定的输出字段判断，插件不预设格式。`, '补齐成对符号，删掉重复词；如果触发词本来就是卡片规定的输出格式（如字段行/状态行），保留原样，不要按通用规则改。');
  });
  if (badTokens.length > 10) {
    const rest = badTokens.slice(10).map((x) => x.i + 1);
    const anySevere = badTokens.slice(10).some((x) => x.problems.some((p) => p.includes('括号不成对')));
    add('RV228', 'logic', anySevere ? 'error' : 'warning', 'wb', `另有 ${rest.length} 条世界书的触发词有结构问题（第 ${rest.slice(0, 8).join('、')}${rest.length > 8 ? ' 等' : ''} 条）。`, '统一检查 key：括号成对、去掉重复词；空格/冒号是否合法由 AI 对照卡片输出字段判断。');
  }

  // RV229：世界书正文写了运行期识别/防守性命令。真实问题不是「平台触发机制」，而是按需条目里堆了本该在 ppt 的优先级防守。
  const metaNotes = [];
  const defensiveNotes = [];
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const meta = triggerMetaHit(e.value);
    const def = defensiveHit(e.value);
    if (meta) metaNotes.push({ i, hit: meta });
    else if (def) defensiveNotes.push({ i, hit: def });
  });
  metaNotes.slice(0, 10).forEach(({ i, hit }) => {
    add('RV229', 'logic', 'error', `wb[${i + 1}]`, `第 ${i + 1} 条世界书正文在写运行期识别/防守性命令（命中：「${hit}」）。这段的真实问题是：世界书被这个 key 触发后本来就只服务该请求，再写「玩家输入出现标记→本轮视为请求／优先于」属于重复确认，既冗长又容易让模型自我触发；触发识别规则应在 ppt，不在按需条目正文。`, '删掉识别段与「本轮视为/优先于」这类防守性重复；必要的优先规则移进 ppt；世界书正文只保留字段解析、执行流程与结果规则。');
  });
  if (metaNotes.length > 10) {
    add('RV229', 'logic', 'error', 'wb', `另有 ${metaNotes.length - 10} 条世界书正文在写运行期识别/防守性命令，应移进 ppt。`, '把输入识别/触发条件集中到 ppt 的运行规则；世界书只写知识与执行细则。');
  }
  defensiveNotes.slice(0, 10).forEach(({ i, hit }) => {
    add('RV229', 'logic', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条世界书正文出现全局优先级/防守性命令（命中：「${hit}」）：如果它需要每轮生效，应放 ppt；放在按需条目里既不一定加载，又占体量，还会和真正的主提示词规则重复。`, '先判断这条是否需要每轮在场：需要就移进 ppt；只在某场景需要就收紧为局部规则，删掉「优先于/一律」这类全局防守措辞。');
  });
  if (defensiveNotes.length > 10) {
    add('RV229', 'logic', 'warning', 'wb', `另有 ${defensiveNotes.length - 10} 条世界书正文含全局优先级/防守性命令，需判断是否应在 ppt。`, '按是否需要每轮生效分流：需要→ppt；只在特定场景→局部规则。');
  }

  // RV230：同正文不同触发词。互斥条件下各自自包含，重复是必要的；不要默认去重。
  const bodyMap = new Map();
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const v = textOf(e.value).trim();
    if (v.length < 20) return;
    if (!bodyMap.has(v)) bodyMap.set(v, []);
    bodyMap.get(v).push(i);
  });
  const dupBodies = [];
  for (const [, list] of bodyMap) {
    if (list.length < 2) continue;
    const keys = new Set(list.map((i) => `${Number(wb[i].match_type)}|${textOf(wb[i].key)}`));
    if (keys.size < 2) continue; // 同 key 同正文由 RV106 负责
    dupBodies.push(list);
  }
  dupBodies.slice(0, 10).forEach((list) => {
    add('RV230', 'logic', 'info', `wb[${list.map((i) => i + 1).join('/')}]`, `第 ${list.map((i) => i + 1).join('、')} 条正文相同但触发词不同：先判断两组触发条件是否互斥。互斥场景下各自要自包含，重复是必要的，不要合并；只有可能同时命中或语义完全重复时才去重。`, '按触发条件判断：互斥 → 保留两份；同时在场 → 合并正文并保留一个触发条件。');
  });
  if (dupBodies.length > 10) {
    add('RV230', 'logic', 'info', 'wb', `另有 ${dupBodies.length - 10} 组「同正文不同触发词」，需要逐组判断是否互斥必要重复。`, '先判断互斥性，再决定合并或保留；不要按字数直接去重。');
  }

  // RV231：长条目可能可拆，但先确认运行时 AI 是否确实只用到其中一部分。
  const splitNotes = [];
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const len = charLen(e.value);
    if (len < 1500) return;
    const sections = sectionCount(e.value);
    if (sections >= 3) splitNotes.push({ i, len, sections });
  });
  splitNotes.slice(0, 5).forEach(({ i, len, sections }) => {
    add('RV231', 'logic', 'info', `wb[${i + 1}]`, `第 ${i + 1} 条 ${len} 字、含 ${sections} 个小节：可能可以拆分，但先确认运行时 AI 是否确实只用到其中一部分。若每次触发都需要整篇，拆开会导致漏载，不要拆。`, '按运行期用途拆：各节有独立触发条件或互斥场景才拆；整篇每次都要就保留，只压缩重复表述。');
  });
  if (splitNotes.length > 5) {
    add('RV231', 'logic', 'info', 'wb', `另有 ${splitNotes.length - 5} 条长条目含多个小节，拆分前同样要先确认运行期是否只用一部分。`, '先判断运行期用途，再决定拆不拆；不要按字数机械拆分。');
  }

  // RV232：同一 key 里父子词包含。短词命中时长词不会带来额外触发面，父级文本实际失效。
  const containNotes = [];
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    if (!/^_(?:or|and)_/.test(textOf(e.key))) return;
    const tokens = entryTokens(e);
    if (tokens.length < 2) return;
    for (let a = 0; a < tokens.length; a += 1) {
      for (let b = a + 1; b < tokens.length; b += 1) {
        const x = tokens[a];
        const y = tokens[b];
        if (!x || !y || x === y) continue;
        if (y.includes(x)) containNotes.push({ i, short: x, long: y });
        else if (x.includes(y)) containNotes.push({ i, short: y, long: x });
      }
    }
  });
  if (containNotes.length) {
    const examples = containNotes.slice(0, 5).map((x) => `第 ${x.i + 1} 条「${x.short}」⊂「${x.long}」`).join('；');
    add('RV232', 'logic', 'warning', 'wb', `触发词列表里有 ${containNotes.length} 组父子包含：${examples}。短词命中时，长词不会带来任何额外触发面，父级文本实际失效；这不是设计而是冗余（依据 docs/1 模块四「子集关系天然覆盖」与「关键词越短越可靠」）。`, '同一 key 只保留子集词或父级词之一：要避免漏触发就用子集词；要精确触发就用带符号的父级词。若父级文本的符号丢了，应修复符号，不要用去掉符号的内文替代。');
  }

  // RV233：世界书条目与前端/面板层重复。先做全作品评估，面板已实现的数据不要在世界书再写一份。
  const frontendText = [textOf(card.desc), textOf(card.built_in_css), textOf(card.ai_variable_tmpl), textOf(card.ai_v_json)].filter(Boolean).join('\n');
  const STOPWORDS = new Set(['系统', '等级', '玩家', '当前', '购买', '价格', '基础', '显示', '下列', '商品', '世界', '任务', '规则', '使用', '可以', '需要', '条目', '正文', '条件', '效果', '说明', '对应', '进行', '一个', '没有', '不会', '不能', '必须', '如果', '以及', '或者', '其中', '这个', '那个', '所有', '部分', '相关', '内容', '方式', '时间', '地点', '状态', '按照', '根据', '数据', '索引', '列表', '版本', '解锁', '可购买', '显示但', '世界书', '项目', '经验', 'Lv', 'lv']);
  const contentWords = (value) => [...new Set(textOf(value).match(/[\u4e00-\u9fffA-Za-z0-9]{2,12}/g) || [])]
    .filter((w) => !STOPWORDS.has(w) && !/^\d+$/.test(w) && !/^lv\d*$/i.test(w));
  const overlapNotes = [];
  if (frontendText.length >= 500) {
    wb.forEach((e, i) => {
      if (!e || e.enable === false) return;
      const value = textOf(e.value);
      if (value.length < 200) return;
      // 结构化数据记录：标题 + ≥3 个 key:value 行。面板展示同一份数据时，这类记录是 AI 运行期要用的原子数据，不是重复索引。
      const fieldLines = (value.match(/\n\s*[^：:\n]{1,20}[：:]/g) || []).length;
      if (/^【[^】\n]{1,40}】/.test(value) && fieldLines >= 3) return;
      const words = contentWords(value);
      if (words.length < 8) return;
      const matched = words.filter((w) => frontendText.includes(w));
      if (matched.length >= 6 && matched.length / words.length >= 0.3) {
        overlapNotes.push({ i, matched: matched.slice(0, 6), total: words.length, count: matched.length });
      }
    });
  }
  overlapNotes.slice(0, 5).forEach(({ i, matched, total, count }) => {
    add('RV233', 'consumption', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条与前端/面板层重复：${count}/${total} 个内容词已出现在 desc / built_in_css / 变量面板模板里（示例：${matched.join('、')}）。先做全作品评估：如果面板已经用代码实现同一份列表、表单或数据展示，世界书再写一份索引就是重复工作，应删除；只有运行期 AI 确实需要读这份文本时才保留。`, '先看 desc、built_in_css、ai_variable_tmpl / ai_v_json 是否已经实现同一份数据；已实现就删世界书里的重复索引，未实现才保留，并说明 AI 为什么需要读它。');
  });
  if (overlapNotes.length > 5) {
    add('RV233', 'consumption', 'warning', 'wb', `另有 ${overlapNotes.length - 5} 条世界书与前端/面板层高度重复，先做全作品评估再决定去留。`, '按「面板已实现 / AI 运行期确实需要」两条判断：前者删，后者留。');
  }

  // 状态条件不自动识别：只给判断思路。格式/字段名由卡片自己规定，插件不预设。
  // （具体判断交给 AI：正文范围 vs 触发词范围；格式触发词 vs 条目内容是否一致。）

  // RV236：世界书内部重复规则/样板段。只聚合，不逐条刷；不是平台面板重复。
  const normalizeRepeated = (s) => s.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim();
  const repeated = new Map();
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    const value = textOf(e.value);
    const segments = value.split(/\n{2,}|(?<=[。！？；;])/g).map((s) => s.trim()).filter((s) => s.length >= 60);
    const local = new Set();
    for (const segment of segments) {
      const normalized = normalizeRepeated(segment);
      if (local.has(normalized)) continue;
      local.add(normalized);
      const item = repeated.get(normalized) || { chars: segment.length, sample: segment, indices: new Set() };
      item.chars = Math.max(item.chars, segment.length);
      item.indices.add(i);
      repeated.set(normalized, item);
    }
  });
  const repeatedNotes = [...repeated.values()]
    .filter((v) => v.indices.size >= 3)
    .sort((a, b) => (b.indices.size - 1) * b.chars - (a.indices.size - 1) * a.chars);
  if (repeatedNotes.length) {
    const examples = repeatedNotes.slice(0, 3).map((v) => `「${v.sample.slice(0, 32)}…」出现在 ${v.indices.size} 条`).join('；');
    const saving = repeatedNotes.reduce((sum, v) => sum + (v.indices.size - 1) * v.chars, 0);
    add('RV236', 'consumption', 'warning', 'wb', `世界书内部有 ${repeatedNotes.length} 段长文本在 3 条以上条目中重复：${examples}。如果这些条目共享同一套主规则，保留一处，其余条目改成引用/只留自身数据，不要逐条复制。`, '先判断重复是互斥条件下的必要自包含，还是同一主规则的样板；后者删重复段，保留 master 规则和每条自己的名称/等级/价格/说明。', { saving: { chars: saving, kind: 'perTrigger' } });
  }

  const postCtrl = ['IDLE', 'CONTINUE', 'END'].filter((w) => post.includes(w));
  const ppt = textOf(card.ppt);
  const stateInWb = (Array.isArray(card.wb) ? card.wb : []).some((e) =>
    /(IDLE|CONTINUE|END|状态机|任务进度判定)/.test(`${textOf(e && e.key)}\n${textOf(e && e.value)}`));
  if (!customPost && !stateInWb && !postCtrl.length && /(阶段|时限|倒计时|进度|回合数)/.test(ppt)) {
    add('RV205', 'logic', 'warning', 'ppt', '主提示词承诺了阶段/时限/进度，但后置词没有 IDLE/CONTINUE/END 控制词：承诺没有每轮可见的标记来兑现。', '要么补状态机三态标记与承接条目，要么删掉这些承诺。');
  }

  // 规则放错层：desc 是给玩家看的介绍页，AI 读不到；规则必须进 ppt。
  const desc = textOf(card.desc);
  const ruleHits = (desc.match(/(必须|不得|禁止|只能|每轮|输出格式|世界规则|世界书)/g) || []).length;
  const templateHits = /【(记忆区|行动建议|角色信息|时间地点)】/.test(desc) && !/【记忆区】/.test(post);
  if ((ruleHits >= 3 && ppt.length < 800) || templateHits) {
    add('RV227', 'logic', 'warning', 'desc', `介绍页（desc）里出现了 ${ruleHits} 处规则类措辞${templateHits ? '和输出模板段落名' : ''}，但主提示词只有 ${ppt.length} 字。原因：desc 是给玩家看的页面，AI 运行时读不到它，写在这里的规则等于没写。`, '把运行规则、固定段落与触发词移进 ppt / post_text / 世界书；desc 只留给玩家看的介绍与档案页。');
  }

  (card.rgx_rep || []).forEach((r, i) => {
    if (!r || r.is_enable === false) return;
    const pattern = textOf(r.match_regex);
    const replace = textOf(r.replace_text);
    if (/\$\d/.test(replace) && pattern && !/\((?!\?)/.test(pattern)) {
      add('RV206', 'logic', 'warning', `rgx_rep[${i + 1}]`, `第 ${i + 1} 条正则在替换里引用了 $1/$2，但表达式里没有捕获组：替换结果会出现字面量 $1。`, '要么给表达式加括号捕获组，要么把替换里的 $1 改成固定文本。');
    }
  });

  const depthNotes = [];
  const probNotes = [];
  wb.forEach((e, i) => {
    if (!e || e.enable === false) return;
    if (Number(e && e.depth) !== 0) depthNotes.push({ i, v: e.depth });
    if (Number(e && e.probability) !== 100) probNotes.push({ i, v: e.probability });
  });
  depthNotes.slice(0, 10).forEach(({ i, v }) => {
    add('RV207', 'logic', 'warning', `wb[${i + 1}]`, `第 ${i + 1} 条 depth=${v}：深度扫描会让它在之后若干轮继续命中，加载量比预期大（具体计数单位平台未确认）。`, '除非确实要跨轮扫描，部署字段改回 0。');
  });
  if (depthNotes.length > 10) add('RV207', 'logic', 'warning', 'wb', `另有 ${depthNotes.length - 10} 条世界书设置了非 0 的 depth，会扩大跨轮扫描面。`, '统一改回 0；确实需要的条目单独保留。');
  probNotes.slice(0, 10).forEach(({ i, v }) => {
    add('RV208', 'logic', 'info', `wb[${i + 1}]`, `第 ${i + 1} 条 probability=${v}：概率加载会让同一张卡每次运行表现不同，也更难做前后对比。`, '需要稳定就改回 100；确实要随机再保留。');
  });
  if (probNotes.length > 10) add('RV208', 'logic', 'info', 'wb', `另有 ${probNotes.length - 10} 条世界书设置了非 100 的 probability。`, '统一改回 100；确实要随机再保留。');

  /* --- 复用已有校验体系 --- */
  const mapCore = (diag, layer, whereOf) => {
    const severity = diag.severity === 'error' ? 'error' : diag.severity === 'warning' ? 'warning' : 'info';
    add(diag.id, layer, severity, whereOf(diag), diag.message, fixFor(diag.id));
  };
  for (const d of lintWorldbook(wb)) mapCore(d, 'logic', (x) => (Number.isInteger(x.index) ? `wb[${x.index + 1}]` : 'wb'));
  for (const d of lintRegex(card.rgx_rep)) mapCore(d, 'logic', (x) => (Number.isInteger(x.index) ? `rgx_rep[${x.index + 1}]` : 'rgx_rep'));
  for (const d of lintChatCss(card.built_in_css)) mapCore(d, 'structure', () => 'built_in_css');
  // 正则锚点缺失常常一大批（规则只作用于运行期内容），合并成一条，避免淹没真正要修的问题。
  const noAnchor = [];
  for (const d of lintRoutingConflict(card, card)) {
    if (d.id === 'CUE018' && /匹配不到内容/.test(d.message)) {
      const m = d.message.match(/第 (\d+) 条正则/);
      if (m) noAnchor.push(Number(m[1]));
      continue;
    }
    mapCore(d, 'logic', () => 'ppt+rgx_rep');
  }
  if (noAnchor.length) {
    add('CUE018', 'logic', 'warning', 'rgx_rep', `有 ${noAnchor.length} 条正则在上传卡的提示词/后置词模板里找不到锚点（第 ${noAnchor.join('、')} 条）：可能是规则只作用于运行期内容（正常），也可能是锚点改名导致规则永不命中。`, '逐条确认：只针对运行期数值/状态的可以忽略；模板里本该出现的内容，改锚点或删掉这条正则。');
  }

  const keepCues = new Set(['CUE009', 'CUE011', 'CUE013', 'CUE014', 'CUE015']);
  for (const d of lintWritingCues(card, {})) {
    if (!keepCues.has(d.id)) continue;
    mapCore(d, 'logic', () => 'content');
  }

  const audit = auditCard(card, {
    memoryRounds: metrics.token.rounds,
    aiSummary: metrics.memory.aiSummary,
  });
  for (const w of audit.warnings) {
    if (w.code === 'AMP' || w.code === 'X2') continue;
    if (w.code === 'WB') continue;
    if (w.code === 'ENV') {
      const onlyLinks = w.where === 'desc' && /^含 外链 \d+ 处$/.test(w.message);
      add('RV209', 'structure', onlyLinks ? 'info' : 'warning', w.where, onlyLinks ? `desc 里含外部链接：${w.message}。展示页用图片外链是正常做法，确认不是可疑跳转即可。` : `发现平台不安全的写法：${w.message}。`, '删掉 <script>/localStorage/内联事件/可疑外链；展示层只写 CSS 与静态 HTML。');
    }
    if (w.code === 'X1') add(w.code, 'logic', 'warning', 'wb', w.message, '把更长的触发词拆开或换成专名，避免一条的正文命中另一条的 key。');
  }
  (card.rgx_rep || []).forEach((r, i) => {
    if (!r || r.is_enable === false) return;
    const level = catastrophicLevel(r.match_regex);
    if (!level) return;
    const pattern = textOf(r.match_regex).slice(0, 120);
    add('RV210', 'logic', level === 2 ? 'warning' : 'info', `rgx_rep[${i + 1}]`, level === 2
      ? `第 ${i + 1} 条正则疑似嵌套量词，高置信灾难性回溯：${pattern}。长文本下可能卡住或超时。`
      : `第 ${i + 1} 条正则含嵌套量词（启发式，低置信）：${pattern}。多数写法在长文本上不一定卡；先实测再决定是否改。`, level === 2
      ? '先确认功能是否必须这样写；必须时用无歧义写法（如把可选空白拆成显式分支），或限制匹配长度。'
      : '先在长文本上实测；不卡就忽略。不要为了消除提示改坏任务面板等功能。');
  });

  issues.sort((a, b) => (
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    || (LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer])
    || String(a.code).localeCompare(String(b.code))
    || String(a.where).localeCompare(String(b.where))
  ));

  const summary = { total: issues.length, error: 0, warning: 0, info: 0, byLayer: { structure: 0, consumption: 0, logic: 0 } };
  for (const i of issues) {
    summary[i.severity] += 1;
    summary.byLayer[i.layer] += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    memory: metrics.memory,
    metrics,
    issues,
    questions,
    guidance,
    openingCheck,
    summary,
    note: '本审计只给机械指标与启发式判断；体量、常驻、触发面都是内部估算，用于优化前后对比，不代表平台积分消耗；平台真实表现仍需导入后实测。',
  };
}

/* ---------------- 方案与前后对比 ---------------- */

export function buildPlan(audit, opts = {}) {
  const items = (audit.issues || []).map((i) => ({
    ...i,
    priority: PRIORITY_OF[i.severity] || 'optional',
    autoFixable: AUTO_FIXABLE.has(i.code),
    saving: i.saving || null,
  }));
  items.sort((a, b) => (
    (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
    || ((b.saving && b.saving.chars) || 0) - ((a.saving && a.saving.chars) || 0)
    || (LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer])
    || String(a.code).localeCompare(String(b.code))
  ));
  const summary = { must: 0, should: 0, optional: 0 };
  let perTurn = 0;
  let perTrigger = 0;
  for (const i of items) {
    summary[i.priority] += 1;
    if (i.saving && i.saving.kind === 'perTurn') perTurn += i.saving.chars;
    if (i.saving && i.saving.kind === 'perTrigger') perTrigger += i.saving.chars;
  }
  return {
    generatedAt: new Date().toISOString(),
    memory: audit.memory,
    baseline: audit.metrics,
    summary: {
      ...summary,
      estimatedPerTurnChars: perTurn,
      estimatedPerTriggerChars: perTrigger,
    },
    items,
    note: '方案只列问题与改法，不改卡；真正写入要等用户确认后走 apply。',
  };
}

export function compareCards(beforeCard, afterCard, opts = {}) {
  const before = estimateMetrics(beforeCard, opts);
  const after = estimateMetrics(afterCard, opts);
  const fields = {};
  for (const f of [...CARD_STRING_FIELDS, 'worldbook_total', 'worldbook_resident']) {
    const b = before.chars[f] || 0;
    const a = after.chars[f] || 0;
    if (b === a) continue;
    fields[f] = { before: b, after: a, delta: a - b };
  }
  const token = {
    perTurnMin: { before: before.token.perTurnMin, after: after.token.perTurnMin, delta: after.token.perTurnMin - before.token.perTurnMin },
    perTurnMax: { before: before.token.perTurnMax, after: after.token.perTurnMax, delta: after.token.perTurnMax - before.token.perTurnMax },
    perTurnTotalMin: { before: before.token.perTurnTotalMin, after: after.token.perTurnTotalMin, delta: after.token.perTurnTotalMin - before.token.perTurnTotalMin },
    perTurnTotalMax: { before: before.token.perTurnTotalMax, after: after.token.perTurnTotalMax, delta: after.token.perTurnTotalMax - before.token.perTurnTotalMax },
    firstTurnMin: { before: before.token.firstTurnMin, after: after.token.firstTurnMin, delta: after.token.firstTurnMin - before.token.firstTurnMin },
    firstTurnMax: { before: before.token.firstTurnMax, after: after.token.firstTurnMax, delta: after.token.firstTurnMax - before.token.firstTurnMax },
  };
  const worldbook = {
    count: { before: before.worldbook.count, after: after.worldbook.count },
    residentChars: { before: before.worldbook.residentChars, after: after.worldbook.residentChars },
    residentCount: { before: before.worldbook.residentCount, after: after.worldbook.residentCount },
  };
  return { before, after, fields, token, worldbook };
}

/* ---------------- 报告渲染 ---------------- */

const fmt = (n) => Number(n).toLocaleString('zh-CN');

function sourceTitle(state) {
  return (state.source && (state.source.title || state.source.file)) || '（未命名）';
}

function renderAuditMd(audit, state) {
  const m = audit.metrics;
  const lines = [];
  lines.push('# 上传卡审计报告', '');
  lines.push(`- 卡名：${sourceTitle(state)}`);
  lines.push(`- 来源：${state.source.file || '粘贴内容'}（格式：${state.source.format}）`);
  lines.push(`- 审计时间：${audit.generatedAt}`);
  lines.push('- 规范依据：docs/1 世界书与触发、docs/2 档案页、docs/3 聊天页、docs/4 变量面板、docs/5 成人向；审卡清单 supplements/审查清单.md；评估框架 角色卡评估框架.md（若存在）。');
  lines.push(`- 记忆参数：${audit.memory.label}`);
  lines.push(`- 结论：**${audit.summary.error} 个必修 / ${audit.summary.warning} 个建议 / ${audit.summary.info} 个提示**`, '');

  lines.push('## 一、体量基线（内部相对量，非平台消耗）', '');
  lines.push('| 项目 | 数值 |', '| --- | --- |');
  lines.push(`| 每轮输入（含 ${m.token.historyMessages} 条历史消息） | 当前轮 ppt+ptx+本次玩家输入+post_text+常驻 ≈ ${fmt(m.token.currentTurnChars)} 字；历史 ${fmt(m.token.historyChars)} 字；合计 ≈ ${fmt(m.token.perTurnMin)}–${fmt(m.token.perTurnMax)} 体量单位 |`);
  lines.push(`| 每轮输出（按后置词模板的最低量） | ${fmt(m.token.outputChars)} 字 ≈ ${fmt(m.token.outputMin)}–${fmt(m.token.outputMax)} 体量单位 |`);
  lines.push(`| 每轮合计（输入 + 模板输出） | 约 ${fmt(m.token.perTurnTotalMin)}–${fmt(m.token.perTurnTotalMax)} 体量单位（内部相对量，仅用于前后对比） |`);
  lines.push(`| 首轮输入 | ${fmt(m.token.firstTurnMin)}–${fmt(m.token.firstTurnMax)} 体量单位 |`);
  lines.push(`| 历史消息 | ${m.token.historyMessages} 条（玩家 ${m.token.historyUserMessages} / AI ${m.token.historyAiMessages}；按玩家输入 ${m.token.playerInputChars} 字、AI 输出 ${m.token.aiOutputChars} 字估算） |`);
  lines.push(`| 世界书常驻 | ${fmt(m.worldbook.residentChars)} 字/轮（预算 ${fmt(m.worldbook.residentBudget)}，${m.worldbook.residentCount} 条） |`);
  lines.push(`| 世界书条件加载 | ${fmt(m.worldbook.conditionalChars)} 字（触发时才计入） |`);
  lines.push(`| 世界书总数 | ${m.worldbook.count} 条（启用 ${m.worldbook.enabled} / 停用 ${m.worldbook.disabled}） |`);
  lines.push(`| 正则 | ${m.regex.total} 条（仅渲染 ${m.regex.onlyRenderTrue} / 回写 ${m.regex.onlyRenderFalse}） |`);
  lines.push(`| 变量面板 | ${m.variables.enabled ? `开启（每轮提示词 ${fmt(m.variables.countedChars)} 字计入；Schema ${fmt(m.variables.schemaChars)} 字是否进上下文待验证；面板模板 ${fmt(m.variables.skinChars)} 字仅浏览器，不计入体量）` : '关闭'} |`);
  lines.push('', `> ${m.token.note}`, '');
  if (audit.guidance && audit.guidance.length) {
    lines.push('## 审卡思路（不是问题，给 AI 的判断）', '');
    for (const g of audit.guidance) lines.push(`- ${g}`);
    lines.push('');
  }

  const sections = [
    ['二、必修（逻辑错误）', 'error'],
    ['三、建议（体量与逻辑风险）', 'warning'],
    ['四、提示（可选优化）', 'info'],
  ];
  for (const [title, sev] of sections) {
    const list = audit.issues.filter((i) => i.severity === sev);
    lines.push(`## ${title}`, '');
    if (!list.length) {
      lines.push('（无）', '');
      continue;
    }
    for (const i of list) {
      const save = i.saving ? `（约省 ${fmt(i.saving.chars)} 字/${i.saving.kind === 'perTurn' ? '轮' : '次'}）` : '';
      lines.push(`- **${i.code}** \`${i.where}\`：${i.message}${save}`);
      lines.push(`  - 修法：${i.fix}`);
    }
    lines.push('');
  }
  if (audit.questions && audit.questions.length) {
    lines.push('## 需要你确认（不是报错）', '');
    for (const q of audit.questions) lines.push(`- ${q}`);
    lines.push('');
  }
  lines.push('---', '', '本报告是机械审计：体量与常驻为内部相对量，触发面按后置词/前缀词推断；平台真实行为需导入后实测。');
  return lines.join('\n') + '\n';
}

function renderPlanMd(plan, state) {
  const b = plan.baseline;
  const lines = [];
  lines.push('# 上传卡优化方案', '');
  lines.push(`- 卡名：${sourceTitle(state)}`);
  lines.push(`- 方案时间：${plan.generatedAt}`);
  lines.push(`- 基线：每轮输入约 ${fmt(b.token.perTurnMin)}–${fmt(b.token.perTurnMax)} 体量单位；常驻 ${fmt(b.worldbook.residentChars)} 字/轮（预算 ${fmt(b.worldbook.residentBudget)}）；历史 ${b.token.historyMessages} 条消息。`);
  lines.push(`- 项目：必修 ${plan.summary.must} / 建议 ${plan.summary.should} / 可选 ${plan.summary.optional}`, '');
  const groups = [
    ['P0 必修（先修这些，否则逻辑不成立）', 'must'],
    ['P1 建议（降体量与降风险）', 'should'],
    ['P2 可选（想再瘦身时做）', 'optional'],
  ];
  for (const [title, key] of groups) {
    const list = plan.items.filter((i) => i.priority === key);
    lines.push(`## ${title}`, '');
    if (!list.length) {
      lines.push('（无）', '');
      continue;
    }
    for (const i of list) {
      const tags = [i.code, i.layer === 'consumption' ? '体量' : i.layer === 'logic' ? '逻辑' : '结构'];
      if (i.autoFixable) tags.push('可机械修');
      lines.push(`- [ ] \`${i.where}\` ${i.message}（${tags.join(' / ')}）`);
      lines.push(`  - 改法：${i.fix}`);
      if (i.saving) lines.push(`  - 预计：省 ${fmt(i.saving.chars)} 字/${i.saving.kind === 'perTurn' ? '轮' : '次触发'}`);
    }
    lines.push('');
  }
  lines.push('## 全作品评估（动手前先看这几层）', '');
  lines.push('- `ppt` / `post_text`：每轮运行规则与状态锚点。');
  lines.push('- `desc`：档案页是否已经有商店、列表、表单或同一份数据。');
  lines.push('- `built_in_css` / `rgx_rep`：展示层与正则是否已经处理；展示数据不要写进世界书。');
  lines.push('- `ai_variable_tmpl` / `ai_v_json` / `ai_v_prompt`：变量面板是否已用代码建立商店库、地图、状态等；面板已实现的索引/数据表不要在世界书里重复生成。');
  lines.push('- 结论：先确定问题属于哪一层、改哪一层；不要只盯着世界书改。');
  lines.push('- 不改原导出件的字段名与结构；导出沿用原键名，封面、标签、简介、背景等设置不丢。');
  lines.push('', '## 改写前的三个判断（必须逐条回答，答不清就先问用户）', '');
  lines.push('1. **触发词**：这段文本运行时是否每轮都需要？是 → 保留常驻触发词，优先压缩体量，不要为了省体量改成稀有词；只服务某场景 → 改成内容锚；拿不准 → 标出来问用户。');
  lines.push('2. **拆分**：拆之前确认运行时 AI 是否确实只用到其中一部分。各节有独立触发条件或互斥场景才拆；每次触发都要整篇的，拆开会导致漏载，不要拆。');
  lines.push('3. **重复**：先判断两处是否会在同一轮同时在场。互斥条件下各自要自包含，重复是必要的，不要合并；同时在场且语义相同的，才是真重复。');
  lines.push('', '## 改写守则（apply 前必须遵守）', '');
  lines.push('- 只压缩、重排、去重、补缺；不改世界事实、角色设定、尺度档位与玩家代理边界。');
  lines.push('- 保持字段归属：规则留在 ppt，知识留在世界书，展示留在 desc/CSS，渲染留在 rgx_rep。');
  lines.push('- 数组（wb / rgx_rep）按整体替换提交；只改单个字段时，补丁里只放那个字段。');
  lines.push('- apply 会重新审计：引入新的必修问题会被拒收（force 除外）。');
  lines.push('', '## 下一步', '', '把方案讲给用户听，等用户明确同意后再改写并调用 `apply`。不要替用户直接决定大改。');
  return lines.join('\n') + '\n';
}

function renderCompareMd(compare, beforeAudit, afterAudit, state, extra = {}) {
  const lines = [];
  lines.push('# 优化前后对比', '');
  lines.push(`- 卡名：${sourceTitle(state)}`);
  lines.push(`- 对比时间：${new Date().toISOString()}`);
  if (extra.forced) lines.push('- 注意：本次 apply 使用了 force，强制接受了新增问题（见文末）。');
  lines.push('');
  lines.push('## 一、每轮体量（内部相对量）', '');
  lines.push('| 项目 | 优化前 | 优化后 | 变化 |', '| --- | --- | --- | --- |');
  for (const [label, key] of [['每轮输入最少体量', 'perTurnMin'], ['每轮输入最多体量', 'perTurnMax'], ['每轮合计最少体量', 'perTurnTotalMin'], ['每轮合计最多体量', 'perTurnTotalMax'], ['首轮最少体量', 'firstTurnMin'], ['首轮最多体量', 'firstTurnMax']]) {
    const x = compare.token[key];
    lines.push(`| ${label} | ${fmt(x.before)} | ${fmt(x.after)} | ${x.delta === 0 ? '不变' : (x.delta > 0 ? '+' : '') + fmt(x.delta)} |`);
  }
  lines.push('');
  if (Object.keys(compare.fields).length) {
    lines.push('## 二、字段字数变化', '');
    lines.push('| 字段 | 优化前 | 优化后 | 变化 |', '| --- | --- | --- | --- |');
    for (const [f, d] of Object.entries(compare.fields)) {
      lines.push(`| ${f} | ${fmt(d.before)} | ${fmt(d.after)} | ${d.delta > 0 ? '+' : ''}${fmt(d.delta)} |`);
    }
    lines.push('');
  }
  lines.push('## 三、问题数量', '');
  lines.push(`- 优化前：必修 ${beforeAudit.summary.error} / 建议 ${beforeAudit.summary.warning} / 提示 ${beforeAudit.summary.info}`);
  lines.push(`- 优化后：必修 ${afterAudit.summary.error} / 建议 ${afterAudit.summary.warning} / 提示 ${afterAudit.summary.info}`);
  const fixed = (beforeAudit.issues || []).filter((i) => !(afterAudit.issues || []).some((j) => j.code === i.code && j.where === i.where));
  if (fixed.length) {
    lines.push('', `### 已消除的项（${fixed.length}）`);
    for (const i of fixed.slice(0, 40)) lines.push(`- ${i.code} \`${i.where}\`：${i.message}`);
  }
  if (extra.newErrors && extra.newErrors.length) {
    lines.push('', '### 新增必修（force 接受）');
    for (const i of extra.newErrors) lines.push(`- ${i.code} \`${i.where}\`：${i.message}`);
  }
  lines.push('', '---', '', '数字为内部相对量，只用于同一张卡前后对比；平台按积分计费，真实消耗以平台账单为准。');
  return lines.join('\n') + '\n';
}

function renderReportMd(state, beforeAudit, afterAudit, compare) {
  const lines = [];
  lines.push('# 上传卡优化报告', '');
  lines.push(`- 卡名：${sourceTitle(state)}`);
  lines.push(`- 来源文件：${state.source.file || '粘贴内容'}`);
  const exportKind = state.export && state.export.kind;
  const extraCount = (state.export && state.export.extras && state.export.extras.length) || 0;
  lines.push(`- 原格式：${state.source.format}；导出格式：${exportKind === 'source' ? `原导出件键名（${state.source.format}）` : `v2（${V2_KEY_ORDER.length} 键${extraCount ? ` + ${extraCount} 个原样保留字段` : ''}）`}`);
  lines.push(`- 导出时间：${new Date().toISOString()}`);
  lines.push(`- 导出文件：${state.export && state.export.file ? state.export.file : `${REVIEW_DIR}/${REVIEW_FILES.export}`}`, '');
  lines.push('## 一、优化结果', '');
  lines.push(`- 每轮输入：${fmt(compare.token.perTurnMin.before)}–${fmt(compare.token.perTurnMax.before)} → ${fmt(compare.token.perTurnMin.after)}–${fmt(compare.token.perTurnMax.after)} 体量单位`);
  lines.push(`- 每轮合计（含模板输出，内部相对量）：${fmt(compare.token.perTurnTotalMin.before)}–${fmt(compare.token.perTurnTotalMax.before)} → ${fmt(compare.token.perTurnTotalMin.after)}–${fmt(compare.token.perTurnTotalMax.after)} 体量单位`);
  lines.push(`- 常驻世界书：${fmt(compare.worldbook.residentChars.before)} → ${fmt(compare.worldbook.residentChars.after)} 字/轮`);
  lines.push(`- 问题：必修 ${beforeAudit.summary.error} → ${afterAudit.summary.error}；建议 ${beforeAudit.summary.warning} → ${afterAudit.summary.warning}`);
  if (state.optimized && state.optimized.forced) lines.push('- 注意：本次改写使用了 force，强制接受了一些新增问题，导入前请自己再确认。');
  lines.push('', '## 二、剩余问题', '');
  const left = (afterAudit.issues || []).filter((i) => i.severity !== 'info');
  if (!left.length) lines.push('（无必修与建议项）');
  for (const i of left.slice(0, 40)) lines.push(`- ${i.code} \`${i.where}\`：${i.message}`);
  if (left.length > 40) lines.push(`- ……其余 ${left.length - 40} 项见 audit.md`);
  lines.push('', '## 三、导入方法', '');
  lines.push('1. 先在平台备份原卡（导出原 JSON 留底）。');
  const exportName = state.export && state.export.file ? path.basename(state.export.file) : REVIEW_FILES.export;
  lines.push(`2. 在平台导入本报告同目录的 \`${exportName}\`。平台导入是**整卡覆盖**，会替换同名卡。`);
  lines.push('3. 导入后实际玩几轮，重点看：世界书是否按预期触发、状态栏是否正常、正则是否命中。');
  lines.push('', '## 四、保留与未处理', '');
  if (exportKind === 'source') {
    lines.push(`- 原导出件键名全部保留（${state.exportPreserved.length} 项）：只覆盖托管字段的值，cover / tag_list / 语言 / 界面设置等原键不动，不新增 v2 键。`);
  } else {
    lines.push(`- 平台设置类字段：已知平台键（如 labels / msc / def_msg_cnt 等）从原导出件原样保留 ${state.exportPreserved.length} 项。`);
    if (state.export && state.export.extras && state.export.extras.length) {
      lines.push(`- 未映射/未识别字段已原样保留：${state.export.extras.slice(0, 12).join('、')}${state.export.extras.length > 12 ? ' 等' : ''}（平台是否接受这些额外键需导入实测）。`);
    }
  }
  lines.push('- 背景图：只做透传，插件不产出；原卡有 URL 就保留，没有就留空，请在平台设置。');
  lines.push('', '## 五、限制（不要当成已验证）', '');
  lines.push('- 体量与常驻是内部相对量：按字符数折算（1 个中文字约 1.0–1.7 个单位）、可配置历史轮数计算，只用于同一张卡前后对比；平台按积分计费，真实消耗以平台账单为准。');
  lines.push('- 世界书触发面由前缀词/后置词与触发方向推断；平台真实扫描范围未确认。');
  lines.push('- 正则执行时机、is_only_render 的回流行为未实测；导入后需人工确认。');
  lines.push('- 本报告不代表平台 PASS，也不能替代实际游玩验证。');
  lines.push('', '---', '', '优化版内容由 agent 按优化方案改写，工具只做审计、校验与导出。');
  return lines.join('\n') + '\n';
}

/* ---------------- 导出 ---------------- */

/**
 * 生成可导入的 v2 文件：
 * 托管字段用优化版覆盖；其余已知平台键从原导出件原样保留（标签、BGM、设置等不丢）。
 */
export function buildPlatformExport(raw, card) {
  const base = toPlatform(card, 'v2');
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const preserved = [];
  for (const key of V2_KEY_ORDER) {
    if (MANAGED_PLATFORM_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      base[key] = src[key];
      preserved.push(key);
    }
  }
  // 旧版平台设置键映射到 v2 键；源里已有 v2 键时以 v2 为准。
  for (const [legacy, modern] of Object.entries(PLATFORM_KEY_ALIASES)) {
    if (Object.prototype.hasOwnProperty.call(src, legacy)
      && !Object.prototype.hasOwnProperty.call(src, modern)
      && Object.prototype.hasOwnProperty.call(base, modern)) {
      base[modern] = src[legacy];
      preserved.push(`${legacy}→${modern}`);
    }
  }
  const ordered = {};
  for (const key of V2_KEY_ORDER) ordered[key] = base[key];
  // 未映射的原卡字段原样保留：平台导出件里不认识的键不能悄悄丢。
  const extras = [];
  for (const key of Object.keys(src)) {
    if (Object.prototype.hasOwnProperty.call(ordered, key)) continue;
    if (Object.prototype.hasOwnProperty.call(PLATFORM_KEY_ALIASES, key)) continue;
    if (MANAGED_RAW_ALIASES.has(key)) continue;
    extras.push(key);
    ordered[key] = src[key];
    preserved.push(key);
  }
  return { platform: ordered, preserved, dropped: [], extras };
}

const BACKGROUND_FIELD_ALIASES = {
  bg_img: BACKGROUND_FIELDS.bg_img,
  mobile_bg: BACKGROUND_FIELDS.mobile_bg,
};

/**
 * 尊重导出件原字段名：沿用原卡的键名与结构，只覆盖托管字段的值。
 * 这样 cover / tag_list / 语言 / 界面设置等不会因为转成 v2 而丢失。
 */
export function buildSourceExport(raw, card) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = JSON.parse(JSON.stringify(src));
  const setByAlias = (aliases, value) => {
    for (const key of aliases || []) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = value;
    }
  };
  for (const f of CARD_STRING_FIELDS) {
    setByAlias(FIELD_ALIASES[f] || [f], textOf(card[f]));
  }
  setByAlias(FIELD_ALIASES.wb, (Array.isArray(card.wb) ? card.wb : []).map((e, i) => normalizeLoreEntry(e, i)));
  setByAlias(FIELD_ALIASES.rgx_rep, normalizeRegexRules(card.rgx_rep));
  for (const extKey of ['extend', 'ext']) {
    if (out[extKey] && typeof out[extKey] === 'object' && !Array.isArray(out[extKey])) {
      out[extKey] = { ...out[extKey], ai_variable_enabled: Boolean(card.ext && card.ext.ai_variable_enabled) };
    }
  }
  for (const [field, aliases] of Object.entries(BACKGROUND_FIELD_ALIASES)) {
    setByAlias(aliases, textOf(card[field]));
  }
  const preserved = Object.keys(out);
  return { platform: out, preserved, dropped: [] };
}

/* ---------------- 状态 ---------------- */

export function reviewStatePath(out) {
  return path.join(reviewDir(out), REVIEW_FILES.state);
}

export function readReviewState(out) {
  const file = reviewStatePath(out);
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (e) {
    throw new Error(`上传卡状态文件损坏：${file}。原因：文件不是合法 JSON，常见于手工编辑或写入中断。两条路：① 删除该文件后重新 ingest；② 从备份恢复。原始错误：${e.message}`);
  }
}

function writeReviewState(out, state) {
  ensureDir(out);
  state.updatedAt = new Date().toISOString();
  writeJson(reviewStatePath(out), state);
}

function baseState(out, source, meta, memory) {
  const now = new Date().toISOString();
  return {
    version: REVIEW_VERSION,
    createdAt: now,
    updatedAt: now,
    phase: 'ingested',
    out,
    source: {
      file: source.file,
      name: source.name,
      title: source.card.title || '',
      format: meta.format,
      bytes: source.bytes,
      digest: sha256(JSON.stringify(source.card)),
      cardDigest: sha256(JSON.stringify(source.card)),
      importedAt: now,
      unknownKeys: meta.unknownKeys,
      fieldMap: meta.fieldMap,
      hasBackground: meta.hasBackground,
      rawTopKeys: meta.topKeys,
    },
    memory: {
      rounds: memory.rounds,
      aiSummary: memory.aiSummary,
      source: memory.source,
      label: memory.label,
    },
    files: {},
    counts: { error: 0, warning: 0, info: 0 },
    summary: null,
    auditDigest: null,
    planDigest: null,
    planSourceDigest: null,
    optimized: null,
    export: null,
    exportPreserved: [],
    exportDropped: [],
  };
}

function nextOf(state) {
  if (!state) return 'ingest：导入用户上传的卡（--file 或 --text）';
  switch (state.phase) {
    case 'ingested': return 'audit：跑结构、逻辑、体量审计';
    case 'audited': return 'plan：生成优化方案并让用户确认';
    case 'planned': return 'apply：用户确认后写入改写版（--file 补丁或整卡）';
    case 'applied': return 'export：产出可导入的优化版 v2 JSON';
    case 'exported': return 'done：可再次 audit 复评，或按用户新要求继续优化';
    default: return 'ingest：重新导入卡片';
  }
}

function stateSummary(state) {
  return {
    out: state.out,
    phase: state.phase,
    title: state.source && (state.source.title || state.source.file),
    format: state.source && state.source.format,
    memory: state.memory,
    counts: state.counts,
    summary: state.summary,
    next: nextOf(state),
    files: state.files,
    optimized: state.optimized,
    export: state.export ? { file: state.export.file, bytes: state.export.bytes } : null,
  };
}

/* ---------------- action ---------------- */

function requireState(out) {
  const state = readReviewState(out);
  if (!state) {
    throw new Error(`还没有导入任何卡：${reviewStatePath(out)} 不存在。原因：上传卡流程必须先 ingest，审计与优化都以导入的卡为起点。两条路：① 先调 ingest 并给 --file <卡片 JSON 路径>；② 如果卡是粘贴内容，用 --text <JSON 正文>。`);
  }
  return state;
}

/** 别名/归一逻辑变更后，旧状态可能把字段读成空；发现 raw 与 source 摘要不一致就要求重新 ingest。 */
function ensureRawMatchesNormalization(state, out) {
  const rawFile = reviewFile(out, 'raw');
  if (!fs.existsSync(rawFile)) return;
  let raw;
  try {
    raw = readJson(rawFile);
  } catch {
    return;
  }
  const { card } = normalizeReviewCard(raw);
  if (sha256(JSON.stringify(card)) !== state.source.digest) {
    throw new Error('原卡读入时的字段与当前别名表不一致：raw 重新归一后与 source.json 摘要不同（常见于刚补过别名，例如 potx→post_text）。原因：旧状态是按旧别名读入的，post_text 可能仍是 0 字，直接审计会按 0 字计算并误报。两条路：① 重新 ingest 原卡（推荐，会清掉下游旧产物后重建）；② 不要直接用旧状态 audit/plan，否则结论不可信。');
  }
}

/** 源卡被手工改过：审计/方案/改写都必须基于同一份内容。 */
function ensureSourceFresh(state, out) {
  const file = reviewFile(out, 'source');
  if (!fs.existsSync(file)) return;
  const digest = sha256(JSON.stringify(readJson(file)));
  if (digest !== state.source.digest) {
    throw new Error('源卡文件被手工修改过：source.json 的摘要与导入时不一致。原因：审计、方案和改写必须基于同一份卡，否则会对着旧内容改新卡。两条路：① 重新 ingest 这张卡；② 把手工修改撤回，恢复导入时的内容。');
  }
}

function readInputText(args, out) {
  if (typeof args.file === 'string' && args.file.trim()) {
    const p = path.isAbsolute(args.file) ? args.file : path.resolve(out, args.file);
    if (!fs.existsSync(p)) {
      throw new Error(`卡片文件不存在：${p}。原因：路径拼写错误、文件被移动，或只给了文件名没给所在目录。两条路：① 用绝对路径重新调用（把文件拖进对话框通常能得到完整路径）；② 把 JSON 正文用 --text 传进来。`);
    }
    return { text: fs.readFileSync(p, 'utf8'), file: p, name: path.basename(p) };
  }
  if (typeof args.text === 'string' && args.text.trim()) return { text: args.text, file: null, name: '粘贴内容' };
  if (typeof args.content === 'string' && args.content.trim()) return { text: args.content, file: null, name: '粘贴内容' };
  throw new Error('需要卡片内容。原因：既没有 --file 也没有 --text，工具不知道要读哪张卡。两条路：① 传 --file <平台导出的 JSON 路径>；② 把 JSON 正文放进 --text。');
}

function ingestAction(args, out) {
  const input = readInputText(args, out);
  const raw = parseCardJson(input.text);
  const { card, meta } = normalizeReviewCard(raw);
  if (meta.wbWasArray === false) {
    throw new Error('世界书字段不是数组。原因：平台导出件里 lore_bk / wb / world_book 必须是数组，拿到的是对象或字符串；直接读会把世界书当成空，审计结果全错。两条路：① 用平台重新导出这份卡；② 手工把该字段改成 [ ... ] 数组后重试。');
  }
  if (meta.rawRgxWasArray === false) {
    throw new Error('正则字段不是数组。原因：rgx_rep 必须是数组，拿到的是对象或字符串；直接读会把正则全部丢掉。两条路：① 用平台重新导出这份卡；② 手工改成数组后重试。');
  }
  if (!meta.recognized) {
    throw new Error(`无法识别这是一张卡。原因：读到的 JSON 里没有 title/ppt/post_text/wb 这类卡片核心字段，顶层键是：${meta.topKeys.slice(0, 12).join('、') || '（空）'}。两条路：① 确认导出的是「卡片」而不是列表、设置或统计文件；② 如果是别的平台的卡，先把字段名按 name/pre_prompt/lore_bk 或 title/ppt/wb 改好再导入。`);
  }
  const memory = resolveMemory(null, args);
  const aliasLog = recordAliasSuggestions(out, meta, raw, input.name);
  ensureDir(out);
  clearDownstream(out);
  removeReviewFiles(out, ['audit', 'auditMd']);
  writeJson(reviewFile(out, 'raw'), raw);
  writeJson(reviewFile(out, 'source'), card);
  writeJson(reviewFile(out, 'meta'), meta);
  const state = baseState(out, { ...input, card, bytes: Buffer.byteLength(input.text, 'utf8') }, meta, memory);
  state.files = {
    raw: relPath(out, reviewFile(out, 'raw')),
    source: relPath(out, reviewFile(out, 'source')),
    meta: relPath(out, reviewFile(out, 'meta')),
  };
  writeReviewState(out, state);
  const metrics = estimateMetrics(card, { memory, state });
  return {
    action: 'ingest',
    phase: state.phase,
    title: card.title,
    format: meta.format,
    file: input.name,
    fields: {
      ppt: charLen(card.ppt),
      ptx: charLen(card.ptx),
      post_text: charLen(card.post_text),
      opening_statement: charLen(card.opening_statement),
      desc: charLen(card.desc),
      built_in_css: charLen(card.built_in_css),
      worldbook: card.wb.length,
      regex: card.rgx_rep.length,
      panel: Boolean(card.ext.ai_variable_enabled),
    },
    unknownKeys: meta.unknownKeys,
    aliasSuggestions: aliasLog,
    metrics: { token: metrics.token, worldbook: metrics.worldbook },
    files: state.files,
    next: nextOf(state),
  };
}

function auditAction(args, out) {
  const state = requireState(out);
  ensureRawMatchesNormalization(state, out);
  ensureSourceFresh(state, out);
  const sourceFile = reviewFile(out, 'source');
  if (!fs.existsSync(sourceFile)) throw new Error(`找不到导入的规范卡：${sourceFile}。原因：ingest 没有正常完成或文件被删除。两条路：① 重新 ingest；② 从 .card-build/review 备份恢复。`);
  const card = readJsonSafe(sourceFile, '导入的规范卡', '① 重新 ingest；② 从 .card-build/review 备份恢复');
  const metaFile = reviewFile(out, 'meta');
  const meta = fs.existsSync(metaFile)
    ? readJsonSafe(metaFile, '读入元信息', '① 重新 ingest；② 从 .card-build/review 备份恢复')
    : {};
  const memory = resolveMemory(state, args);
  const playerInputChars = Number.isFinite(args.player_input_chars)
    ? Math.max(0, Math.floor(args.player_input_chars))
    : (Number.isFinite(state.memory?.playerInputChars) ? state.memory.playerInputChars : 100);
  const aiOutputChars = Number.isFinite(args.ai_output_chars)
    ? Math.max(0, Math.floor(args.ai_output_chars))
    : (Number.isFinite(state.memory?.aiOutputChars) ? state.memory.aiOutputChars : 1000);
  state.memory = { rounds: memory.rounds, aiSummary: memory.aiSummary, source: memory.source, label: memory.label, playerInputChars, aiOutputChars };
  const audit = auditReview(card, { memory: state.memory, meta, state });
  audit.sourceDigest = state.source.digest;
  clearDownstream(out);
  writeJson(reviewFile(out, 'audit'), audit);
  fs.writeFileSync(reviewFile(out, 'auditMd'), renderAuditMd(audit, state), 'utf8');

  // 重新审计会作废下游产物：方案、改写版、导出件都必须基于最新审计。
  state.phase = 'audited';
  state.auditDigest = sha256Json({ metrics: audit.metrics, issues: audit.issues, memory: audit.memory });
  state.planDigest = null;
  state.planSourceDigest = null;
  state.optimized = null;
  state.export = null;
  state.counts = { error: audit.summary.error, warning: audit.summary.warning, info: audit.summary.info };
  state.summary = {
    perTurnMin: audit.metrics.token.perTurnMin,
    perTurnMax: audit.metrics.token.perTurnMax,
    residentChars: audit.metrics.worldbook.residentChars,
    residentBudget: audit.metrics.worldbook.residentBudget,
    amplification: audit.metrics.token.amplification,
  };
  state.files = {
    ...state.files,
    audit: relPath(out, reviewFile(out, 'audit')),
    auditMd: relPath(out, reviewFile(out, 'auditMd')),
  };
  for (const key of ['plan', 'planMd', 'optimized', 'compare', 'compareJson', 'export', 'exportSource', 'report']) delete state.files[key];
  state.exportPreserved = [];
  state.exportDropped = [];
  writeReviewState(out, state);
  return {
    action: 'audit',
    phase: state.phase,
    counts: state.counts,
    summary: state.summary,
    top: audit.issues.slice(0, 8),
    questions: audit.questions || [],
    guidance: audit.guidance || [],
    openingCheck: audit.openingCheck || null,
    files: state.files,
    next: nextOf(state),
  };
}

function planAction(args, out) {
  const state = requireState(out);
  ensureRawMatchesNormalization(state, out);
  ensureSourceFresh(state, out);
  if (!state.auditDigest || !fs.existsSync(reviewFile(out, 'audit'))) {
    throw new Error('还没有审计结果：plan 必须先 audit。原因：方案要按审计出的问题排序，没有审计就只能是泛泛建议。两条路：① 先调 audit（可带 memory_rounds 覆盖记忆轮数）；② 如果刚重新导入过卡，也要重新 audit。');
  }
  const audit = readJsonSafe(reviewFile(out, 'audit'), '审计结果', '① 重新 audit；② 重新 ingest 后再 audit');
  if (audit.sourceDigest && audit.sourceDigest !== state.source.digest) {
    throw new Error('审计结果与当前导入的卡不一致：检测到卡片在审计之后被替换。原因：source.json 的摘要变了，旧方案会指向不存在的问题。两条路：① 先重新 audit；② 重新 ingest 后再 audit。');
  }
  const plan = buildPlan(audit, args);
  plan.sourceDigest = state.source.digest;
  plan.auditDigest = state.auditDigest;
  writeJson(reviewFile(out, 'plan'), plan);
  fs.writeFileSync(reviewFile(out, 'planMd'), renderPlanMd(plan, state), 'utf8');
  state.phase = 'planned';
  state.planDigest = sha256Json({ source: state.source.digest, items: plan.items.map((i) => [i.code, i.where]), summary: plan.summary });
  state.planSourceDigest = state.source.digest;
  state.files = { ...state.files, plan: relPath(out, reviewFile(out, 'plan')), planMd: relPath(out, reviewFile(out, 'planMd')) };
  writeReviewState(out, state);
  return {
    action: 'plan',
    phase: state.phase,
    summary: plan.summary,
    baseline: { token: plan.baseline.token, worldbook: plan.baseline.worldbook, memory: plan.baseline.memory },
    top: plan.items.slice(0, 10),
    files: state.files,
    next: nextOf(state),
  };
}

function applyAction(args, out) {
  const state = requireState(out);
  ensureRawMatchesNormalization(state, out);
  ensureSourceFresh(state, out);
  if (state.phase !== 'planned' && state.phase !== 'applied') {
    throw new Error(`当前不能写入改写版：阶段是 ${state.phase}。原因：改写必须基于已生成的优化方案，否则 agent 改了什么、用户有没有确认，都没有记录。两条路：① 先 audit 再 plan；② 如果方案已有，重新执行 plan 恢复门禁。`);
  }
  if (!state.planSourceDigest || state.planSourceDigest !== state.source.digest) {
    throw new Error('优化方案不是针对当前这张卡生成的：源卡摘要对不上。原因：方案生成后又重新导入或替换了卡。两条路：① 重新 audit + plan；② 如果卡没变，重新 plan 一次以刷新摘要。');
  }
  const input = readInputText(args, out);
  const parsed = parseCardJson(input.text);
  const patch = normalizePatch(parsed);
  if (!Object.keys(patch).length) {
    throw new Error('改写补丁里没有任何可识别字段。原因：补丁必须用规范字段名或平台别名（ppt/pre_prompt、wb/lore_bk、rgx_rep 等）。两条路：① 只提交改动字段（推荐）；② 提交完整卡 JSON。');
  }
  const memory = resolveMemory(state, args);
  const sourceCard = readJsonSafe(reviewFile(out, 'source'), '导入的规范卡', '① 重新 ingest；② 从 .card-build/review 备份恢复');
  let baseCard = sourceCard;
  let beforeAudit = readJsonSafe(reviewFile(out, 'audit'), '审计结果', '① 重新 audit；② 重新 ingest 后再 audit');
  if (state.phase === 'applied') {
    // 连续改写：以当前优化版为基础合并，避免第二次 apply 把第一次的改动丢掉。
    const optFile = reviewFile(out, 'optimized');
    const current = readJsonSafe(optFile, '当前优化版', '① 重新 apply；② 从备份恢复');
    if (!state.optimized || state.optimized.digest !== sha256(JSON.stringify(current))) {
      throw new Error('当前优化版文件被手工修改过：摘要与 apply 时不一致。原因：连续改写必须基于上一次经审计的优化版，手工改动没有经过校验。两条路：① 撤回手工修改后重试；② 重新 ingest → audit → plan 从头再来。');
    }
    baseCard = current;
    const { meta: baseMeta } = normalizeReviewCard(current);
    beforeAudit = auditReview(current, { memory, meta: { ...baseMeta, format: state.source.format }, state });
  }
  const merged = mergeCardPatch(baseCard, patch);
  const { card: afterCard, meta: afterMeta } = normalizeReviewCard(merged);

  const afterAudit = auditReview(afterCard, { memory, meta: { ...afterMeta, format: state.source.format }, state });
  const beforeSig = new Set((beforeAudit.issues || []).map((i) => issueIdentity(i, baseCard)));
  const newErrors = afterAudit.issues.filter((i) => i.severity === 'error' && !beforeSig.has(issueIdentity(i, afterCard)));
  if (newErrors.length && !args.force) {
    const lines = newErrors.slice(0, 6).map((i) => `${i.code} ${i.where}：${i.message}`).join('；');
    throw new Error(`改写版引入了 ${newErrors.length} 个新的必修问题：${lines}。原因：改写时把某些结构性要求改坏了（常见于删掉 is_enable、破坏 _or_ 前缀、正则语法错）。两条路：① 按问题修正后重新 apply；② 如果你确认接受这些风险，带 force=true 重新 apply（会在报告里标注）。`);
  }
  const compare = compareCards(sourceCard, afterCard, { state });
  writeJson(reviewFile(out, 'optimized'), afterCard);
  writeJson(reviewFile(out, 'compareJson'), compare);
  fs.writeFileSync(reviewFile(out, 'compare'), renderCompareMd(compare, beforeAudit, afterAudit, state, { forced: Boolean(newErrors.length && args.force), newErrors }), 'utf8');
  state.phase = 'applied';
  state.optimized = {
    at: new Date().toISOString(),
    digest: sha256(JSON.stringify(afterCard)),
    forced: Boolean(newErrors.length && args.force),
    newErrors: newErrors.map((i) => ({ code: i.code, where: i.where, message: i.message })),
    counts: { error: afterAudit.summary.error, warning: afterAudit.summary.warning, info: afterAudit.summary.info },
    changedFields: Object.keys(patch),
    metrics: {
      perTurnMin: afterAudit.metrics.token.perTurnMin,
      perTurnMax: afterAudit.metrics.token.perTurnMax,
      residentChars: afterAudit.metrics.worldbook.residentChars,
    },
    afterAuditDigest: sha256Json({ issues: afterAudit.issues, metrics: afterAudit.metrics }),
  };
  state.counts = { error: afterAudit.summary.error, warning: afterAudit.summary.warning, info: afterAudit.summary.info };
  state.summary = {
    perTurnMin: afterAudit.metrics.token.perTurnMin,
    perTurnMax: afterAudit.metrics.token.perTurnMax,
    residentChars: afterAudit.metrics.worldbook.residentChars,
    residentBudget: afterAudit.metrics.worldbook.residentBudget,
    amplification: afterAudit.metrics.token.amplification,
  };
  state.export = null;
  state.files = { ...state.files, optimized: relPath(out, reviewFile(out, 'optimized')), compare: relPath(out, reviewFile(out, 'compare')), compareJson: relPath(out, reviewFile(out, 'compareJson')) };
  delete state.files.export;
  delete state.files.report;
  writeReviewState(out, state);
  return {
    action: 'apply',
    phase: state.phase,
    changedFields: Object.keys(patch),
    forced: state.optimized.forced,
    newErrors: state.optimized.newErrors,
    compare: {
      token: compare.token,
      worldbook: compare.worldbook,
      before: beforeAudit.summary,
      after: afterAudit.summary,
    },
    remaining: afterAudit.issues.filter((i) => i.severity !== 'info').slice(0, 10),
    files: state.files,
    next: nextOf(state),
  };
}

function exportAction(args, out) {
  const state = requireState(out);
  ensureRawMatchesNormalization(state, out);
  ensureSourceFresh(state, out);
  if (state.phase !== 'applied' && state.phase !== 'exported') {
    throw new Error(`当前不能导出：阶段是 ${state.phase}。原因：还没有经过审计与改写的优化版，直接导出会把原卡原样再发一遍。两条路：① 按 ingest → audit → plan → apply 走完再 export；② 如果只是想原样备份，直接从平台导出原文件即可。`);
  }
  const optFile = reviewFile(out, 'optimized');
  if (!fs.existsSync(optFile)) throw new Error(`找不到优化版：${optFile}。原因：apply 写入的文件被移走或删除。两条路：① 重新 apply；② 从备份恢复后重试。`);
  const card = readJsonSafe(optFile, '优化版', '① 重新 apply；② 从备份恢复后重试');
  if (!state.optimized || state.optimized.digest !== sha256(JSON.stringify(card))) {
    throw new Error('优化版文件被手工修改过：optimized.json 的摘要与 apply 时不一致。原因：导出必须基于经过审计的改写版，手工改动没有经过校验。两条路：① 重新 apply 生成优化版；② 撤回手工修改后重试。');
  }
  const rawFile = reviewFile(out, 'raw');
  const raw = fs.existsSync(rawFile)
    ? readJsonSafe(rawFile, '原始上传件', '① 重新 ingest；② 从 .card-build/review 备份恢复')
    : {};
  // 尊重原导出件字段名：非 v2 源一律沿用原键名，避免 cover / 标签 / 简介等设置被丢掉。
  const sourceShape = state.source.format !== 'v2';
  const built = sourceShape ? buildSourceExport(raw, card) : buildPlatformExport(raw, card);
  const platform = built.platform;
  const keys = Object.keys(platform);
  if (!sourceShape && V2_KEY_ORDER.some((k) => !(k in platform))) {
    throw new Error(`导出结构不完整：缺少平台键 ${V2_KEY_ORDER.filter((k) => !(k in platform)).join('、')}。原因：字段映射代码与平台格式定义不同步。两条路：① 报告这个缺陷，不要导入；② 临时用原卡手工补字段。`);
  }
  const roundTrip = JSON.parse(JSON.stringify(platform));
  if (JSON.stringify(roundTrip) !== JSON.stringify(platform)) throw new Error('导出件 JSON 往返失败：序列化后内容不一致。原因：存在无法序列化的值。两条路：① 检查原卡是否有特殊对象；② 报告缺陷。');
  ensureDir(out);
  const exportKey = sourceShape ? 'exportSource' : 'export';
  fs.writeFileSync(reviewFile(out, exportKey), JSON.stringify(platform, null, 2), 'utf8');
  const audit = fs.existsSync(reviewFile(out, 'audit'))
    ? readJsonSafe(reviewFile(out, 'audit'), '审计结果', '① 重新 audit；② 重新 ingest 后再 audit')
    : null;
  const compare = fs.existsSync(reviewFile(out, 'compareJson'))
    ? readJsonSafe(reviewFile(out, 'compareJson'), '前后对比', '① 重新 apply；② 直接重新导出（会重新计算对比）')
    : null;
  // 报告用优化后的审计更贴近实际情况
  const { meta: afterMeta } = normalizeReviewCard(card);
  const memory = resolveMemory(state, args);
  const afterAudit = auditReview(card, { memory, meta: { ...afterMeta, format: state.source.format }, state });
  const sourceCard = fs.existsSync(reviewFile(out, 'source')) ? readJson(reviewFile(out, 'source')) : card;
  const beforeAudit = audit || afterAudit;
  const compareData = compare || compareCards(sourceCard, card, { state });
  state.phase = 'exported';
  state.exportPreserved = built.preserved;
  state.exportDropped = built.dropped;
  const exportPath = reviewFile(out, exportKey);
  state.export = {
    at: new Date().toISOString(),
    file: relPath(out, exportPath),
    kind: sourceShape ? 'source' : 'v2',
    bytes: fs.statSync(exportPath).size,
    digest: sha256(JSON.stringify(platform)),
    preserved: built.preserved,
    dropped: built.dropped,
    extras: built.extras || [],
  };
  state.counts = { error: afterAudit.summary.error, warning: afterAudit.summary.warning, info: afterAudit.summary.info };
  state.files = { ...state.files, export: state.export.file, report: relPath(out, reviewFile(out, 'report')) };
  fs.writeFileSync(reviewFile(out, 'report'), renderReportMd(state, beforeAudit, afterAudit, compareData), 'utf8');
  writeReviewState(out, state);
  return {
    action: 'export',
    phase: state.phase,
    kind: state.export.kind,
    file: state.export.file,
    bytes: state.export.bytes,
    keys: keys.length,
    preserved: built.preserved,
    dropped: built.dropped,
    extras: built.extras || [],
    counts: state.counts,
    files: state.files,
    next: nextOf(state),
  };
}

/**
 * 上传卡流程入口。所有动作都同步执行，返回可 JSON 化的对象。
 * 阶段门禁：audit ← ingest；plan ← audit；apply ← plan；export ← apply。
 */
export function reviewAction(args = {}, out) {
  const action = String((args && args.action) || 'status');
  if (!out) throw new Error('缺少作品目录。原因：上传卡流程需要知道把审计与导出文件放哪里。两条路：① 传 --out <目录>；② 在会话工作区里直接调用（省略 out）。');
  if (!REVIEW_ACTIONS.includes(action)) {
    throw new Error(`未知 action：${action}。可用动作：${REVIEW_ACTIONS.join(' / ')}。`);
  }
  switch (action) {
    case 'status': {
      const state = readReviewState(out);
      if (!state) return { action: 'status', phase: 'not_started', out, next: nextOf(null) };
      return { action: 'status', ...stateSummary(state) };
    }
    case 'ingest': return ingestAction(args, out);
    case 'audit': return auditAction(args, out);
    case 'plan': return planAction(args, out);
    case 'apply': return applyAction(args, out);
    case 'export': return exportAction(args, out);
    default: throw new Error(`未知 action：${action}`);
  }
}

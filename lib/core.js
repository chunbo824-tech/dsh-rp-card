import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FLOW_VERSION = '1.6.9';
export const PARTS = ['writing', 'profile', 'chat', 'variables'];
/** 前三个部分做完即为可玩版本；第四部分变量面板是可选拓展。 */
export const PLAYABLE_PARTS = ['writing', 'profile', 'chat'];
export const PART_NAMES = { writing: '第一部分：写卡正文', profile: '第二部分：初始化档案页', chat: '第三部分：聊天页 CSS 与正则', variables: '第四部分：变量面板' };
export const STATUSES = ['not_started','generating','awaiting_user_validation','pass','needs_revision','stale','failed'];

/* ============================================================
 * 平台格式档案
 * 平台导出件会换字段名，所以这里按「格式」登记，不写死单套键名。
 * 读入用别名表兼容历史格式，导出用指定格式输出。
 * ============================================================ */

export const FIELD_ALIASES = {
  title: ['title', 'name', 'card_name'],
  ppt: ['ppt', 'pre_prompt', 'system_prompt', 'main_prompt'],
  ptx: ['ptx', 'pre_text'],
  post_text: ['post_text', 'posttxt'],
  opening_statement: ['opening_statement', 'opening', 'greeting'],
  wb: ['wb', 'lore_bk', 'worldbook', 'world_bk'],
  desc: ['desc', 'description', 'intro'],
  built_in_css: ['built_in_css', 'builtin_css'],
  rgx_rep: ['rgx_rep', 'regex_replaces'],
  ai_variable_tmpl: ['ai_variable_tmpl', 'ai_v_template'],
  ai_v_prompt: ['ai_v_prompt', 'ai_variable_prompt'],
  ai_v_json: ['ai_v_json', 'ai_variable_json'],
};

/**
 * 平台格式：只维护「一种」已实测可导入的导出格式。
 * 平台换字段名属于平台侧变化，我们不做自动适配，只把这一份定义更新一次。
 */
export const PLATFORM_FORMATS = {
  v2: {
    id: 'v2',
    label: 'fengyue.ai 导出结构（name / pre_prompt / lore_bk / extend）',
    // 2026-11-05 实测：顶层 40 键 + 世界书 12 字段条目，导入已通过。
    status: 'platform-verified-import',
    validatedAt: '2026-11-05',
    keys: { title: 'name', ppt: 'pre_prompt', ptx: 'ptx', post_text: 'post_text', opening_statement: 'opening_statement', wb: 'lore_bk', desc: 'desc', built_in_css: 'built_in_css', rgx_rep: 'rgx_rep', ai_variable_tmpl: 'ai_variable_tmpl', ai_v_prompt: 'ai_variable_prompt', ai_v_json: 'ai_v_json', panel: 'extend.ai_variable_enabled' },
  },
};

/** v2 导出件的完整键集合（平台真实导出件实测，导入通过）。 */
export const V2_KEY_ORDER = [
  'desc','sys_opt','avail_np','lc','summary_config','name','cvr','ref_id2','preset_tp','plat_vis',
  'bg_img','ext_cfg','mobile_bg','suggest_q_after','ianon','cover_tiny','mod_pm','msc','no_css_mod',
  'shortcut_commands','ptx','sq','ai_variable_tmpl','opening_statement','cgb','lore_bk','def_msg_cnt',
  'ai_v_json','ps_chats','knd','built_in_css','pre_prompt','category','post_text','extend','rgx_rep',
  'sum_info','ai_variable_prompt','labels','ban_wd',
];

/** v2 导出件的固定配置骨架（来自平台真实导出件，不随内容变化）。 */
const V2_DEFAULTS = {
  sys_opt: false, avail_np: true, lc: 'zh-Hans',
  summary_config: { big_prompt: '', model_config: { name: '', provider: '' }, small_prompt: '', enable_status: 2 },
  cvr: null, ref_id2: 1, preset_tp: 1, plat_vis: 0, bg_img: '',
  ext_cfg: { enabled: true }, mobile_bg: '', suggest_q_after: { enabled: true },
  ianon: false, cover_tiny: '', mod_pm: 4, msc: { tracks: [], autoplay: true },
  no_css_mod: false, shortcut_commands: [], sq: [], cgb: [], def_msg_cnt: 6,
  ps_chats: [], knd: 1, category: 0, sum_info: '', labels: [], ban_wd: [],
};

/** 按字段别名从任意已知格式里取值。 */
export function pickField(source, canonical) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of FIELD_ALIASES[canonical] || [canonical]) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) return source[key];
  }
  return undefined;
}

/** 面板开关：ext.ai_variable_enabled 与 extend.ai_variable_enabled 都认。 */
export function pickPanelFlag(source) {
  const ext = (source && source.ext) || {};
  const extend = (source && source.extend) || {};
  if (typeof extend.ai_variable_enabled === 'boolean') return extend.ai_variable_enabled;
  if (typeof ext.ai_variable_enabled === 'boolean') return ext.ai_variable_enabled;
  return undefined;
}

/**
 * 聊天页已登记的平台容器 ID（聊天页 §2.1–2.3 能力清单）。
 * 清单外 ID 不阻断交付，但会提示：先登记再使用，不能凭命名族推断。
 */
export const CHAT_CONTAINER_IDS = [
  // 2.1 平台原生固定层
  'customized-question-content', 'customized-question-content-created-time',
  'customized-answer', 'customized-answer-container', 'customized-answer-content-container',
  'customized-answer-content', 'customized-answer-content-markdown',
  'customized-answer-content-created-time', 'customized-answer-content-model',
  'customized-answer-content-model-name', 'customized-answer-content-model-input-points',
  'customized-answer-content-model-output-points',
  // 2.2 输入层
  'ai-input-content', 'ai-chat-input', 'ai-input-controls', 'ai-input-control-input-length',
  'ai-input-control-separator', 'ai-send-button',
  // 2.3 页面工具层
  'customized-variable-panel-floating-button',
  'customized-message-question-actions', 'customized-message-answer-actions',
  'customized-copy-button', 'customized-reload-button', 'customized-edit-button',
  'customized-resend-button', 'customized-delete-button',
  'customized-create-image-button', 'customized-create-audio-button',
  'customized-branch-and-share-button', 'customized-prompt-log-button',
  'customized-truncate-refund-button',
  'ai-mod-button', 'customized-ai-summary-button', 'customized-prompt-debug-button',
  'customized-flow-button', 'customized-comment-button',
  'customized-scroll-to-bottom-button', 'customized-more-button', 'toggle-sub-buttons',
];

/**
 * 聊天页背景图字段：bg_image（电脑）/ bg_mobile（手机）。
 * 插件不产出这两项资产；只有用户提供了已填 URL 的平台导出件才原样带出，不改成空值。
 */
export const BACKGROUND_FIELDS = {
  bg_img: ['bg_img', 'bg_image', 'back_img', 'bgimg'],
  mobile_bg: ['mobile_bg', 'bg_mobile', 'bg_mb'],
};

/** 从任意一份来源（阶段 JSON / 平台导出件）取出已填的背景图 URL。 */
export function pickBackground(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [canonical, aliases] of Object.entries(BACKGROUND_FIELDS)) {
    for (const key of aliases) {
      const v = source[key];
      if (typeof v === 'string' && v.trim()) { out[canonical] = v.trim(); break; }
    }
  }
  return out;
}

/** 世界书条目按平台真实形状归一：只保留平台认识的 12 个字段。 */
export const LORE_ENTRY_KEYS = [
  'group', 'match_type', 'key', 'key_region', 'value_type', 'value',
  'value_configs', 'value_region', 'sort', 'depth', 'probability', 'enable',
];

export function normalizeLoreEntry(entry, index = 0) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const asString = (v, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));
  const asNumber = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    group: asString(e.group),
    match_type: asNumber(e.match_type, 2),
    key: asString(e.key),
    key_region: asNumber(e.key_region, 6),
    value_type: asNumber(e.value_type, 0),
    value: asString(e.value),
    value_configs: Array.isArray(e.value_configs) ? e.value_configs : [],
    value_region: asNumber(e.value_region, 1),
    // 部署字段一律平台默认值：sort=0、depth=0、probability=100
    sort: asNumber(e.sort, 0),
    depth: asNumber(e.depth, 0),
    probability: asNumber(e.probability, 100),
    enable: typeof e.enable === 'boolean' ? e.enable : true,
  };
}

/**
 * 把内部规范结构转成平台导出格式。
 * 只支持已实测的那一种（v2）；不做多格式并存的自动适配。
 */
export function toPlatform(card, format = 'v2') {
  const spec = PLATFORM_FORMATS[format];
  if (!spec) throw new Error(`不支持的导出格式：${format}（当前只支持 ${Object.keys(PLATFORM_FORMATS).join(' / ')}）`);
  const wb = (Array.isArray(card.wb) ? card.wb : []).map((e, i) => normalizeLoreEntry(e, i));
  const out = {};

  Object.assign(out, JSON.parse(JSON.stringify(V2_DEFAULTS)));
  out.desc = card.desc || '';
  out.name = card.title || '';
  out.ptx = card.ptx || '';
  out.ai_variable_tmpl = card.ai_variable_tmpl || '';
  out.opening_statement = card.opening_statement || '';
  out.lore_bk = wb;
  out.ai_v_json = card.ai_v_json || '';
  out.built_in_css = card.built_in_css || '';
  out.pre_prompt = card.ppt || '';
  out.post_text = card.post_text || '';
  // 变量面板关闭时，extend 必须为 false 且三件套为空
  out.extend = { ai_variable_enabled: Boolean(card.ext && card.ext.ai_variable_enabled) };
  out.rgx_rep = normalizeRegexRules(card.rgx_rep);
  out.ai_variable_prompt = card.ai_v_prompt || '';
  // 背景图不产出：只有来源里已经有填好的 URL 才原样带出，否则保留空占位。
  const bg = pickBackground(card);
  if (bg.bg_img) out.bg_img = bg.bg_img;
  if (bg.mobile_bg) out.mobile_bg = bg.mobile_bg;
  return out;
}

export function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 忽略 */ }
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  // Windows 上 rename 偶发 EPERM/EBUSY（杀软或并发读写），重试几次再放弃。
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const retryable = ['EPERM', 'EBUSY', 'EACCES'].includes(e && e.code);
      if (!retryable || attempt >= 5) {
        try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
        throw e;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}
export function statePath(out) { return path.join(out, '.card-build', 'state.json'); }
export function readState(out) {
  const f = statePath(out);
  if (!fs.existsSync(f)) return null;
  // 容忍外部编辑器写入的 UTF-8 BOM，否则 JSON.parse 会直接抛错。
  const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}
export function writeState(out, state) { atomicWrite(statePath(out), JSON.stringify(state, null, 2)); }
export function newState(input) {
  return { flowVersion: FLOW_VERSION, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workId: sha256(`${Date.now()}-${Math.random()}`).slice(0, 12), brief: input.brief || '', type: input.type || 'auto', platform: input.platform || 'unknown', currentPart: 'writing', paused: false, parts: Object.fromEntries(PARTS.map(p => [p, { status:'not_started', version:0, files:[], digest:null, validation:null, feedback:[], generatedAt:null }])), dependencies: { profile:['writing'], chat:['writing','profile'], variables:['writing','chat'] }, issues: [], final: null, design: { phase: 'idle', parts: {} } };
}

/** 设计方案状态：pending → approved（或 skipped 表示按默认方案直接做）。 */
export const DESIGN_PHASE = { IDLE: 'idle', BRAINSTORMING: 'brainstorming', AWAITING: 'awaiting_approval', APPROVED: 'approved' };
export function ensureState(out, input, resume = false) {
  const existing = readState(out);
  if (existing && !resume) throw new Error(`作品目录已有状态，请使用 --resume：${out}`);
  const state = existing || newState(input);
  state.updatedAt = new Date().toISOString();
  writeState(out, state); return state;
}
export function markAwaiting(out, state, part, files) {
  const entries = files.map(f => ({ path:f, digest:sha256(fs.readFileSync(path.join(out,f),'utf8')) }));
  const p = state.parts[part]; p.status='awaiting_user_validation'; p.version=(p.version||0)+1; p.files=entries; p.digest=sha256(entries.map(x=>x.path+':'+x.digest).join('|')); p.generatedAt=new Date().toISOString(); p.validation=null;
  // 重新交付较早部分时，后续部分基于旧内容的 PASS 必须失效，否则会出现“前面待验证、后面已 PASS”的矛盾状态。
  invalidateDependents(state, part);
  state.currentPart=part; state.updatedAt=new Date().toISOString(); writeState(out,state);
}
export function invalidateDependents(state, part) { for (const [p,deps] of Object.entries(state.dependencies)) if (deps.includes(part) && state.parts[p].status==='pass') state.parts[p].status='stale'; }
export function passPart(out, part, feedback='') {
  const state=readState(out); if (!state) throw new Error('找不到作品状态');
  if (!PARTS.includes(part)) throw new Error(`未知部分：${part}`);
  const p=state.parts[part];
  if (p.status !== 'awaiting_user_validation') throw new Error(`当前部分不能 PASS：${PART_NAMES[part]} 当前状态为 ${p.status}（需先 deliver 生成待验证产物）`);
  if (!Array.isArray(p.files) || p.files.length === 0) throw new Error(`当前部分不能 PASS：${PART_NAMES[part]} 没有绑定任何已交付文件`);
  if (!p.digest) throw new Error(`当前部分不能 PASS：${PART_NAMES[part]} 缺少交付摘要`);
  for (const f of p.files) { const abs=path.join(out,f.path); if (!fs.existsSync(abs) || sha256(fs.readFileSync(abs,'utf8'))!==f.digest) { p.status='needs_revision'; invalidateDependents(state,part); writeState(out,state); throw new Error('检测到文件被手工修改，原 PASS 无效，请重新交付验证。'); } }
  p.status='pass'; p.validation={ confirmedAt:new Date().toISOString(), source:'explicit-user-confirmation', feedback }; state.currentPart=PARTS[PARTS.indexOf(part)+1] || part; state.updatedAt=new Date().toISOString(); writeState(out,state); return state;
}
export function failPart(out, part, feedback) { const state=readState(out); const p=state.parts[part]; p.status='needs_revision'; p.validation=null; p.feedback.push({ at:new Date().toISOString(), feedback }); invalidateDependents(state,part); state.updatedAt=new Date().toISOString(); writeState(out,state); return state; }
export function detectChanged(out) { const state=readState(out); if (!state) return []; const changed=[]; for (const [part,p] of Object.entries(state.parts)) for (const f of p.files) { const abs=path.join(out,f.path); if (!fs.existsSync(abs) || sha256(fs.readFileSync(abs,'utf8'))!==f.digest) { if (p.status==='pass') { p.status='needs_revision'; invalidateDependents(state,part); changed.push(part); } } } if (changed.length) writeState(out,state); return changed; }

export function matchWorldbook(entry, userText, lastAi='') {
  if (!entry.enable) return false; const text=`${userText}\n${lastAi}`; const key=entry.key || '';
  if (!key) return false;
  if (key.startsWith('_or_') || key.startsWith('_and_')) { const mode=key.startsWith('_or_')?'or':'and'; const tokens=key.slice(mode==='or'?4:5).split('@wb@').filter(x=>x!==''); if (!tokens.length) return false; return mode==='or' ? tokens.some(t=>text.includes(t)) : tokens.every(t=>text.includes(t)); }
  try { return new RegExp(key).test(text); } catch { return false; }
}
export function lintWorldbook(entries) { const diagnostics=[]; const CODE=/[A-Z]{2,}-\d{2,}/g; const codes=(t)=>[...String(t||'').matchAll(CODE)].map((m)=>m[0]); for (let i=0;i<entries.length;i++) { const e=entries[i]; if (!e.group) diagnostics.push({id:'WB001',severity:'warning',message:'世界书条目缺少 group',index:i}); if (![1,2,3].includes(e.match_type)) diagnostics.push({id:'WB002',severity:'error',message:'match_type 必须为 1/2/3',index:i}); if (![2,4,6].includes(e.key_region)) diagnostics.push({id:'WB003',severity:'error',message:'key_region 必须为 USER=2、AI=4 或组队(6)',index:i}); if (![1,2,3,4,5,6,7].includes(e.value_region)) diagnostics.push({id:'WB004',severity:'error',message:'value_region 不得为 0',index:i}); if (!e.key) diagnostics.push({id:'WB005',severity:'warning',message:'没有 key 永不匹配',index:i}); if (e.match_type===2&&!e.key.startsWith('_or_')) diagnostics.push({id:'WB006',severity:'error',message:'OR 条目 key 必须带 _or_ 前缀',index:i}); if (e.match_type===1&&!e.key.startsWith('_and_')) diagnostics.push({id:'WB007',severity:'error',message:'AND 条目 key 必须带 _and_ 前缀',index:i}); if (e.match_type===3&&/^(?:_or_|_and_)/.test(e.key)) diagnostics.push({id:'WB008',severity:'error',message:'REGEX 条目不得使用布尔前缀',index:i}); if (e.key_region===0) diagnostics.push({id:'WB009',severity:'error',message:'key_region=0 不匹配任何方向',index:i}); if (/^_(?:or|and)_/.test(e.key) && /(^|\s)or(\s|$)/i.test(String(e.key).replace(/^_(?:or|and)_/,''))) diagnostics.push({id:'WB111',severity:'error',message:'key 混用了「 or 」与 @wb@ 分隔符：整串会被当成一个词，条目几乎永不触发',index:i}); const kc=codes(e.key), vc=codes(e.value); if (kc.length && vc.length) { const pre=new Set(kc.map((c)=>c.split('-')[0])); const miss=kc.filter((c)=>!vc.includes(c)); const rel=vc.filter((c)=>pre.has(c.split('-')[0])); if (miss.length && rel.length) diagnostics.push({id:'WB112',severity:'warning',message:`key 里的编号 ${miss.join('、')} 与正文里的 ${rel.join('、')} 不一致：多半是复制错误`,index:i}); } }
 return diagnostics; }
export const REGEX_SCOPE_DEFAULT = 1;

/** 正则条目的 scope 省略时按 1（USER）处理；非法值由 lint 报错，不静默改写。 */
export function normalizeRegexRule(rule) {
  const r = rule && typeof rule === 'object' ? rule : {};
  return { ...r, scope: [1, 2, 10].includes(r.scope) ? r.scope : REGEX_SCOPE_DEFAULT };
}

export function normalizeRegexRules(rules) {
  return Array.isArray(rules) ? rules.map(normalizeRegexRule) : [];
}

export function lintRegex(rules) { const d=[]; if (!Array.isArray(rules)) return [{id:'RGX001',severity:'error',message:'rgx_rep 必须为数组'}]; for (let i=0;i<rules.length;i++) { const r=rules[i]; if (r.scope !== undefined && r.scope !== null && ![1,2,10].includes(r.scope)) d.push({id:'RGX002',severity:'error',message:'scope 只能为 USER=1、AI=2 或 GLOBAL=10（省略时按 1 处理）',index:i}); if (typeof r.is_enable!=='boolean') d.push({id:'RGX003',severity:'error',message:'缺少 is_enable 布尔值',index:i}); try { new RegExp(r.match_regex); } catch(e) { d.push({id:'RGX004',severity:'error',message:`正则无效：${e.message}`,index:i}); } if (r.is_enable && r.match_regex && r.replace_text===undefined) d.push({id:'RGX005',severity:'error',message:'启用规则必须保留 replace_text（允许空字符串）',index:i}); } return d; }

/* ============================================================
 * 世界书规则层：作者侧三标签（只存旁车，不进平台字段）
 * 职责：知识 / 规则 / 路由 / 控制词
 * 激活：内容锚 / 格式字段锚 / 格式标记锚
 * 载体：wb / ppt / ptx / post
 * 触发完全由第一部分决定；第三部分只渲染，不参与触发。
 * ============================================================ */

export const WB_PLAN_VERSION = 1;
export const WB_DUTIES = ['知识', '规则', '路由', '控制词'];
export const WB_ACTIVATIONS = ['内容锚', '格式字段锚', '格式标记锚'];
/** 旧标签兼容：知识关键词→内容锚、枚举锚→格式字段锚、控制锚→格式标记锚。 */
export const WB_ACTIVATION_ALIASES = { 知识关键词: '内容锚', 枚举锚: '格式字段锚', 控制锚: '格式标记锚' };
export const WB_CARRIERS = ['wb', 'ppt', 'ptx', 'post'];
export const CONTROL_WORDS = ['IDLE', 'CONTINUE', 'END'];
export const WB_BUDGET_TOTAL = 800;
export const WB_BUDGET_ENTRY = 600;
export const WB_PLAN_FILE = '.card-build/wb-plan.json';

/** 把新旧标签统一成正式名；不认识的返回空串。 */
export function normalizeActivation(value) {
  const s = String(value || '').trim();
  if (WB_ACTIVATIONS.includes(s)) return s;
  return WB_ACTIVATION_ALIASES[s] || '';
}

/** 读取作者侧世界书计划；不存在时返回 null（旧卡不参与标签校验）。 */
export function loadWbPlan(out) {
  const f = path.join(out, WB_PLAN_FILE);
  if (!fs.existsSync(f)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    if (!data || !Array.isArray(data.entries)) return null;
    return data;
  } catch {
    return null;
  }
}

/** 按 wb 数组下标（1 起）取计划条目。 */
export function wbPlanEntry(plan, wbIndex) {
  if (!plan) return null;
  return (plan.entries || []).find((e) => Number(e.index) === wbIndex + 1) || null;
}

/** 常驻类别：格式字段锚与格式标记锚都属于「每轮载」。 */
export function isResidentActivation(activation) {
  const a = normalizeActivation(activation);
  return a === '格式字段锚' || a === '格式标记锚';
}

const tokenList = (key) => wbTokens(key);

/** 锚词来源能否在产物里找到证据。 */
function anchorResolves(source, post) {
  const s = String(source || '').trim();
  const m = s.match(/^(post|enum|control)[:：]\s*(.+)$/);
  if (!m) return false;
  return post.includes(m[2].trim());
}

/**
 * 世界书规则层校验（WB101–WB110）。
 * 无 wb-plan.json 时直接放行：旧卡与未启用标签的卡不会被阻断。
 */
export function lintWorldbookPlan(stage, plan) {
  const d = [];
  if (!plan) return d;

  const wb = Array.isArray(stage.wb) ? stage.wb : [];
  const post = String(stage.post_text || '');
  const ptx = String(stage.ptx || '');
  const ppt = String(stage.ppt || '');
  const entries = plan.entries || [];
  const meta = (i) => wbPlanEntry(plan, i);
  const values = wb.map((e, i) => ({ i, e, m: meta(i), tokens: tokenList(e && e.key) }));
  const act = (v) => normalizeActivation(v && v.m && v.m['激活']);
  const fieldTokens = values.filter((v) => act(v) === '格式字段锚').flatMap((v) => v.tokens);
  const allEntryText = wb.map((e) => String((e && e.value) || '')).join('\n');

  // WB101 标签完整性
  values.forEach(({ i, m }) => {
    if (!m) {
      d.push({ id: 'WB101', severity: 'warning', message: `世界书第 ${i + 1} 条缺少作者侧标签（职责/激活/载体）：无法机械校验，按内容锚处理`, index: i });
      return;
    }
    if (!WB_DUTIES.includes(m['职责']) || !normalizeActivation(m['激活']) || !WB_CARRIERS.includes(m['载体'])) {
      d.push({ id: 'WB101', severity: 'warning', message: `世界书第 ${i + 1} 条标签取值不合法：职责=${m['职责']} 激活=${m['激活']} 载体=${m['载体']}`, index: i });
    }
  });

  // WB102 预算
  let residentChars = 0;
  values.forEach(({ i, e, m }) => {
    if (!m || !isResidentActivation(m['激活'])) return;
    const len = String((e && e.value) || '').length;
    residentChars += len;
    if (len > WB_BUDGET_ENTRY) {
      d.push({ id: 'WB102', severity: 'warning', message: `常驻条目第 ${i + 1} 条 ${len} 字，超过单条上限 ${WB_BUDGET_ENTRY}：应拆分或改为条件触发`, index: i });
    }
  });
  if (residentChars > WB_BUDGET_TOTAL) {
    d.push({ id: 'WB102', severity: 'warning', message: `常驻规则合计 ${residentChars} 字，超过每轮预算 ${WB_BUDGET_TOTAL}：把可条件化的细则改成条件触发` });
  }

  // WB103 常驻锚词证明
  values.forEach(({ i, m }) => {
    if (!m || !isResidentActivation(m['激活'])) return;
    const src = m.anchorSource;
    if (!src) {
      d.push({ id: 'WB103', severity: 'error', message: `常驻条目第 ${i + 1} 条缺 anchorSource：无法证明锚词每轮出现`, index: i });
    } else if (!anchorResolves(src, post)) {
      d.push({ id: 'WB103', severity: 'error', message: `常驻条目第 ${i + 1} 条的 anchorSource「${src}」在后置词里找不到：该锚词不成立，条目不会每轮触发`, index: i });
    }
  });

  // WB104 路由覆盖
  const routers = values.filter((v) => v.m && v.m['职责'] === '路由');
  const routeText = routers.map((v) => String((v.e && v.e.value) || '')).join('\n');
  if (fieldTokens.length && !routers.length) {
    d.push({ id: 'WB104', severity: 'warning', message: '存在格式字段锚条目但没有路由条目：顶层分支没有索引，模型不知道何时该取哪一条' });
  } else if (routers.length) {
    const uncovered = [...new Set(fieldTokens)].filter((t) => t && !routeText.includes(t));
    if (uncovered.length) {
      d.push({ id: 'WB104', severity: 'warning', message: `路由未覆盖这些字段分支：${uncovered.join('、')}` });
    }
  }

  // WB105 路由兜底
  routers.forEach(({ i, e }) => {
    const v = String((e && e.value) || '');
    if (!/兜底|默认|其余|无匹配/.test(v)) {
      d.push({ id: 'WB105', severity: 'error', message: `路由条目第 ${i + 1} 条没有兜底分支：状态切换的空窗期会掉规则`, index: i });
    }
  });

  // WB106 格式标记成对
  const controlEntries = values.filter((v) => act(v) === '格式标记锚');
  controlEntries.forEach(({ i, tokens }) => {
    const miss = tokens.filter((t) => t && !post.includes(t));
    if (miss.length) {
      d.push({ id: 'WB106', severity: 'error', message: `格式标记条目第 ${i + 1} 条的标记 ${miss.join('、')} 未出现在后置词状态行里：模型不会输出它，条目永不触发`, index: i });
    }
  });
  const posted = CONTROL_WORDS.filter((w) => post.includes(w));
  const declared = new Set(controlEntries.flatMap((v) => v.tokens));
  // 只有 END（结算）与 IDLE（兜底）必须有条目承接；CONTINUE 只是进行中，不需要独立规则。
  const orphan = posted.filter((w) => (w === 'END' || w === 'IDLE') && !declared.has(w));
  if (orphan.length) {
    d.push({ id: 'WB106', severity: 'error', message: `后置词输出了控制词 ${orphan.join('、')}，但没有对应条目承接：状态切换时没有规则可载` });
  }

  // WB107 结算类被标成常驻
  values.forEach(({ i, m }) => {
    if (m && m['职责'] === '控制词' && act({ m }) !== '格式标记锚') {
      d.push({ id: 'WB107', severity: 'warning', message: `第 ${i + 1} 条是结算/控制类条目，却标为「${m['激活']}」：结算层应挂格式标记锚，避免每轮常驻`, index: i });
    }
  });

  // WB108 AND 词必然性
  values.forEach(({ i, e, tokens }) => {
    if (!e || e.match_type !== 1) return;
    const weak = tokens.filter((t) => {
      if (!t) return false;
      if (post.includes(t) || ptx.includes(t)) return false;
      if (fieldTokens.includes(t)) return false;
      const own = String((e && e.value) || '');
      return !allEntryText.replace(own, '').includes(t);
    });
    if (weak.length) {
      d.push({ id: 'WB108', severity: 'warning', message: `第 ${i + 1} 条 AND 词 ${weak.join('、')} 找不到「必然出现」的证据：可能导致整条永不触发`, index: i });
    }
  });

  // WB109 状态机五件套（可机械判定的三项）
  if (controlEntries.length) {
    const missing = CONTROL_WORDS.filter((w) => !post.includes(w));
    if (missing.length) {
      d.push({ id: 'WB109', severity: 'error', message: `启用状态机但后置词状态行缺少 ${missing.join('、')}：三态定义不全` });
    }
    if (!declared.has('END')) {
      d.push({ id: 'WB109', severity: 'error', message: '启用状态机但没有挂 END 的结算条目：事件结束时不会加载结算规则' });
    }
    if (!declared.has('IDLE')) {
      d.push({ id: 'WB109', severity: 'error', message: '启用状态机但没有 IDLE 兜底条目：空闲轮次会掉规则' });
    }
  } else if (!CONTROL_WORDS.some((w) => post.includes(w)) && /阶段|时限|倒计时|进度/.test(ppt)) {
    // WB110 空承诺
    d.push({ id: 'WB110', severity: 'warning', message: '主提示词承诺了阶段/时限/进度，但没有启用状态机：承诺无法兑现，应补格式标记方案或删掉承诺' });
  }

  // WB111 / WB112 已上移到 lintWorldbook，无旁车也检查（纯内容缺陷）。

  // WB113 内容锚却挂在常驻锚上：实际每轮加载
  const residentTokens = new Set(values.filter((v) => isResidentActivation(v.m && v.m['激活'])).flatMap((v) => v.tokens));
  values.forEach(({ i, tokens, m }) => {
    if (normalizeActivation(m && m['激活']) !== '内容锚') return;
    const meaningful = tokens.filter((t) => t.length >= 2);
    if (meaningful.length && meaningful.every((t) => residentTokens.has(t))) {
      d.push({ id: 'WB113', severity: 'warning', message: `第 ${i + 1} 条标为内容锚，但触发词全是常驻锚：实际会每轮加载，应改标格式字段锚或换成真正的条件词`, index: i });
    }
  });

  return d;
}

export function lintStageJson(part, value, opts = {}) { const d=[]; const strings=['title','ppt','ptx','post_text','opening_statement','desc','built_in_css','ai_variable_tmpl','ai_v_prompt','ai_v_json']; for(const k of strings) if(typeof value[k]!=='string') d.push({id:'STAGE001',severity:'error',message:`${part} 阶段 ${k} 必须是字符串`}); if(!Array.isArray(value.wb)||!Array.isArray(value.rgx_rep)) d.push({id:'STAGE002',severity:'error',message:'wb 与 rgx_rep 必须是数组'}); if(typeof value.ext!=='object'||typeof value.ext.ai_variable_enabled!=='boolean') d.push({id:'STAGE003',severity:'error',message:'ext.ai_variable_enabled 必须是布尔值'}); if(part==='writing') { d.push(...lintWorldbook(value.wb)); for(const e of value.wb) { if(typeof e.value!=='string') d.push({id:'STAGE004',severity:'error',message:'世界书 value 必须是正文字符串'}); if(typeof e.key!=='string'||typeof e.match_type!=='number'||typeof e.key_region!=='number'||typeof e.value_region!=='number'||typeof e.enable!=='boolean') d.push({id:'STAGE005',severity:'error',message:'每条世界书必须同时包含正文和触发配置'}); } d.push(...lintWorldbookPlan(value, opts.plan)); } if(part==='chat') { d.push(...lintRegex(value.rgx_rep)); d.push(...lintChatCss(value.built_in_css)); } if(part==='writing') d.push(...lintWritingCues(value, opts)); return d; }

/**
 * 聊天页 CSS 层检查：气泡必须「半适配」平台不透明度滑块，
 * 按钮锚点与焦点行为必须落在聊天页 §2.3 / §8.7 已登记的范围内。
 * 只做启发式提示，不阻断交付；平台真实渲染仍需人工验证。
 */
export function lintChatCss(css) {
  const d = [];
  const text = String(css || '');
  const BODY = /^#customized-(?:answer|question)-content([:[].*)?$/;
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const known = new Set(CHAT_CONTAINER_IDS);
  const flagged = new Set();
  let m;
  while ((m = ruleRe.exec(text))) {
    const selectorText = m[1];
    const body = m[2];
    const selectors = selectorText.split(',').map((s) => s.trim()).filter(Boolean);

    // CSS004：MUI emotion 动态类不能作锚点（哈希随构建变化，作用域不可控）
    const emotion = selectorText.match(/\.css-[a-z0-9]{4,}/i);
    if (emotion && !flagged.has('CSS004')) {
      flagged.add('CSS004');
      d.push({ id: 'CSS004', severity: 'warning', message: `使用了 MUI 动态类「${emotion[0]}」作锚点：每次构建都会变，失配时静默失效且会命中不相关按钮；改用 §2.3 已登记 ID 或属性选择器` });
    }

    // CSS005：删除焦点提示，平台默认被抹掉
    if (/outline\s*:\s*(?:none|0)\b/.test(body) && selectors.some((s) => /:focus(?!-visible)/.test(s)) && !flagged.has('CSS005')) {
      flagged.add('CSS005');
      d.push({ id: 'CSS005', severity: 'warning', message: '对 :focus 写了 outline: none：会抹掉平台默认焦点提示；不写即可，确需自定义时只允许 :focus-visible 且必须有可见提示' });
    }

    // CSS006：清单外的平台容器 ID
    for (const s of selectors) {
      for (const idMatch of s.matchAll(/#([a-z][a-z0-9-]+)/g)) {
        const id = idMatch[1];
        const looksPlatform = id.startsWith('customized-') || id.startsWith('ai-') || id === 'toggle-sub-buttons';
        if (!looksPlatform || known.has(id) || flagged.has(`CSS006:${id}`)) continue;
        flagged.add(`CSS006:${id}`);
        d.push({ id: 'CSS006', severity: 'warning', message: `#${id} 不在聊天页 §2 已登记容器清单：先登记语义再使用，不能凭命名族推断它是已证实的平台容器` });
      }
    }

    for (const part of selectors) {
      const hit = part.match(BODY);
      if (!hit) continue;
      const guarded = /:not\(\[style\]\)|\[style\s*=\s*["']{2}\]/.test(hit[1]);
      const opaqueBg = /(?:^|[;\s])background(?:-color)?\s*:\s*(?!\s*(?:transparent|none|inherit|unset|initial)\b)/.test(body);
      if (opaqueBg && !guarded) {
        d.push({ id: 'CSS001', severity: 'warning', message: `气泡本体「${part}」设置了不带 :not([style]) 守卫的背景：会连同 !important 覆盖平台不透明度滑块，背景图无法露出` });
      }
      if (/backdrop-filter\s*:/.test(body)) {
        d.push({ id: 'CSS002', severity: 'warning', message: `气泡本体「${part}」使用了 backdrop-filter：会模糊背景图，滑块为 0 时背景也不清晰` });
      }
    }
  }
  if (/(?:^|\})\s*(?:html|body|#root|#app)\s*\{[^}]*background(?:-color)?\s*:\s*(?!\s*(?:transparent|none)\b)/.test(text)) {
    d.push({ id: 'CSS003', severity: 'warning', message: '页面根容器设置了不透明背景：bg_image / bg_mobile 背景图会被整页底色盖住' });
  }

  // 浮动按钮：展开态必须浮在最上层且能关闭（变量面板 §7.5）
  const hasDataOpen = /\[data-state\s*=\s*["']open["']\]/.test(text);
  const hasAriaOpen = /\[aria-expanded\s*=\s*["']true["']\]/.test(text);
  if (hasDataOpen || hasAriaOpen) {
    if (!(hasDataOpen && hasAriaOpen)) {
      d.push({ id: 'CSS008', severity: 'warning', message: '浮动按钮打开态只写了一种标记：必须同时写 [data-state="open"] 与 [aria-expanded="true"]，否则在另一种平台实现下失效' });
    }
    const openRules = [];
    let om;
    const openRe = /([^{}]+)\{([^{}]*)\}/g;
    while ((om = openRe.exec(text))) {
      if (/\[data-state\s*=\s*["']open["']\]|\[aria-expanded\s*=\s*["']true["']\]/.test(om[1])) openRules.push(om[2]);
    }
    const topMost = openRules.some((b) => {
      const z = b.match(/(?:^|[;\s])z-index\s*:\s*(\d+)/);
      return z && Number(z[1]) >= 1000000;
    });
    if (!topMost) {
      d.push({ id: 'CSS007', severity: 'warning', message: '浮动按钮展开态缺少顶层 z-index（应为 2147483647）：会被固定定位浮层盖住，玩家点不到关闭' });
    }
  }
  return d;
}

/** 写作内容层检查：示例必须占位、通用段落到齐、构建期规则不得进主提示词。 */
export function lintWritingCues(value, opts = {}) {
  const d = [];
  const plan = opts.plan || null;
  const ppt = String(value.ppt || '');
  const ptx = String(value.ptx || '');
  const post = String(value.post_text || '');

  if (/完整示例|完整输出示例/.test(post)) {
    d.push({ id: 'CUE001', severity: 'error', message: '后置词不得包含完整示例：示例会被模型当成剧情先例，只允许段落清单与占位模板' });
  }

  const ptxLines = ptx.split('\n').map((l) => l.trim()).filter((l) => /^·/.test(l));
  const placeholder = (l) => /：\s*(X+|「未知」|未知|空|—|-)?\s*$/.test(l) || /：\s*X+\s*\/\s*X+\s*$/.test(l);
  const concrete = ptxLines.filter((l) => /：\s*\S/.test(l) && !placeholder(l));
  if (ptxLines.length >= 5 && concrete.length >= 5) {
    d.push({ id: 'CUE002', severity: 'error', message: `前置词是填好的具体角色快照（${concrete.length}/${ptxLines.length} 行有具体值）：应改为占位模板（只写 X 或「未知」），否则运行时会替换玩家角色` });
  }

  if (/示例[：:]\s*[「“]/.test(ppt)) {
    d.push({ id: 'CUE003', severity: 'warning', message: '主提示词含具体场景示例，应改为抽象文风参数（字数/人称/比例），不写具体句子' });
  }

  if (/抽取|随机池|校验|前端|面板|按钮/.test(ppt)) {
    d.push({ id: 'CUE006', severity: 'error', message: '主提示词混入构建期要求（抽取/随机/校验/前端/面板/按钮），应归入档案页或变量面板，不得写入 writing' });
  }

  for (const [label, needle] of [['角色信息', '【角色信息】'], ['记忆区', '【记忆区】'], ['行动建议', '【行动建议】']]) {
    if (!post.includes(needle)) d.push({ id: 'CUE005', severity: 'error', message: `后缀词缺少通用固定段落：${label}（所有卡必须包含，规则照搬）` });
  }

  // 【时间地点】必须是固定首段：它是聊天页包裹正文的稳定锚点，标题与两个字段名不得改。
  const HEAD = /【([^】\n]{1,12})】/g;
  const heads = [...post.matchAll(HEAD)].map((m) => ({ name: m[1], index: m.index ?? 0 }));
  const timeHead = heads.find((h) => h.name === '时间地点');
  if (!timeHead) {
    d.push({ id: 'CUE010', severity: 'error', message: '后缀词缺少固定首段【时间地点】（每轮输出的第一段，聊天页据此包裹正文）' });
  } else {
    if (heads[0] && heads[0].index !== timeHead.index) {
      d.push({ id: 'CUE011', severity: 'error', message: `【时间地点】必须是第一个段落，当前前面还有【${heads[0].name}】` });
    }
    const start = timeHead.index + '【时间地点】'.length;
    const next = heads.find((h) => h.index > timeHead.index);
    const block = post.slice(start, next ? next.index : post.length);
    for (const [label, pattern] of [['时间', /时间[：:]/], ['地点', /地点[：:]/]]) {
      if (!pattern.test(block)) d.push({ id: 'CUE012', severity: 'error', message: `【时间地点】段缺少「${label}：」字段` });
    }
  }

  // 触发词不得出现在前缀词或后置词里：那两段每轮固定注入，会让条目变成事实常驻。
  // 例外：格式字段锚与格式标记锚本就是「每轮必现」的锚词，放行后由 WB103 / WB106 校验其证据。
  const entries = Array.isArray(value.wb) ? value.wb : [];
  entries.forEach((entry, i) => {
    const meta = wbPlanEntry(plan, i);
    const anchored = isResidentActivation(meta && meta['激活']);
    const tokens = wbTokens(entry && entry.key);
    if (!anchored) {
      const hits = tokens.filter((t) => t.length >= 2 && (ptx.includes(t) || post.includes(t)));
      if (hits.length) {
        d.push({
          id: 'CUE007',
          severity: 'error',
          message: `世界书第 ${i + 1} 条触发词出现在前缀词或后置词中：${hits.join('、')}（这两段每轮固定注入，会导致该条每轮误触发；若确为常驻，应在 wb-plan 标为格式字段锚/格式标记锚）`,
        });
      }
    }
    // depth 默认 0；写成 3/4 往往是把说明示例当成了默认值。
    if (entry && typeof entry.depth === 'number' && entry.depth !== 0) {
      d.push({
        id: 'CUE008',
        severity: 'warning',
        message: `世界书第 ${i + 1} 条 depth=${entry.depth}，默认应为 0；只有当确实需要更深扫描时才显式设置`,
      });
    }
  });

  // 平台支持成人内容：卡内不需要安全声明与免责话术
  const DISCLAIMER = /(免责声明|内容警告|可能引起不适|如感不适|请勿模仿|未成年人禁止|仅供成年|本作品包含|本卡包含|安全提示)/;
  for (const [field, text] of [['ppt', ppt], ['ptx', ptx], ['post_text', post]]) {
    const hit = DISCLAIMER.exec(text);
    if (hit) {
      d.push({
        id: 'CUE009',
        severity: 'warning',
        message: `${field} 含安全声明类话术「${hit[0]}」：平台支持成人内容，不需要免责或警告声明`,
      });
    }
  }

  // 自我审查痕迹：模型拒绝或删改时常留下的替代写法
  // 否定句里提到这些词不算（例如「不得用『镜头一转』带过」是正当的写作要求）
  const SELF_CENSOR = /(此处省略|以下省略|此处略去|此处不表|暂且不表|内容略|（略）|\(略\)|不可描述|自行想象|镜头一转|为保持适宜|出于.{0,6}考虑.{0,4}(?:省略|略过)|■{3,})/g;
  const NEGATION = /(不得|不要|禁止|避免|不可|严禁|勿|别)[^。；;！!？?，,、\n]{0,16}$/;
  const findCensor = (text) => {
    SELF_CENSOR.lastIndex = 0;
    let m;
    while ((m = SELF_CENSOR.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (NEGATION.test(before)) continue;
      return m;
    }
    return null;
  };
  for (const [field, text] of [['ppt', ppt], ['post_text', post]]) {
    const hit = findCensor(text);
    if (hit) {
      d.push({
        id: 'CUE011',
        severity: 'warning',
        message: `${field} 出现自我审查痕迹「${hit[0]}」：这通常说明生成时被删改或模型拒绝过；应换用不审查的模型重写这一段，不要保留删改版`,
      });
    }
  }

  // 成人向卡必须写玩家代理边界（强制）
  const ADULT = /(成人向|R18|18\+|露骨|明确描写)/;
  const AGENCY = /(接管点|玩家代理|不替玩家|不得代|停在玩家)/;
  if (ADULT.test(ppt) || ADULT.test(post)) {
    const scope = [ppt, post, ptx].join('\n');
    if (!AGENCY.test(scope)) {
      d.push({
        id: 'CUE013',
        severity: 'warning',
        message: '疑似成人向卡，但没有写到玩家代理边界：应在 ppt 写明「每轮停在玩家可接管的点」与七项禁止代做（台词/想法/决定/移动/用物/未观察事实/时间跳跃）。规则见 docs/5 §5.2',
      });
    }
  }

  return d;
}
/** 从世界书 key 里取出 OR/AND 关键词；正则条目返回空数组。 */
export function wbTokens(key) {
  const k = typeof key === 'string' ? key : '';
  if (k.startsWith('_or_')) return k.slice(4).split('@wb@').filter(Boolean);
  if (k.startsWith('_and_')) return k.slice(5).split('@wb@').filter(Boolean);
  return [];
}

export function lintCard(card, opts={}) { const d=[]; if (!card.title) d.push({id:'CARD001',severity:'error',message:'缺少 title'}); if (typeof card.ptx!=='string') d.push({id:'CARD002',severity:'error',message:'ptx 必须是前缀词字符串，不得承载主提示词'}); if (typeof card.post_text!=='string') d.push({id:'CARD003',severity:'error',message:'缺少 post_text'}); if (!Array.isArray(card.wb)) d.push({id:'CARD004',severity:'error',message:'wb 必须是数组'}); else d.push(...lintWorldbook(card.wb)); d.push(...lintRegex(card.rgx_rep)); if (card.ext?.ai_variable_enabled && typeof card.ai_v_json!=='string') d.push({id:'CARD005',severity:'error',message:'启用变量面板时 ai_v_json 必须是字符串'}); if (opts.requireMainPrompt && !card.ppt) d.push({id:'CARD006',severity:'error',message:'缺少用户确认的主提示词键 ppt，阻断导出'}); return d; }

export function semanticProfile() { return { profileVersion:'3.0', target:'platform-format-registry', formats:Object.keys(PLATFORM_FORMATS), activeFormat:'v2', aliases:FIELD_ALIASES, fields:{ title:{canonical:'title',formats:{v1:'title',v2:'name'},type:'string'}, mainPrompt:{canonical:'ppt',formats:{v1:'ppt',v2:'pre_prompt'},type:'string'}, prefix:{canonical:'ptx',type:'string'}, suffix:{canonical:'post_text',type:'string'}, opening:{canonical:'opening_statement',type:'string'}, worldbook:{canonical:'wb',formats:{v1:'wb',v2:'lore_bk'},type:'array'}, intro:{canonical:'desc',type:'string'}, css:{canonical:'built_in_css',type:'string'}, regex:{canonical:'rgx_rep',type:'array'}, variableTemplate:{canonical:'ai_variable_tmpl',type:'string'}, variablePrompt:{canonical:'ai_v_prompt',formats:{v1:'ai_v_prompt',v2:'ai_variable_prompt'},type:'string'}, variableSchema:{canonical:'ai_v_json',type:'string'}, panelEnabled:{canonical:'panel',formats:{v1:'ext.ai_variable_enabled',v2:'extend.ai_variable_enabled'},type:'boolean'}}, enums:{worldbook:{AND:1,OR:2,REGEX:3,key_region:{USER:2,AI:4,BOTH:6},value_region:{SYSTEM:1,PRE:2,SUFFIX:4}},regex:{scope:{USER:1,AI:2,GLOBAL:10}}}, unresolved:['lore_bk 元素内部结构未取得样本','正则执行器 flags/时机未确认','v2 各数值枚举语义未确认'], note:'平台导出字段名会漂移：读入按别名兼容，导出按 PLATFORM_FORMATS 指定格式生成。' }; }

/** 读取各部分的阶段 JSON（取已绑定文件里的 .json）。 */
export function readPartJsons(out, state) {
  const files = {};
  for (const p of PARTS) for (const f of state.parts[p].files || []) { files[p] = files[p] || []; files[p].push(f.path); }
  const one = (p) => {
    const f = (files[p] || []).find((x) => x.endsWith('.json'));
    return f ? JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')) : {};
  };
  return { writing: one('writing'), profile: one('profile'), chat: one('chat'), variables: one('variables') };
}

/** 把四部分阶段 JSON 归一成卡片数据；缺的部分留空占位。传 only 时只取列出的部分。 */
export function buildCardData(out, state, opts = {}) {
  const parts = readPartJsons(out, state);
  const only = Array.isArray(opts.only) ? new Set(opts.only) : null;
  const pick = (p) => (only && !only.has(p) ? {} : parts[p] || {});
  const w = pick('writing'), d = pick('profile'), c = pick('chat'), v = pick('variables');
  // 背景图只做透传：用户若给了已填 URL 的平台导出件，组装时保留原值，不改成空。
  const bg = {};
  for (const p of ['writing', 'profile', 'chat', 'variables']) {
    if (only && !only.has(p)) continue;
    for (const [k, val] of Object.entries(pickBackground(parts[p]))) if (!bg[k]) bg[k] = val;
  }
  return { title: w.title || state.title || path.basename(out), ppt: w.ppt || '', ptx: w.ptx || '', post_text: w.post_text || '', opening_statement: w.opening_statement || '', wb: Array.isArray(w.wb) ? w.wb : [], desc: d.desc || '', built_in_css: c.built_in_css || '', rgx_rep: Array.isArray(c.rgx_rep) ? c.rgx_rep : [], ai_variable_tmpl: v.ai_variable_tmpl || '', ai_v_prompt: v.ai_v_prompt || '', ai_v_json: v.ai_v_json || '', bg_img: bg.bg_img || '', mobile_bg: bg.mobile_bg || '', ext: { ai_variable_enabled: v.ext?.ai_variable_enabled === true } };
}

/** 当前可并入的部分：已交付待验证或已 PASS，且有阶段 JSON。 */
export function mergeableParts(state) {
  const included = []; const missing = []; const stale = [];
  for (const p of PARTS) {
    const st = state.parts[p];
    const files = (st.files || []).map((f) => f.path);
    const hasStage = files.some((f) => f.endsWith('.json'));
    if (['awaiting_user_validation', 'pass'].includes(st.status) && hasStage) included.push(p);
    else if (st.status === 'stale') stale.push(p);
    else missing.push(p);
  }
  return { included, missing, stale };
}

/**
 * 增量组装：把当前已交付的部分合成一整份卡，覆盖写 card.json。
 * 平台导入是整卡覆盖，所以恢复全卡只能导入这份累计文件；单部分导入件只用于单独测试。
 */
export function mergeParts(out, opts = {}) {
  const format = String(opts.format || 'v2');
  if (!PLATFORM_FORMATS[format]) throw new Error(`未知平台格式：${format}（可选 ${Object.keys(PLATFORM_FORMATS).join(' / ')}）`);
  const state = readState(out);
  if (!state) throw new Error('请先执行 start');
  const { included, missing, stale } = mergeableParts(state);
  if (!included.length) throw new Error('还没有可组装的部分：先 deliver 至少一个部分');
  const platform = toPlatform(buildCardData(out, state, { only: included }), format);
  atomicWrite(path.join(out, 'card.json'), JSON.stringify(platform, null, 2));
  const bytes = fs.statSync(path.join(out, 'card.json')).size;
  state.merged = { at: new Date().toISOString(), file: 'card.json', format, parts: included, missing, stale, bytes };
  // card.json 被累计件覆写了：之前 assemble 产出的 final 已不代表当前文件，标记取代关系。
  const supersededFinal = state.final && !state.final.supersededAt ? { ...state.final } : null;
  if (state.final) {
    state.final.supersededAt = state.merged.at;
    state.final.supersededBy = String(opts.by || 'merge');
  }
  state.updatedAt = new Date().toISOString();
  writeState(out, state);
  const notes = [];
  if (missing.length) notes.push(`未交付：${missing.map((p) => PART_NAMES[p]).join('、')}（这些字段在 card.json 里为空占位）`);
  if (stale.length) notes.push(`已过期未并入：${stale.map((p) => PART_NAMES[p]).join('、')}，需重新 deliver 后才会合进来`);
  if (supersededFinal) notes.push(`card.json 已刷新，之前 assemble 的最终件（${supersededFinal.playable ? '可玩版本' : '完整版'}）被取代；需要以当前内容为准时重新 assemble。`);
  return { format, file: 'card.json', bytes, parts: included, missing, stale, supersededFinal: Boolean(supersededFinal), notes };
}

export function assemble(out, opts = {}) {
 const format = String(opts.format || 'v2');
 if (!PLATFORM_FORMATS[format]) throw new Error(`未知平台格式：${format}（可选 ${Object.keys(PLATFORM_FORMATS).join(' / ')}）`);
 const state=readState(out); if (!state) throw new Error('找不到作品状态');
 const notPlayable = PLAYABLE_PARTS.filter((p) => state.parts[p].status !== 'pass');
 if (notPlayable.length) throw new Error(`无法组装：${notPlayable.map((p) => PART_NAMES[p]).join('、')} 尚未取得当前版本用户 PASS（前三部分是可玩版本的最低要求）`);
 const panelReady = state.parts.variables.status === 'pass';
 const useParts = panelReady ? [...PLAYABLE_PARTS, 'variables'] : [...PLAYABLE_PARTS];
 const data = buildCardData(out, state, { only: useParts });
 const lint=lintCard(data,{requireMainPrompt:true}); if(lint.some(x=>x.severity==='error')) throw new Error(`组装校验失败：${lint.map(x=>x.message).join('；')}`);
 const platform=toPlatform(data, format);
 const roundTrip=JSON.parse(JSON.stringify(platform)); if(JSON.stringify(roundTrip)!==JSON.stringify(platform)) throw new Error('JSON 语义往返失败');
 atomicWrite(path.join(out,'card.json'),JSON.stringify(platform,null,2));
 const wbNote = format==='v2' && data.wb.length ? `\n- 世界书：${data.wb.length} 条经 fengyue.ai 导入实测通过（2026-11-05），但运行时触发效果仍需对话验证。` : '';
 const panelNote = panelReady
  ? '\n- 变量面板：已并入（第四部分 PASS）。面板按钮与浮动入口的外观归第三部分 built_in_css；要改这些外观，改第三部分 CSS 后需重新验证，不要写进面板模板。'
  : '\n- 变量面板：本次未并入（第四部分未完成或未 PASS）——这份是「可玩版本」，面板相关字段为空占位。要做拓展功能，再交付第四部分，然后重新 assemble。\n- 变量面板按钮与浮动入口的外观属于第三部分 built_in_css；之后做面板照样不要把这些样式写进模板，要改就回第三部分改 CSS 并重新验证。';
 const bgNote = (data.bg_img || data.mobile_bg)
  ? `\n- 背景图：沿用来源里已填的 URL（电脑 ${data.bg_img ? '有' : '空'} / 手机 ${data.mobile_bg ? '有' : '空'}），组装不改写。`
  : '\n- 背景图：bg_img / mobile_bg 为空占位（插件不产出背景图）。请在平台导入后再设置电脑端与手机端背景图；之后如再导入本卡，会被这里重新覆盖为空。';
 const report=`# RP 卡组装报告\n\n- 流程版本：${FLOW_VERSION}\n- 导出格式：${format}（${PLATFORM_FORMATS[format].label}）\n- 版本形态：${panelReady ? '完整版（含变量面板）' : '可玩版本（前三个部分，未含变量面板）'}\n- 字段归属：writing→title/ppt/ptx/post_text/opening_statement/wb；profile→desc；chat→built_in_css/rgx_rep；variables→ai_variable_tmpl/ai_v_prompt/ai_v_json/panel。\n- 已并入部分：${useParts.map((p) => PART_NAMES[p]).join('、')}（均为当前版本明确用户 PASS，${new Date().toISOString()}）${panelNote}\n- 世界书：${data.wb.length} 条，正文与触发配置同时保留。${wbNote}${bgNote}\n- 本地校验：阶段 JSON 类型、字段归属、世界书/正则诊断、聊天页 CSS 诊断、格式映射、JSON 往返已执行。\n- 限制：目标平台真实导入与正则执行时机仍需四次门禁人工验证；本文件不冒充平台 PASS。\n`;
 atomicWrite(path.join(out,'build-report.md'),report);
 state.final={card:'card.json',report:'build-report.md',format,playable:!panelReady,parts:useParts,digest:sha256(JSON.stringify(platform)),fieldOwnership:{writing:['title','ppt','ptx','post_text','opening_statement','wb'],profile:['desc'],chat:['built_in_css','rgx_rep'],variables:['ai_variable_tmpl','ai_v_prompt','ai_v_json','panel']}};
 state.updatedAt=new Date().toISOString(); writeState(out,state);
 return { format, card:platform, report, playable: !panelReady, parts: useParts };
}

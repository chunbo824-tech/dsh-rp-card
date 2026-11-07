import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureState, readState, writeState, markAwaiting, passPart, failPart,
  detectChanged, assemble, mergeParts, PARTS, PLAYABLE_PARTS, PART_NAMES, lintCard, lintWorldbook,
  lintRegex, lintStageJson, semanticProfile, loadWbPlan,
  pickField, pickPanelFlag, toPlatform, PLATFORM_FORMATS, normalizeRegexRules,
} from './lib/core.js';
import { runAssetAction } from './lib/asset-actions.js';
import { keyStatus } from './lib/image-setup.js';
import { loadManifest } from './lib/assets.js';
import { evaluateAction } from './lib/evaluate.js';
import { resolveVisionDelegate } from './lib/vision.js';

// 视觉检查委托目标：环境变量 > profile 的 subagent 允许列表首个 DeepSeek 项 > 兜底。
const VISION = resolveVisionDelegate();

// 四份规范随插件分发：路径按本文件位置计算，不依赖用户工作区或安装位置。
export const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DOCS_DIR = path.join(PLUGIN_DIR, 'docs');
const DOC = {
  writing: path.join(DOCS_DIR, '1-写卡提示词.txt'),
  profile: path.join(DOCS_DIR, '2-档案页.txt'),
  chat: path.join(DOCS_DIR, '3-聊天页.txt'),
  variables: path.join(DOCS_DIR, '4-变量面板.txt'),
};

const SPEC = {
  writing: `依据 ${DOC.writing}：生成写卡正文、前缀词、后缀词、世界书、开场协议；后缀以【时间地点】为固定首段；交付后停止等待人工平台验证。`,
  profile: `依据 ${DOC.profile}：生成完整单文件 HTML；交付后停止等待人工平台验证。`,
  chat: `依据 ${DOC.chat}：生成 built_in_css 与 rgx_rep；交付后停止等待人工平台验证。`,
  variables: `依据 ${DOC.variables}：生成 Schema、变量 Prompt 与模板；交付后停止等待人工平台验证。`,
};

const SOURCE_FILE = {
  writing: '01-writing.md',
  profile: '02-profile.html',
  chat: '03-chat.css',
  variables: '04-variables.md',
};

const STAGE_FILE = {
  writing: 'part-1-writing.json',
  profile: 'part-2-description.json',
  chat: 'part-3-chat.json',
  variables: 'part-4-variable.json',
};

const PART_INDEX = { writing: 1, profile: 2, chat: 3, variables: 4 };

/** 仍在用供应商临时 URL 的资源 id：这些必须换成平台长期 URL 后才算嵌入完成。 */
function pendingAssetUploads(out) {
  const manifest = loadManifest(out);
  return manifest.assets
    .filter((a) => a && a.type !== 'icon_svg' && a.type !== 'decoration_svg')
    .filter((a) => a.mime !== 'image/svg+xml')
    .filter((a) => a.remoteUrlSource !== 'platform')
    .map((a) => a.id);
}

const STRING_FIELDS = [
  'title', 'ppt', 'ptx', 'post_text', 'opening_statement',
  'desc', 'built_in_css', 'ai_variable_tmpl', 'ai_v_prompt', 'ai_v_json',
];

// 目标平台默认值：用户已确认使用 fengyue.ai，不再每次询问。
const DEFAULT_PLATFORM = 'fengyue.ai';
const CARD_TYPES = ['日常角色扮演', '恋爱互动', '冒险探索', '生存模拟', '悬疑解谜', '经营模拟'];

function svc(ctx, name) {
  try { return ctx.get(name); } catch { return undefined; }
}

function parseArgs(raw = '') {
  const text = String(raw ?? '').trim();
  const a = {};
  const head = text.match(/^(start|status|template|deliver|export|merge|pass|fail|pause|resume|assemble|propose|approve-design)\b/);
  a.action = head ? head[1] : 'start';
  const re = /--([a-z][a-z0-9-]*)(?:\s+"([^"]*)"|\s+'([^']*)'|\s+(\S+))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const key = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4];
    a[key] = value === undefined ? true : value;
  }
  if (!a.brief && a.action === 'start' && !head && text && !text.startsWith('--')) a.brief = text;
  return a;
}

function outDir(args) {
  if (args.out) return path.resolve(String(args.out));
  // 未显式给 --out 时，从 --file 路径反推作品目录（支持 <out>/.card-build/xxx.json）
  if (args.file) {
    const file = path.resolve(String(args.file));
    const marker = `${path.sep}.card-build${path.sep}`;
    const at = file.indexOf(marker);
    if (at > 0) return file.slice(0, at);
    return path.dirname(file);
  }
  // 默认作品目录＝当前会话工作区。Host 进程的 process.cwd() 是 profile 目录，
  // 因此由 execute 先解析出会话目录，再经 __cwd 传入。
  return path.resolve(String(args.__cwd || process.cwd()));
}

/**
 * 解析发起本次调用的 Session 的工作目录。
 * 插件代码运行在 Host 进程，不能用 process.cwd() 代表用户工作区。
 */
async function resolveCwd(ctx) {
  try {
    const agents = svc(ctx, 'agents');
    const wd = svc(ctx, 'workingDirectory');
    if (!agents || !wd) return '';
    const agent = typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined;
    if (!agent) return '';
    const dir = await wd.ensure(agent);
    return typeof dir === 'string' ? dir : '';
  } catch {
    return '';
  }
}

function emptyStage() {
  return {
    title: '', ppt: '', ptx: '', post_text: '', opening_statement: '', wb: [],
    desc: '', built_in_css: '', rgx_rep: [],
    ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
    ext: { ai_variable_enabled: false },
  };
}

/** 各部分拥有的字段；单部分导入件只保留自己那几项（卡名除外，用于平台识别）。 */
const OWNED_FIELDS = {
  writing: ['ppt', 'ptx', 'post_text', 'opening_statement', 'wb'],
  profile: ['desc'],
  chat: ['built_in_css', 'rgx_rep'],
  variables: ['ai_variable_tmpl', 'ai_v_prompt', 'ai_v_json'],
};

function onlyOwned(part, stage) {
  const out = emptyStage();
  out.title = stage.title || '';
  for (const k of OWNED_FIELDS[part] || []) out[k] = stage[k];
  if (part === 'variables') out.ext = { ai_variable_enabled: stage.ext && stage.ext.ai_variable_enabled === true };
  return out;
}

function normalizeStage(part, stage) {
  const base = emptyStage();
  const raw = stage && typeof stage === 'object' && !Array.isArray(stage) ? stage : {};
  const s = { ...base, ...raw };
  // 平台导出会换键名：按别名把任意已知格式归一到内部规范字段。
  for (const k of STRING_FIELDS) {
    const picked = pickField(raw, k);
    const value = picked !== undefined ? picked : s[k];
    s[k] = typeof value === 'string' ? value : value == null ? '' : String(value);
  }
  const wb = pickField(raw, 'wb');
  s.wb = Array.isArray(wb) ? wb : [];
  s.rgx_rep = normalizeRegexRules(raw.rgx_rep);
  const flag = pickPanelFlag(raw);
  s.ext = { ai_variable_enabled: typeof flag === 'boolean' ? flag : false };
  return s;
}

function ownCheck(part, s) {
  const d = [];
  const err = (message) => d.push({ id: 'OWN001', severity: 'error', message });
  if (part === 'writing') {
    if (!s.title.trim()) err('title（卡名）不能为空');
    for (const k of ['ppt', 'ptx', 'post_text', 'opening_statement']) {
      if (!s[k].trim()) err(`${k} 不能为空`);
    }
    if (!s.wb.length) err('世界书 wb 不能为空');
    s.wb.forEach((e, i) => {
      if (!String(e && e.value != null ? e.value : '').trim()) err(`世界书第 ${i + 1} 条 value 正文为空`);
    });
  } else if (part === 'profile') {
    if (!s.desc.trim()) err('desc（初始化 HTML）不能为空');
  } else if (part === 'chat') {
    if (!s.built_in_css.trim() && !s.rgx_rep.length) err('built_in_css 与 rgx_rep 至少一项非空');
  } else if (part === 'variables') {
    if (s.ext.ai_variable_enabled) {
      for (const k of ['ai_variable_tmpl', 'ai_v_prompt', 'ai_v_json']) {
        if (!s[k].trim()) err(`启用变量面板时 ${k} 不能为空`);
      }
    } else {
      for (const k of ['ai_variable_tmpl', 'ai_v_prompt', 'ai_v_json']) {
        if (s[k].trim()) err(`关闭变量面板时 ${k} 必须为空`);
      }
    }
  }
  return d;
}

function renderWorldbookSection(s) {
  if (!s.wb.length) return '（本部分未包含世界书条目）';
  return s.wb.map((e, i) => {
    const row = (k, v) => `| ${k} | ${v} |`;
    return [
      `### 条目 ${i + 1} · ${e.group || '未分组'}`,
      '',
      '**正文（value）**',
      '',
      String(e.value || ''),
      '',
      '**附注：触发配置**',
      '',
      '| 字段 | 值 |',
      '| --- | --- |',
      row('match_type', `${e.match_type}（1=AND / 2=OR / 3=REGEX）`),
      row('key', '`' + String(e.key || '') + '`'),
      row('key_region', String(e.key_region)),
      row('value_region', String(e.value_region)),
      row('depth', String(e.depth)),
      row('enable', String(e.enable)),
      '',
    ].join('\n');
  }).join('\n');
}

function renderSource(part, s) {
  if (part === 'writing') {
    return [
      `# ${s.title || '未命名 RP 卡'} · 第一部分：写卡正文`,
      '',
      `- 阶段 JSON：${STAGE_FILE.writing}`,
      '- 本文件与阶段 JSON 由同一次 deliver 生成，内容来自同一份阶段数据。',
      '',
      '## 一、主提示词（ppt）',
      '',
      s.ppt,
      '',
      '## 二、前缀词（ptx）',
      '',
      s.ptx,
      '',
      '## 三、后缀词（post_text）',
      '',
      s.post_text,
      '',
      '## 四、开场白（opening_statement）',
      '',
      s.opening_statement,
      '',
      '## 五、世界书（wb）',
      '',
      '> 正文只写世界知识；触发配置写在对应附注中，不进入正文。',
      '',
      renderWorldbookSection(s),
      '',
      '## 六、导入位置',
      '',
      '| 内容 | 平台字段 |',
      '| --- | --- |',
      '| 卡名 | `title` |',
      '| 主提示词 | `ppt` |',
      '| 前缀词 | `ptx` |',
      '| 后缀词 | `post_text` |',
      '| 开场白 | `opening_statement` |',
      '| 世界书 | `wb` |',
      '',
    ].join('\n');
  }
  if (part === 'profile') return s.desc;
  if (part === 'chat') {
    const head = s.built_in_css || '/* 本部分未提供 built_in_css */';
    return s.rgx_rep.length ? `${head}\n\n/* 正则规则见阶段 JSON 的 rgx_rep（共 ${s.rgx_rep.length} 条） */\n` : head;
  }
  if (s.ext.ai_variable_enabled) return s.ai_variable_tmpl;
  return `# 变量面板：本卡明确关闭\n\n- ext.ai_variable_enabled: false\n- 未提供模板、变量 Prompt 与 Schema。\n`;
}

function renderWorkOrder(state) {
  return [
    `# ${state.title || '未命名 RP 卡'} · 创作工作单`,
    '',
    `- 类型：${state.type || 'auto'}`,
    `- 平台：${state.platform || 'unknown'}`,
    '- 本文件只是工作单，不是交付物，不参与平台验证。',
    '',
    '## 主题与构思',
    '',
    state.brief || '（未提供，请在开始前补充）',
    '',
    '## 四部分顺序（每部分交付后必须停止，等待用户明确 PASS）',
    '',
    '1. 写卡正文 —— ' + SPEC.writing,
    '2. 初始化档案页 —— ' + SPEC.profile,
    '3. 聊天页 CSS 与正则 —— ' + SPEC.chat,
    '4. 变量面板 —— ' + SPEC.variables,
    '',
    '## 交付方式',
    '',
    '1. 先执行 `template --part <部分>` 取得空阶段骨架，或自行按统一骨架编写阶段 JSON。',
    '2. 把本部分实际内容填入其负责字段，其他部分字段保持合法空占位。',
    '3. 执行 `deliver --part <部分> --file <阶段 JSON 路径>`。',
    '4. 交付成功后本部分进入 awaiting_user_validation 并停止；只有用户明确回复“第 N 部分 PASS”才可 `pass`。',
    '',
  ].join('\n');
}

/** 需求预处理模板：开工前必须填完，后续四部分都以它为准。 */
function renderRequirementAnalysis(state) {
  return [
    '# 需求预处理（开工前填完；写每一部分前先读本文件）',
    '',
    '## 1. 主题与核心玩法',
    '（一到两句，写清玩家是谁、在什么世界、做什么）',
    '',
    '## 2. 卡片类型',
    `- 判定：${state.type && state.type !== 'auto' ? state.type : '（六类之一）'}`,
    '- 依据：（一句，说明为什么归这一类）',
    '',
    '## 3. 需求 → 四部分归属',
    '',
    '| 用户需求原文 | 归属部分 | 本次是否要做 | 备注 |',
    '| --- | --- | --- | --- |',
    '|  | writing / profile / chat / variables | 是/否 |  |',
    '',
    '归类规则：凡涉及抽取、随机、校验、防矛盾、前端交互、按钮、面板，一律归 profile 或 variables，不得写入 writing。',
    '',
    '## 4. 跨部分依赖',
    '- （例：方案 A 的抽取池要被方案 B 的面板复用，写明来源与读取方式）',
    '',
    '## 5. 框架补齐（用户未提但必须有）',
    '- 时间地点：固定首段【时间地点】+「时间：」「地点：」，正文从其后开始',
    '- 角色信息：固定段落，逐字填入、此后逐字复制',
    '- 记忆区：短期 5 条 / 长期 5 条 / 总 1000 字符，规则照搬',
    '- 行动建议：3 条具体 + 第 4 条固定「自定义：」',
    '',
    '## 6. 关键假设',
    '- （用户没明说、由你按合理默认补的项，逐条列出）',
    '',
    '## 7. 歧义与提问',
    '- 是否存在改变卡片类型的关键歧义：否',
    '- 若为「是」，只问一个问题，且不要附带参数清单。',
    '',
    '## 8. 前端骨架与实现架构（写 profile 前定死）',
    '- 主骨架（九选一为主，可写串联）：单页长滚动 / 线性向导 / 标签页与折叠 / 卡片选择器 / 档案与卷宗 / 终端与控制台 / 地图与场景驱动 / 路线树与身份分流 / 对话式问卷',
    '- 骨架与玩法为何匹配：（一句）',
    '- 是否多路线/多身份：（是 → 每条路线一套字段集、一套状态、一份输出模板；否）',
    '- 填写字段总数：（超过 12 个或有多条路线 → 表单必须 schema 数组驱动，禁止逐页手写）',
    '- 三态输入：（示例=必做；随机=需要就写；随机按哪个粒度分区块）',
    '- 随机依赖链：（例：性别 → 外貌候选库 → 称谓；规模 → 资金区间）',
    '- 高级选项逐项结论（用/不用＋判据）：隐藏第二界面 / 多主题皮肤 / 动态增删条目 / 响应式双形态 / 彩蛋分支 / 演出式彩蛋',
    '- 动效档位：必做 15 条（页内 02/03/07/09/10/11/12/13/15/16/17/19/20/21/30）是否都落实；按题材挑了哪几条；高级项（56–65、67）逐项写用/不用＋判据',
    '- 动效红线自检：只动 transform 与 opacity、同屏循环 ≤3、滚动用 rAF、reduced-motion 关循环、装饰层 pointer-events:none',
    '- 动态几何：是否含（图像叠加点位 / 循环轮播 / 受约束滑块 / 拖拽手势）；逐项写坐标基准、复位相位、约束回写、手势阈值怎么实现（见 档案页 §2.11）',
    '',
  ].join('\n');
}

function begin(args) {
  const out = outDir(args);
  const state = ensureState(out, {
    brief: typeof args.brief === 'string' ? args.brief : (typeof args.request === 'string' ? args.request : ''),
    type: typeof args.type === 'string' ? args.type : 'auto',
    platform: typeof args.platform === 'string' ? args.platform : DEFAULT_PLATFORM,
  }, Boolean(args.resume));
  if (typeof args.title === 'string' && args.title) state.title = args.title;
  if (typeof args.brief === 'string' && args.brief) state.brief = args.brief;
  else if (typeof args.request === 'string' && args.request) state.brief = args.request;
  if (typeof args.type === 'string') state.type = args.type;
  if (typeof args.platform === 'string') state.platform = args.platform;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '00-work-order.md'), renderWorkOrder(state), 'utf8');
  fs.writeFileSync(path.join(out, '00-requirement-analysis.md'), renderRequirementAnalysis(state), 'utf8');
  state.parts.writing.status = 'generating';
  state.parts.writing.files = [];
  state.parts.writing.digest = null;
  state.currentPart = 'writing';

  // 启动方式：clear＝需求明确直接做；brainstorm＝需求模糊先出方案
  if (!state.design) state.design = { phase: 'idle', parts: {} };
  const mode = String(args.design || '').toLowerCase();
  const brainstorm = mode === 'brainstorm';
  if (brainstorm) {
    state.design.phase = 'brainstorming';
    state.design.parts.writing = { status: 'pending', file: null, proposedAt: null, note: '启动判定为模糊需求，待方案审批' };
  } else if (mode === 'clear') {
    state.design.parts.writing = { status: 'approved', file: null, approvedAt: new Date().toISOString(), note: '启动判定为明确需求' };
    state.design.phase = 'approved';
  }
  state.updatedAt = new Date().toISOString();
  writeState(out, state);

  const lines = [
    `已建立作品：${state.title || '（卡名待定，写第一部分时确定）'}`,
    `目录：${out}`,
    `类型：${state.type}（auto 表示由你按主题自行判定）`,
    `平台：${state.platform}`,
  ];
  if (brainstorm) {
    lines.push(
      '当前阶段：头脑风暴。需求偏模糊，先不要写正式产物。',
      '下一步：按「头脑风暴」规则，用通俗语言复述你的理解、列出真正影响结构的关键选择，给 2–3 个方向让用户选。',
      '方案定稿后调用 `propose --part writing --file <方案 md>`，等用户确认后 `approve-design --part writing`，再开始第一部分。',
    );
  } else {
    lines.push(
      '当前阶段：第一部分尚未交付，不处于待验证状态。',
      '下一步：第一步先给用户看第一部分的设计方案（`propose --part writing --file <方案 md>`），用户确认后 `approve-design --part writing`，再生成阶段 JSON 并 deliver。',
    );
  }
  return lines.join('\n');
}

function template(args) {
  const out = outDir(args);
  const part = String(args.part || 'writing');
  if (!PARTS.includes(part)) throw new Error('part 必须是 writing/profile/chat/variables');
  const file = path.join(out, '.card-build', `template-${STAGE_FILE[part]}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const skeleton = emptyStage();
  if (part === 'writing') skeleton.title = '';
  fs.writeFileSync(file, JSON.stringify(skeleton, null, 2), 'utf8');
  const extra = [];
  if (part === 'writing') {
    // 世界书标签旁车：每条 wb 对应一条，生成时随手填，交付时用于机械校验。
    const planFile = path.join(out, '.card-build', 'template-wb-plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      version: 1,
      note: '每条 wb 对应一条；index 从 1 开始。职责=知识/规则/路由/控制词；激活=知识关键词/枚举锚/控制锚；载体=wb/ppt/ptx/post。常驻（枚举锚/控制锚）必须填 anchorSource，格式 post:【命运】模式 / enum:模式。',
      entries: [
        { index: 1, group: '', 职责: '知识', 激活: '知识关键词', 载体: 'wb', anchorSource: '', budget: 0, note: '' },
      ],
    }, null, 2), 'utf8');
    extra.push(`世界书标签骨架：${planFile}（填好后另存为 .card-build/wb-plan.json）`);
  }
  if (part === 'profile') {
    const st = keyStatus();
    if (st.needSetup) {
      extra.push('⚠ 图像能力未配置：第二部分通常需要图像资源。请先调用 `image_asset`（action=setup），让用户在设置卡里填写 Seedream / Recraft 密钥；或由用户选择「不接入图像模型」（改用纯代码前端）。设置完成前不要开始写 profile。');
    } else if (st.pureCode) {
      extra.push('图像能力：用户已选择「不接入图像模型」，第二部分使用纯代码前端，不生成任何图像资产。');
    } else {
      extra.push(`图像能力：密钥已就绪（Seedream ${st.seedream ? '✓' : '缺'}，Recraft ${st.recraft ? '✓' : '缺'}）。`);
    }
  }
  return [
    `已写入 ${part} 阶段骨架：${file}`,
    ...extra,
    '填写本部分负责字段后执行：deliver --part ' + part + ' --file "' + file + '"',
  ].join('\n');
}

function deliver(args) {
  const out = outDir(args);
  const state = readState(out);
  if (!state) throw new Error('请先执行 start');
  const part = String(args.part || state.currentPart || 'writing');
  if (!PARTS.includes(part)) throw new Error('part 必须是 writing/profile/chat/variables');
  const idx = PARTS.indexOf(part);
  const missing = PARTS.slice(0, idx).filter((p) => state.parts[p].status !== 'pass');
  if (missing.length) throw new Error(`前置部分必须先取得真实 PASS：${missing.map((p) => PART_NAMES[p]).join('、')}`);
  const design = state.design && state.design.parts && state.design.parts[part];
  if (design && design.status === 'pending') {
    throw new Error(`${PART_NAMES[part]}的设计方案还没审批：先把方案讲给用户确认，再执行 approve-design --part ${part}；需要改方案就重新 propose。`);
  }

  let raw = '';
  if (typeof args.file === 'string') raw = fs.readFileSync(path.resolve(args.file), 'utf8');
  else if (typeof args.content === 'string') raw = args.content;
  if (!raw.trim()) throw new Error('deliver 需要阶段 JSON：--file <路径>（推荐）或 --content <json>');

  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`阶段 JSON 解析失败：${e.message}`); }

  const stage = normalizeStage(part, parsed);
  const wbPlan = part === 'writing' ? loadWbPlan(out) : null;
  const diagnostics = [...lintStageJson(part, stage, { plan: wbPlan }), ...ownCheck(part, stage)];
  const errors = diagnostics.filter((d) => d.severity === 'error');

  fs.mkdirSync(out, { recursive: true });

  state.issues = diagnostics;
  state.updatedAt = new Date().toISOString();

  // 先校验再落盘：未通过检查的内容不得覆盖已交付/已 PASS 的产物。
  if (errors.length) {
    const rejected = path.join(out, '.card-build', `rejected-${STAGE_FILE[part]}`);
    fs.writeFileSync(rejected, JSON.stringify(stage, null, 2), 'utf8');
    state.parts[part].status = 'needs_revision';
    state.parts[part].validation = null;
    writeState(out, state);
    return {
      ok: false,
      part,
      files: [],
      rejectedFile: path.relative(out, rejected),
      diagnostics,
      message: `${PART_NAMES[part]}未通过交付检查，未进入待验证状态，也未覆盖已有产物。修正后重新 deliver。`,
    };
  }

  fs.writeFileSync(path.join(out, STAGE_FILE[part]), JSON.stringify(stage, null, 2), 'utf8');
  fs.writeFileSync(path.join(out, SOURCE_FILE[part]), renderSource(part, stage), 'utf8');
  const files = [SOURCE_FILE[part], STAGE_FILE[part]];

  // 第一部分确定卡名后回写状态，避免调用方为了改 title 去手改 state.json。
  if (part === 'writing' && stage.title.trim()) state.title = stage.title.trim();

  state.parts[part].status = 'generating';
  writeState(out, state);
  markAwaiting(out, state, part, files);

  // 交付即产出两份：只含本部分的导入件（单独测这一部分）+ 累计组装件（恢复全卡）。
  let partExport = null;
  let merged = null;
  try { partExport = exportPart({ part, format: 'v2', out }); } catch (e) { partExport = { error: e.message }; }
  try { merged = mergeParts(out, { by: 'deliver' }); } catch (e) { merged = { error: e.message }; }

  const lines = [`${PART_NAMES[part]}已交付并停止，等待人工平台验证。只有用户明确回复该部分 PASS 才可进入下一步。`];
  if (part === 'profile') {
    const st = keyStatus();
    if (st.needSetup) {
      lines.push('注意：仍未配置图像密钥，也未选择「不接入图像模型」。若本次页面没有图像资源，交付说明里必须写明原因；若需要图像，请先完成设置卡。');
    } else if (st.pureCode) {
      lines.push('图像能力：用户已选择不接入图像模型，本次前端为纯代码实现（无图像资产）。');
    }
  }
  if (partExport && partExport.file) {
    lines.push(`可导入件（仅本部分）：${partExport.file} —— 只验证本部分效果时导入它；其它字段是空占位，会覆盖平台上的同名卡。`);
  } else if (partExport && partExport.error) {
    lines.push(`可导入件生成失败：${partExport.error}`);
  }
  if (merged && merged.file) {
    const has = merged.parts.map((p) => PART_NAMES[p]).join('、');
    const lack = merged.missing.length ? `；缺 ${merged.missing.map((p) => PART_NAMES[p]).join('、')}` : '；四部分齐';
    lines.push(`累计组装件：${merged.file}（含 ${has}${lack}）—— 恢复整张卡时导入它；每次交付都会覆盖更新成最新累计版本。`);
    if (merged.supersededFinal) {
      lines.push('注意：之前的 assemble 最终件已被这次累计件取代（card.json 内容变了）；要以此版本收尾，请重新 assemble。');
    }
  } else if (merged && merged.error) {
    lines.push(`累计组装失败：${merged.error}`);
  }

  // 图像资源：供应商 URL 只是临时产物，必须换成平台长期 URL 才算完成。
  if (part === 'profile') {
    const pending = pendingAssetUploads(out);
    if (pending.length) {
      lines.push(`图像资源待回填：${pending.length} 项仍在使用供应商临时 URL（${pending.slice(0, 6).join('、')}${pending.length > 6 ? ' 等' : ''}）。`);
      lines.push('请先在本卡详情页上传这些图片，拿到平台长期 URL 后交回 agent 调 `image_asset set_url` 回填，再 `embed` 重新生成 HTML；否则导入平台后图片会失效。');
    }
  }

  // 收尾格式：先问下一部分是否有补充，最后一行固定为 PASS 提示。
  lines.push('');
  const NEXT_PART_NAMES = { writing: '第二部分（初始化档案页）', profile: '第三部分（聊天页 CSS 与正则）', chat: '', variables: '' };
  if (part === 'writing' || part === 'profile') {
    lines.push(`对${NEXT_PART_NAMES[part]}的玩法、视觉或字段有想法，现在直接说；没有就按常规继续。`);
  } else if (part === 'chat') {
    lines.push('第三部分是最后一个必做部分，交付后即可玩；第四部分（变量面板）属可选拓展，要不要做等 PASS 之后再定，那时再聊面板想法。');
  } else {
    lines.push('对面板或整卡还有想改的地方，直接说；没有就走组装。');
  }
  lines.push(`确认后回复「第 ${PART_INDEX[part]} 部分 PASS」${part === 'chat' ? '；PASS 后再告诉我要走哪条路（组装 / 评估 / 变量面板）' : ''}`);

  return { ok: true, part, files, diagnostics, partExport, merged, message: lines.join('\n') };
}

function statusText(out) {
  const state = readState(out);
  if (!state) return `未找到作品状态：${out}`;
  detectChanged(out);
  const fresh = readState(out);
  const playableReady = PLAYABLE_PARTS.every((p) => fresh.parts[p].status === 'pass');
  const allPassed = PARTS.every((p) => fresh.parts[p].status === 'pass');
  const pending = PLAYABLE_PARTS.filter((p) => fresh.parts[p].status !== 'pass');
  let next;
  if (!playableReady) next = `${pending[0]}:${fresh.parts[pending[0]].status}`;
  else if (!allPassed) next = 'branch: assemble | evaluate | variables';
  else next = 'assemble';
  return JSON.stringify({
    out,
    title: fresh.title,
    playableReady,
    allPassed,
    currentPart: fresh.currentPart,
    paused: fresh.paused,
    next,
    options: playableReady && !allPassed
      ? ['assemble：组装可玩版本（不含变量面板）', 'evaluate：先组装再按评估框架打分', 'variables：进入拓展功能，做第四部分变量面板']
      : undefined,
    merged: fresh.merged || null,
    parts: fresh.parts,
    issues: fresh.issues,
    final: fresh.final,
    finalSuperseded: Boolean(fresh.final && fresh.final.supersededAt),
    imageSetup: keyStatus(),
    design: fresh.design || { phase: 'idle', parts: {} },
  }, null, 2);
}

/**
 * 记录 PASS，并按所处节点给出下一步。
 * 前三部分（writing/profile/chat）完成后即为可玩版本，此时分三条路：
 * 完整组装 / 全面评估 / 进入拓展功能（第四部分变量面板）。
 */
function passText(out, part, feedback) {
  const state = passPart(out, part, feedback);
  const lines = [`已记录 PASS：${PART_NAMES[part]}（绑定当前文件摘要；之后改动该部分文件，这次 PASS 会失效）`];
  if (part === 'chat') {
    lines.push(
      '',
      '前三部分已通过，这就是一个可玩版本。请先在平台实际玩几轮：正文包裹、气泡不透明度、正则转换、按钮状态是否都正常。',
      '确认后可三选一：',
      '1. 完整组装 —— 生成 card.json（可玩版本，不含变量面板），到此可以收工；',
      '2. RP 卡全面评估 —— 先组装，再按评估框架打分；',
      '3. 进入拓展功能（第四部分 变量面板）—— 继续做可选的面板。',
      '',
      '提醒：变量面板的浮动入口与按钮外观属于第三部分 built_in_css。想做面板时，这类样式要在第三部分 CSS 里改，改完第三部分需要重新验证；不要把它们写进面板模板。',
    );
  } else if (part === 'profile') {
    lines.push('下一步：第三部分 聊天页 CSS 与正则。');
  } else if (part === 'variables') {
    lines.push('四部分已完成，可以 assemble 生成完整版（含变量面板）。');
  } else {
    lines.push('下一步：第二部分 初始化档案页。');
  }
  return lines.join('\n');
}

/** 记录某一阶段的设计方案（方案正文写入 00-design-<part>.md），状态转为待审批。 */
function proposeDesign(args) {
  const out = outDir(args);
  const state = readState(out);
  if (!state) throw new Error('请先执行 start');
  const part = String(args.part || 'writing');
  if (!PARTS.includes(part)) throw new Error('part 必须是 writing/profile/chat/variables');
  let body = typeof args.content === 'string' ? args.content : '';
  if (!body && typeof args.file === 'string') {
    const p = path.resolve(args.file);
    if (!fs.existsSync(p)) throw new Error(`方案文件不存在：${p}`);
    body = fs.readFileSync(p, 'utf8');
  }
  if (!String(body).trim()) throw new Error('propose 需要方案内容：--file <md> 或 --content "<md>"');
  const file = `00-design-${part}.md`;
  fs.writeFileSync(path.join(out, file), String(body), 'utf8');
  if (!state.design) state.design = { phase: 'idle', parts: {} };
  state.design.parts[part] = {
    status: 'pending',
    file,
    proposedAt: new Date().toISOString(),
    note: typeof args.note === 'string' ? args.note : '',
  };
  state.design.phase = part === 'writing' ? 'awaiting_approval' : state.design.phase;
  state.updatedAt = new Date().toISOString();
  writeState(out, state);
  return [
    `已记录${PART_NAMES[part]}的设计方案：${file}`,
    '请把方案要点讲给用户听，等用户明确确认（例如「按这个做」）后再执行：',
    `approve-design --part ${part}`,
    '用户要改就直接改方案并重新 propose；方案未批准前不能 deliver 这一部分。',
  ].join('\n');
}

/** 用户确认方案后调用：解除该阶段的交付门禁。 */
function approveDesign(args) {
  const out = outDir(args);
  const state = readState(out);
  if (!state) throw new Error('请先执行 start');
  const part = String(args.part || 'writing');
  if (!PARTS.includes(part)) throw new Error('part 必须是 writing/profile/chat/variables');
  if (!state.design) state.design = { phase: 'idle', parts: {} };
  const prev = state.design.parts[part] || {};
  state.design.parts[part] = {
    ...prev,
    status: 'approved',
    approvedAt: new Date().toISOString(),
    note: typeof args.note === 'string' ? args.note : prev.note || '用户确认方案',
  };
  if (part === 'writing') state.design.phase = 'approved';
  state.updatedAt = new Date().toISOString();
  writeState(out, state);
  return `已确认${PART_NAMES[part]}的设计方案，可以开始实现并 deliver。`;
}

function action(args) {  const out = outDir(args);
  switch (args.action || 'start') {
    case 'start': return begin(args);
    case 'propose': return proposeDesign(args);
    case 'approve-design': return approveDesign(args);
    case 'template': return template(args);
    case 'status': return statusText(out);
    case 'deliver': return JSON.stringify(deliver(args), null, 2);
    case 'pass': return passText(out, String(args.part || readState(out)?.currentPart), typeof args.feedback === 'string' ? args.feedback : '');
    case 'fail': return JSON.stringify(failPart(out, String(args.part || readState(out)?.currentPart), typeof args.feedback === 'string' ? args.feedback : '未提供反馈'), null, 2);
    case 'pause': {
      const state = readState(out);
      if (!state) throw new Error('未找到作品状态');
      state.paused = true;
      state.updatedAt = new Date().toISOString();
      writeState(out, state);
      return '已暂停：状态与待验证产物保留。';
    }
    case 'resume': {
      const state = ensureState(out, { brief: '', type: 'auto', platform: DEFAULT_PLATFORM }, true);
      state.paused = false;
      state.updatedAt = new Date().toISOString();
      writeState(out, state);
      return statusText(out);
    }
    case 'assemble': {
      const res = assemble(out, { format: args.format });
      const head = res.playable
        ? '已组装「可玩版本」：前三部分（写卡正文 + 档案页 + 聊天页），不含变量面板。'
        : '已组装「完整版」：四部分全部并入，含变量面板。';
      return [
        head,
        '- 卡片：card.json',
        '- 报告：build-report.md',
        res.playable
          ? '- 之后要做拓展功能，就交付第四部分，再执行一次 assemble。'
          : '- 变量面板的浮动入口与按钮外观属于第三部分 built_in_css；要改就回第三部分改 CSS 并重新验证，不要写进面板模板。',
        '- 背景图插件不产出：请在平台导入后再设置电脑端与手机端背景图。',
      ].join('\n');
    }
    case 'export': return JSON.stringify(exportPart(args), null, 2);
    case 'merge': return JSON.stringify(mergeParts(out, { format: args.format }), null, 2);
    default: throw new Error(`未知 action：${args.action}`);
  }
}

/**
 * 导出单个部分为平台格式文件，供该部分的人工平台验证使用。
 * 只有已交付（待验证或已 PASS）的部分才允许导出，避免拿草稿去导入。
 */
function exportPart(args) {
  const out = outDir(args);
  const state = readState(out);
  if (!state) throw new Error('请先执行 start');
  const part = String(args.part || state.currentPart || 'writing');
  if (!PARTS.includes(part)) throw new Error('part 必须是 writing/profile/chat/variables');
  const format = String(args.format || 'v2');
  if (!PLATFORM_FORMATS[format]) throw new Error(`未知平台格式：${format}（可选 ${Object.keys(PLATFORM_FORMATS).join(' / ')}）`);

  const p = state.parts[part];
  if (!['awaiting_user_validation', 'pass'].includes(p.status)) {
    throw new Error(`该部分尚未交付，不能导出：${PART_NAMES[part]} 当前状态为 ${p.status}（需先 deliver）`);
  }

  const stagePath = (p.files || []).map((f) => f.path).find((x) => x.endsWith(STAGE_FILE[part])) || STAGE_FILE[part];
  const stage = JSON.parse(fs.readFileSync(path.join(out, stagePath), 'utf8'));
  const canonical = normalizeStage(part, stage);
  // 单部分导入件只带本部分字段：其它部分留空占位，避免把别部分的旧值一起覆盖到平台。
  const platform = toPlatform(onlyOwned(part, canonical), format);

  const fileName = `${STAGE_FILE[part].replace(/\.json$/, '')}.${format}.json`;
  fs.writeFileSync(path.join(out, fileName), JSON.stringify(platform, null, 2), 'utf8');

  return {
    part,
    format,
    file: fileName,
    bytes: fs.statSync(path.join(out, fileName)).size,
    note: '只有本部分字段有内容，其他部分是合法空占位；导入平台会覆盖同名卡，请用测试副本或只录入本部分字段。',
  };
}

const TOOL_ACTIONS = ['start', 'propose', 'approve-design', 'status', 'template', 'deliver', 'export', 'merge', 'pass', 'fail', 'pause', 'resume', 'assemble'];

/**
 * 取服务并注册。服务已就绪时直接注册；尚未就绪时退回 ctx.inject。
 * 注册异常一律向上抛出，让宿主报告“entry did not activate”，避免静默失败。
 */
function bindService(ctx, name, register) {
  const fail = (e) => {
    throw new Error(`[rp-card-plugin] 注册 ${name} 失败：${e && e.message ? e.message : e}`);
  };

  let service;
  try {
    service = svc(ctx, name);
  } catch (e) {
    fail(e);
  }

  if (service) {
    try {
      register(ctx, service);
    } catch (e) {
      fail(e);
    }
    return;
  }

  try {
    ctx.inject([name], (inner) => {
      const injected = svc(inner, name);
      if (!injected) return;
      try {
        register(inner, injected);
      } catch (e) {
        throw new Error(`[rp-card-plugin] 注册 ${name} 失败：${e && e.message ? e.message : e}`);
      }
    });
  } catch (e) {
    fail(e);
  }
}

/**
 * 同步版：命令处理器必须同步返回结果，因此只用 workingDirectory.get(session)。
 */
function resolveCwdSync(ctx) {
  try {
    const agents = svc(ctx, 'agents');
    const agent = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined;
    if (!agent) return '';
    if (typeof agent.cwd === 'string' && agent.cwd) return agent.cwd;
    const wd = svc(ctx, 'workingDirectory');
    const session = agent.session;
    if (wd && session && typeof wd.get === 'function') {
      const dir = wd.get(session);
      return typeof dir === 'string' ? dir : '';
    }
  } catch {
    // 忽略：回退到 process.cwd()
  }
  return '';
}

export function apply(ctx) {
  const pluginCtx = ctx;


  bindService(ctx, 'commands', (c, commands) => {
    c.effect(() => commands.register({
      name: 'card-build',
      description: '创建、恢复、验证并组装四阶段 RP 卡（语义名 card.build）',
      input: { hint: 'start [--design clear|brainstorm]|propose|approve-design|status|template|deliver|export|merge|pass|fail|pause|resume|assemble [--out <dir>]' },
      handler: ({ rawInput }) => {
        try {
          const args = parseArgs(rawInput);
          const cwd = resolveCwdSync(pluginCtx);
          if (cwd && !args.out) args.__cwd = cwd;
          return { kind: 'success', text: action(args) };
        } catch (e) {
          return { kind: 'error', text: e && e.message ? e.message : String(e) };
        }
      },
    }));
  });

  bindService(ctx, 'tools', (c, tools) => {
    c.effect(() => tools.register({
      name: 'card_build',
      description: '当用户用自然语言提出任何 RP 卡创作需求时，立即用本工具开始按其四阶段流程执行：start（out 省略＝当前工作区，request 放用户原话）→ 每部分写阶段 JSON 并 deliver → 停下等用户明确 PASS → 四部分全 PASS 后 assemble。PASS 只能由用户明确确认后调用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: TOOL_ACTIONS, description: '要执行的操作' },
          out: { type: 'string', description: '作品目录；省略＝当前会话工作区（用户已选好的目录）' },
          request: { type: 'string', description: '用户原话需求（start 时使用，原样记录，不要改写）' },
          brief: { type: 'string', description: '同 request，二选一' },
          title: { type: 'string', description: '卡名；省略则由你在第一部分按主题命名' },
          type: { type: 'string', enum: CARD_TYPES, description: '卡片类型；省略或 auto 表示由你按主题判定' },
          platform: { type: 'string', description: `目标平台；默认 ${DEFAULT_PLATFORM}` },
          part: { type: 'string', enum: PARTS, description: '部分标识' },
          file: { type: 'string', description: '阶段 JSON 文件路径（deliver 推荐）' },
          content: { type: 'string', description: '阶段 JSON 文本（deliver 备选）' },
          format: { type: 'string', enum: Object.keys(PLATFORM_FORMATS), description: '导出格式；assemble 时使用，默认 v2' },
          feedback: { type: 'string', description: 'FAIL 时记录的平台反馈' },
        },
        required: ['action'],
      },
      // 宿主强制要求 output { schema, render }，且返回值必须符合 schema。
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            output: { type: 'string' },
          },
          required: ['ok', 'action', 'output'],
        },
        render: (_args, value) => [
          { type: 'text', text: value && typeof value.output === 'string' ? value.output : JSON.stringify(value, null, 2) },
        ],
      },
      execute: async (args) => {
        const act = args && args.action ? String(args.action) : 'unknown';
        try {
          const sessionCwd = await resolveCwd(pluginCtx);
          const result = action({ ...(args || {}), __cwd: sessionCwd || undefined });
          return {
            ok: true,
            action: act,
            output: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          };
        } catch (e) {
          return {
            ok: false,
            action: act,
            output: `错误：${e && e.message ? e.message : String(e)}`,
          };
        }
      },
    }));
  });

  bindService(ctx, 'tools', (c, tools) => {
    c.effect(() => tools.register({
      name: 'image_asset',
      description: 'RP 卡前端图像资源：先 setup 配置图像能力（缺密钥时会被强制要求），再 plan 决策（位图走 Seedream，透明人物立绘与 SVG 走 Recraft），然后 record_search / approve_search / generate / fetch_svg / validate_svg / embed / set_url。生成后必须提醒用户上传平台换长期 URL 再回填；SVG 直接内嵌 HTML。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['setup', 'plan', 'record_search', 'approve_search', 'generate', 'fetch_svg', 'validate_svg', 'normalize', 'embed', 'list', 'set_status', 'set_url'] },
          mode: { type: 'string', enum: ['keys', 'none'], description: 'setup 时使用：keys＝接入图像模型（需至少一个密钥）；none＝不接入，第二部分改用纯代码前端，此后不再弹出设置卡' },
          seedream_key: { type: 'string', description: 'setup 时使用：Seedream（火山方舟）API Key，留空表示不修改' },
          recraft_key: { type: 'string', description: 'setup 时使用：Recraft API Key，留空表示不修改' },
          out: { type: 'string', description: '作品目录；省略＝当前会话工作区' },
          path: { type: 'string', description: 'normalize 时使用：要按真实格式改名或校正的图片路径' },
          asset_type: { type: 'string', enum: ['character_image', 'background_image', 'icon_svg', 'decoration_svg'] },
          transparent: { type: 'boolean', description: '是否需要透明背景。仅 character_image 可用：true 时走 fetch_svg（Recraft 矢量），false/省略时走 generate（Seedream 位图）' },
          purpose: { type: 'string', description: '资源在页面中的用途' },
          prompt: { type: 'string', description: '图像提示词（由 image-prompt-designer 产出）' },
          size: { type: 'string', description: '尺寸，默认 1024x1024' },
          asset_id: { type: 'string', description: '资源 id；省略则自动编号' },
          search_results: { type: 'array', description: 'record_search 的候选：[{url,title,note}]' },
          url: { type: 'string', description: 'approve_search / set_url 使用的 http(s) 地址' },
          state: { type: 'string', description: 'set_status 的目标状态' },
          class_name: { type: 'string', description: 'embed 时图片的 class' },
          alt: { type: 'string', description: 'embed 时图片的 alt' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, action: { type: 'string' }, output: { type: 'string' } },
          required: ['ok', 'action', 'output'],
        },
        render: (_args, value) => [
          { type: 'text', text: value && typeof value.output === 'string' ? value.output : JSON.stringify(value, null, 2) },
        ],
      },
      execute: async (args) => {
        const act = args && args.action ? String(args.action) : 'unknown';
        try {
          const sessionCwd = await resolveCwd(pluginCtx);
          const out = outDir({ ...(args || {}), __cwd: sessionCwd || undefined });
          const result = await runAssetAction(args || {}, out);
          return { ok: true, action: act, output: JSON.stringify(result, null, 2) };
        } catch (e) {
          return { ok: false, action: act, output: `错误：${e && e.message ? e.message : String(e)}` };
        }
      },
    }));
  });

  bindService(ctx, 'tools', (c, tools) => {
    c.effect(() => tools.register({
      name: 'card_evaluate',
      description: '四部分全部 PASS 且 assemble 之后，按角色卡评估框架打分：audit 只算硬指标（token、前后置词放大倍数、世界书分布、渲染层、自触发碰撞、HTML 环境违规）；submit 接收档位与原文引用，机械折算总分、等级并写报告。仅在用户同意后使用，不改动作品。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['audit', 'submit'], description: 'audit＝硬指标审计；submit＝提交档位并生成报告' },
          out: { type: 'string', description: '作品目录；省略＝当前会话工作区' },
          gates: { type: 'object', description: '准入闸门结论 {"G1":true,"G2":true,"G3":true}；任一 false 会拒绝评分' },
          anchors: { type: 'object', description: '各维度档位，只能取 0/1/3/5，如 {"F1":5,"F2":3}；判 N/A 的维度不要填' },
          evidence: { type: 'object', description: '每个已评维度一句原文引用；N/A 维度填理由＋引用（缺失会拒绝评分）' },
          na: { type: 'array', items: { type: 'string' }, description: '判 N/A 的维度，仅限 S2/S5/S6/S7/S8/M5/X1/X2/X3' },
          preset: { type: 'string', enum: ['balanced', 'plot', 'character', 'gameplay', 'ai_summary'], description: '权重预设，默认 balanced' },
          memory_rounds: { type: 'number', description: '实际加载轮数，用于算前后置词放大倍数' },
          memory_setting: { type: 'number', description: '平台记忆长度设置值；未给轮数时按 ceil(设置/2) 折算' },
          ai_summary: { type: 'boolean', description: '是否开启 AI 总结（开启时历史固定 1 轮）' },
          title: { type: 'string', description: '报告中的作品名；省略取 card.json 的 name' },
          strengths: { type: 'string', description: '做得好的三点（附原文引用）' },
          weaknesses: { type: 'string', description: '拖后腿的三点（附引用与命中维度）' },
          advice: { type: 'string', description: '三条最高杠杆改进建议（按改动量÷收益排序）' },
          keep: { type: 'string', description: '不要改的地方（已做对、改动有风险）' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, action: { type: 'string' }, output: { type: 'string' } },
          required: ['ok', 'action', 'output'],
        },
        render: (_args, value) => [
          { type: 'text', text: value && typeof value.output === 'string' ? value.output : JSON.stringify(value, null, 2) },
        ],
      },
      execute: async (args) => {
        const act = args && args.action ? String(args.action) : 'audit';
        try {
          const sessionCwd = await resolveCwd(pluginCtx);
          const out = outDir({ ...(args || {}), __cwd: sessionCwd || undefined });
          const result = evaluateAction(args || {}, out);
          return { ok: true, action: act, output: JSON.stringify(result, null, 2) };
        } catch (e) {
          return { ok: false, action: act, output: `错误：${e && e.message ? e.message : String(e)}` };
        }
      },
    }));
  });

  bindService(ctx, 'systemPrompt', (c, prompts) => {
    c.effect(() => prompts.section({
      name: 'rp-card-workflow',
      order: 900,
      text: [
        '# RP 卡创作（本工作区已启用）',
        '',
        '你是 RP 卡架构设计师。用户在本工作区用自然语言说出任何做卡想法时，**直接开始执行**，不要反问主题、类型或平台，也不要让用户记命令或填参数。',
        '',
        '## 内容尺度：先判断用户要不要',
        '你在这里做的是设计和编写卡片文本（主提示词、世界书、开场白、档案页、聊天页、变量面板），不是扮演角色、也不是演绎剧情。下面约束的是你写卡的行为。',
        '- 用户明确要求成人向／亲密内容时，按原样落实到卡里：不弱化、不替换成无害设定、不擅自加「点到为止」之类限制；也不要在卡片字段里写「亲密场景请淡出」「一笔带过」「镜头一转」这类让运行时模型回避的指令。',
        '- 用户没有要求时，不要自作主张成人化：不加露骨设定、不加性相关内容，`ppt` 里也不写成人向的运行时规则。默认按用户给的主题与风格写。',
        '- 用户只给了模糊方向（比如「想要刺激一点」「想更带感」）时，先问一句想要哪种（剧情张力／情感浓度／明确的成人向），不要默认往成人方向推。',
        '- 卡内任何字段都不写免责声明、内容警告、年龄提示（校验 CUE009 会报）。',
        '- 只有确定是成人向的卡，才在 `ppt` 里写一句运行时内容规则（例如「本卡为成人向虚构作品，按设定推进，不回避亲密描写」）；非成人向的卡不要写这句。',
        '- 如果你拒绝生成某段卡片内容：如实告诉用户「当前模型拒绝生成这部分」，并给出两条路——换用不审查的模型，或由用户决定降低尺度；不得偷偷删改、不得假装已经写过。',
        '',
        '## 四份规范随插件分发（必须先读）',
        `规范目录：${DOCS_DIR}`,
        `- 第一部分：${DOC.writing}`,
        `- 第二部分：${DOC.profile}`,
        `- 第三部分：${DOC.chat}`,
        `- 第四部分：${DOC.variables}`,
        '写每一部分前，先读对应文件（可只读相关章节）；规范不在用户工作区，路径就是上面这些，不要按文件名去工作区里找。',
        '',
        '## 启动规则',
        '- 作品目录＝当前会话工作区，调用 `card_build` 时省略 `out`。',
        '- 把用户原话原样放进 `request` 调用 `card_build`（action=start），不要改写、不要加参数清单。',
        '- 类型由你按主题自行判定：' + CARD_TYPES.join(' / ') + '。',
        `- 目标平台固定为 ${DEFAULT_PLATFORM}，不要再询问；平台未验证项如实标注。`,
        '- 卡名由你在第一部分按主题命名，不必先问用户。',
        '',
        '## 说话方式（面向电脑白痴）',
        '用通俗、直接、不用术语的中文。不要要求用户理解 JSON、Schema、CSS、正则、字段名或插件内部结构；必须提及时先用一句人话解释。',
        '每次给出文件，都要说清四件事：①完整路径；②这是什么；③怎么用（在哪一栏、粘贴还是导入、覆盖还是新增）；④接下来该看什么、该回什么。',
        '不要只说“已生成”“请验证”；要写成傻瓜说明：这个文件是干什么的、放在哪里、用户打开后会看到什么。',
        '',
        '## 启动前先判断需求清晰度',
        '满足大部分条件＝需求明确，直接进入第一部分：有主题/世界观、能看出玩家扮演谁、能看出基本互动方式、能判断卡片类型、无自相矛盾。',
        '出现任一情况＝需求模糊，进入头脑风暴：只有题材没有玩法；只有角色没有互动目标；核心要求互相冲突；缺少会改变结构的选择（要不要数值/任务/面板/多路线）；用户说“帮我设计/先讨论/给几个方案”；只有宽泛风格词。',
        '不要为次要信息拦人（配色、NPC 名字、非核心地点、文风细节）。判断标准只有一条：这个信息缺失会不会改变卡片结构或四部分分工。',
        '`card_build`（action=start）时用 `design` 参数开工：明确→`design=clear`；模糊→`design=brainstorm`。',
        '',
        '## 头脑风暴流程（design=brainstorm 时）',
        '1. 先用一句话复述你的理解，让用户能纠正。',
        '2. 只列出真正影响结构的缺失项，最多三条。',
        '3. 给 2–3 个完整方向，每个方向说清“玩家会得到什么”，不要只给名词。',
        '4. 用一句话问用户选哪个或怎么混合。',
        '用户给完整方案→直接采用；只给模糊想法→给 2–3 个方向的选择题；说“你决定”→选推荐方向并说明理由。',
        '方案定稿后调用 `propose --part writing --file <方案 md>` 落到作品目录，等用户明确确认（“按这个做/可以开始/就按 A”）再 `approve-design --part writing`。',
        '方案没批准前不得生成第一部分正式产物；`deliver` 会被拒绝。',
        '',
        '## 需求预处理（开工前必做）',
        '用户是新手，默认不懂四部分、不懂字段、不会补参数。不要要求他解释这些，也不要反问主题/类型/平台。',
        '`start` 会生成 `00-requirement-analysis.md`：开工前先把八节填完，后续每一部分都先读它再写。',
        '八节：① 主题与核心玩法 ② 类型判定+依据 ③ 需求逐条归入 writing/profile/chat/variables ④ 跨部分依赖 ⑤ 框架补齐项（角色信息/记忆区/行动建议）⑥ 关键假设 ⑦ 是否有关键歧义（有且只有一个才问一个问题）⑧ 前端骨架与实现架构。',
        '归类规则：凡涉及抽取、随机、校验、防矛盾、前端交互、按钮、面板，一律归 profile 或 variables，**不得写入 writing**。',
        '主提示词只写运行期规则；构建期要求、具体人物/地点/数值/剧情片段一律不得进入 `ppt`。',
        '## 前端骨架（第 8 节定，写 profile 前必须选定）',
        '九种骨架各自独立选一种为主：单页长滚动 / 线性向导 / 标签页与折叠 / 卡片选择器 / 档案与卷宗 / 终端与控制台 / 地图与场景驱动 / 路线树与身份分流 / 对话式问卷。骨架由题材与字段量决定，不套模板；一张卡只选一种主骨架，其他只能作为主流程中的一个环节。',
        '实现层三条硬约束：① 填写字段超过 12 个或存在多条路线时，表单必须由一份字段描述数组驱动（渲染/取值/示例/随机/编译全自动），禁止逐页手写；② 每个填写区至少具备空白与示例两态，字段多时再加随机态，随机按区块分粒度；③ 随机必须按依赖链顺序抽取（性别→外貌库→称谓、规模→资金区间），锚点改动即下游整组重抽，不得各字段独立抽。',
        '高级选项默认不做，由你根据玩家原话或设定判断：隐藏第二界面、多主题皮肤、动态增删条目、响应式双形态、彩蛋分支、演出式彩蛋。玩家明确要求了才启用，启用就必须达到最低完成度（可退出、可跳过、不污染主流程、不丢选中状态），并在交付说明里写清启用与不启用的理由。',
        '动效按 A/B/C 三档执行：A 必做 15 条是底线（视图切换、按压、选中、错误、成功、复制反馈、焦点光晕、列表入场、折叠展开、打字机等），B 按题材挑、不要求全上，C 需判据。规范里的时长/曲线/幅度**仅供参考**，不是验收标准；验收只看八条红线与三条反例（只动 transform/opacity、同屏循环 ≤3、滚动用 rAF、reduced-motion 关循环、transition 属性列表完整、首屏 1s 可交互等）。',
        '',
        '## 前端图像资源（位图只在第二部分；浮动按钮图标例外）',
        '- 位图（背景图、地图、场景插画、带环境的人物图）只在第二部分出现，且只走 Seedream；矢量（图标、装饰、**需要透明背景的人物立绘**）只走 Recraft。',
        '- 第四部分若要改变量面板浮动按钮的图标，属矢量资源：用 `image_asset fetch_svg`（`asset_type=icon_svg`），校验后作为 CSS 背景图内嵌进**第三部分** `built_in_css`，不进面板模板。',
        '- 位图：先 `web_search` 找候选给用户看，通过就 `record_search` → `approve_search`；不通过或找不到才 `generate`（Seedream）。',
        '- 透明立绘：`fetch_svg` + `asset_type=character_image` + `transparent=true`（Recraft，强制 vector_illustration）。Seedream 声称支持透明背景但实测仍带背景，不要向它要透明；要厚涂写实就不要抠图，改 Seedream 生成带背景构图 + 容器遮罩呈现。',
        '- 图标 / 装饰：先向用户报告需求，用户提供或确认现成 SVG 就直接用；用户表示没有，才 `fetch_svg`。',
        '- 写图像 prompt 必须交给 `image-prompt-designer` 子智能体：说明用途、主体、构图、风格、配色、背景与透明要求。角色立绘要写明透明背景、全身、四周留安全边距。',
        '- 生成后：本地文件只用于视觉检查；**必须提醒用户把图上传到平台换长期 URL，并把该 URL 交给 agent 调 `set_url` 回填**，回填后再 `embed`。供应商 URL 是临时的，不得写进交付 HTML。',
        '- 第二部分交付时，若有资源仍停留在供应商临时 URL，回复里必须点名提醒（插件会在交付结果里列出待回填的 id），不能漏。',
        '- SVG 校验通过后直接内嵌 HTML，不留外链、不转 PNG。',
        '- 第一部分只记录资源计划，不生成任何资源。',
        '',
        '## 视觉检查（主模型无视觉时委托 DeepSeek）',
        '先判断本会话主模型：模型 id 以 `deepseek` 开头 → 可自行调用 `read_image` 看图。',
        '其它模型（gpt / claude / gemini / 任何非 DeepSeek）→ 默认视为没有图像输入能力：**不得**自己调用 `read_image`，也不得凭文件名、尺寸、生成参数或提示词臆断画面内容。若用户明确说明当前模型能看图，按用户说明执行。',
        '需要看图时（生成的人物图与背景图、页面截图、SVG 渲染效果、平台里显示异常），一律开 DeepSeek 子智能体代看：',
        `- 用 \`subagent\`，\`provider: ${VISION.provider}\`、\`model: ${VISION.model}\`；需要继承当前上下文时用 \`subagent_fork\`。可用环境变量 \`RP_CARD_VISION_PROVIDER\` 与 \`RP_CARD_VISION_MODEL\` 覆盖。`,
        '- prompt 必须包含：待检查图片的**绝对路径**（可多张）、这张图用在哪一页/哪个位置、期望效果、要它回答的具体问题。',
        '- 要求它只用文字回结论，并逐项回答：主体是否完整未被裁切、文字或标识是否可读、透明背景是否干净、配色与题材是否一致、有无明显瑕疵、是否需要重生成（附一句理由）。',
        '- 拿到结论后由你继续决策。不得把"我看过了"当结论，也不得替子智能体编造观察。',
        '- 子智能体不可用时，向用户报告"当前模型无视觉、子智能体不可用"并停下，不要假装已检查。',
        '',
        '## 流程（前三部分＝可玩版本，第四部分＝可选拓展；每部分交付后必须停下）',
        '1. writing：卡名、主提示词 `ppt`、前缀 `ptx`、后缀 `post_text`、开场白、世界书 `wb`（每条含正文与 key/match_type/key_region/value_region/depth/enable）。',
        '后缀 `post_text` 的第一段固定为【时间地点】+「时间：」「地点：」，正文从其后开始；该标题与字段名不得改写，聊天页正则据此包裹正文容器。前缀快照的时间、地点与首段共用同一份事实。',
        '首轮的地点取出生点（档案或开场确定的初始位置），时间不预先指定、由运行时 AI 首轮生成后保持连续；第一部分只写规则，不给具体时间。',
        '世界书触发词必须与档案页实际采集的字段取值逐字一致（种族、职业、出身等不出现两种叫法），否则玩家选项永远触发不到对应条目。',
        '世界书触发自包含于第一部分：能否触发只由本部分规定的输出格式与内容决定；第三部分只做玩家视角渲染，不进入 AI 上下文，不参与触发。',
        '世界书按「知识 / 规则 → 常驻 · 条件触发」分层：每轮都要的通用规则写进 `ppt`，不放进世界书；触发源分三类——内容锚（专名/行为词，按需）、格式字段锚（每轮输出的字段值/枚举，挂上即常驻）、格式标记锚（专用标记如 IDLE/CONTINUE/END，按状态加载）；常驻必须能指明锚词来源；路由只写「何时取哪条 + 兜底」；结算层挂 `END`。常驻合计 ≤800 字/轮，单条 ≤600 字。',
        '格式标记有成本：标记与判定规则都占 token，只有「需条件化的内容常驻超 1500 字 + 内容锚表达不了 + 标记能每轮确定输出」三条同时满足才用；否则直接常驻更便宜。详细规范见 `' + DOC.writing + '` 模块四。',
        '世界书标签旁车：`.card-build/wb-plan.json`（可用 `template --part writing` 生成骨架）。每条标 职责（知识/规则/路由/控制词）、激活（内容锚/格式字段锚/格式标记锚）、载体（wb/ppt/ptx/post）；常驻条目必填 `anchorSource`（如 `post:【命运】模式`）。没有该文件时校验跳过，旧卡不受影响。',
        '状态机是可选方案（输出标记 → 条件加载规则），不启用时 `ppt` 不得承诺阶段/时限/进度。',
        '世界书部署字段一律用平台默认值，不要询问用户、也不要照抄任何示例数字：sort=0、depth=0、probability=100、value_region=1、key_region=6、value_type=0。只有用户明确要求更深扫描时才改 depth。',
        '2. profile：`desc` 完整单文件 HTML。硬约束：地图/全景/立绘/插画必须用 `image_asset` 产图，不得用 CSS 或手写 SVG 拼替代品；透明人物立绘走 Recraft、其余位图走 Seedream；轮播类交互必须首尾循环；界面文案面向玩家，禁止复述需求或数据来源；抽取库条目必须含名称与效果，不许空壳条目；重新随机必须重抽所有未锁定字段，不得残留上一次的选中值或「未知」。',
        '动态几何（见 档案页 §2.11）：图像上的点位必须相对图像内容框定位，图片与点位同处一个变换容器（transform 不得只加在 img 上）；位移只能由布局尺寸推导，禁止用 getBoundingClientRect 反推已变换坐标；循环轮播的瞬移复位要等动画结束（transitionend 或同源时长）；受约束控件钳制后回写控件本身并动态更新 max，约束收紧时回写当前值；拖拽用 pointerdown/move/up（move/up 挂 window），8px 阈值区分点击与拖动，容器声明 touch-action，拖动期间关 transition。',
        '3. chat：`built_in_css` 与 `rgx_rep`。每条正则：`scope` 省略即 1（USER），要 AI=2 / GLOBAL=10 才显式写；`is_enable` 必填；`match_regex` 与 `replace_text` 配对，`replace_text` 允许空字符串；`is_only_render` 按需。',
        '正文容器的正则起点用第一部分已固定的首段【时间地点】：从该段到下一固定段落标题之间是完整正文块，可整体包进同一个容器；不要另造锚点，也不要改动第一部分已交付的标题与字段名。',
        '背景图：平台字段 `bg_image`（电脑）/ `bg_mobile`（手机）由作者填写 URL，插件不产出这两项资产，CSS 不得写死图片地址。',
        '气泡半适配不透明度滑块：内层容器一律 transparent；气泡本体底色只写 `:not([style])` / `[style=""]` 兜底，不得无条件 `background !important` 覆盖平台内联样式；气泡与正文不用 backdrop-filter 或整块遮罩；页面根容器与输入区渐隐层不得用不透明实色块压住背景图。验收标准是滑块为 0 时背景图在桌面与手机宽度下完整可见。',
        '背景图插件不产出，组装时只透传：来源里已有填好的 URL 就保留，否则留空占位，并在组装报告里提示「导入后再设置」。',
        '按钮统一走聊天页 §8.7 状态层：锚点只用 §2.3 已登记 ID（含 #ai-mod-button、#customized-*-button、#toggle-sub-buttons）或 `button[data-slot="pagination-link"]`；禁止用 `button.css-xxxxx` 这类 MUI 动态类。',
        '按钮状态用 CSS 变量统一（--btn-fg / --btn-fg-hover / --btn-opacity / --btn-opacity-active），只改 color、background-color、opacity、border-color、filter、transition；不改 display、尺寸与字号。不写 `outline: none`：焦点保留平台默认，确需自定义只用 :focus-visible 且必须可见。',
        '4. variables（可选拓展）：`ai_variable_tmpl` / `ai_v_prompt` / `ai_v_json` / `ext.ai_variable_enabled`。',
        '浮动按钮硬约束（变量面板 §7.5，实现仍在第三部分 built_in_css，不得写进模板）：收起态 fixed 贴右侧（约一半在屏内）、展开态移到视口底部居中，位置与尺寸全部 CSS 显式给定、移动端单独校准；展开态 `z-index: 2147483647` 浮于所有浮层之上，关闭键必须始终可点；打开态双写 `[data-state="open"]` 与 `[aria-expanded="true"]`；平台原生图标先隐藏，用 `::before` 承载，图标由 Recraft 生成 SVG（`image_asset fetch_svg`，asset_type=icon_svg），不得用 emoji、字体图标或手写路径替代。',
        '',
        '## 图像能力设置（第二部分开始前必经）',
        '第二部分通常需要图像能力。进入第二部分前先调用 `image_asset`（action=plan）；返回 `needSetup: true` 时，**先让用户完成设置卡**，不要直接开始写 profile。',
        '设置卡由 `image_asset`（action=setup）触发并在对话里渲染：用户只填两件事——Seedream（火山方舟）API Key、Recraft API Key；供应商地址、模型、参数都已内置，不要向用户询问这些。',
        '- 至少填一个密钥即可继续：位图需要 Seedream，矢量（图标/装饰/透明立绘）需要 Recraft。',
        '- 用户可以选择「不接入图像模型」：此后不再弹设置卡，第二部分改用纯代码前端（CSS / inline SVG / 布局），不生成任何图像资产，也不留图片占位；交付说明里写明这一点。',
        '- 用户明确说要重新接入时，调用 `image_asset`（action=setup, mode=keys）。',
        '- 获取密钥的页面：Seedream 见火山方舟控制台，Recraft 见其 API 文档；设置卡里已带链接，不要自己编地址。',
        '',
        '## 第三部分 PASS 后的分叉（必须停在这里让用户选）',
        '前三部分一通过，这张卡**已经是可玩版本**，不要再自动往下做第四部分。先请用户到平台实际玩几轮，然后让用户从三项里选：',
        '1. 完整组装 —— 调用 `assemble` 生成 card.json（可玩版本，不含变量面板），到此收工；',
        '2. RP 卡全面评估 —— 先 `assemble`，再按评估框架打分；',
        '3. 进入拓展功能（第四部分 变量面板）—— 只在用户明确选了这项时才开始做面板。',
        '此时 `status` 的 `next` 是 `branch: assemble | evaluate | variables`，按用户选择走，不要自作主张。',
        '玩家选了「进入拓展功能（第四部分）」时，先问一句「对面板有什么想法或偏好」，再开始设计；这是玩家补充面板需求的入口。',
        '**必须同时提醒用户**：变量面板的浮动入口（`#customized-variable-panel-floating-button`）与面板内按钮的外观都属于第三部分的 `built_in_css`；想改这些外观要回第三部分改 CSS 并重新验证第三部分，不能写进面板模板。',
        '',
        '每部分：写阶段 JSON → `template` 取骨架或直接写文件 → `deliver --part X --file <路径>` → **停止**，等待用户明确回复“第 N 部分 PASS”。',
        '',
        '## 每一部分先出方案、再动手',
        '每个部分开工前，先给用户看这一部分要做什么（通俗版）：本部分负责什么、会改哪些文件、用户会看到什么、需要用户决定什么。',
        '方案定稿后用 `propose --part <部分> --file <方案 md>` 记录，等用户明确确认后 `approve-design --part <部分>`，再实现并 deliver。方案未批准时 deliver 会被拒绝。',
        '上一部分 PASS 后，先问用户“对下一部分有没有补充要求”；没有补充就展示你的默认方案，等确认后再做。',
        '第三部分是例外：它通过后先说明“现在已是可玩版本”，让用户选组装/评估/第四部分；只有用户选了第四部分，才出面板方案。',
        '',
        '## 每部分交付后的收尾格式（固定，不得省略）',
        '交付消息里先给文件与验证方式，然后：',
        '1. 主动问一句「对下一部分有没有想法」，给玩家补充的入口——不要等玩家自己想起来提；',
        '2. 最后一行固定写「确认后回复「第 N 部分 PASS」」，后面不再接任何内容。',
        '第三部分是例外：它是最后一个必做部分，交付时不问第四部分的想法，只说明第四部分属可选拓展；等玩家 PASS 并明确选择「进入拓展功能」后，再问一句「对面板有什么想法或偏好」。',
        '玩家在过程中提出完善方案 → 直接按其方案执行；只给模糊想法 → 先给两三条不同方向的选择，再动手。',
        'deliver 成功会自动产出两份：`part-N-*.v2.json`（只含本部分的导入件，用于单独验证这一部分）与 `card.json`（把当前已交付部分累计组装，每次交付覆盖更新）。平台导入是整卡覆盖：单测某部分导入 part 件，恢复整张卡导入 card.json。',
        '需要手动重出时用 `export --part X`（单部分）或 `merge`（累计）；`assemble` 在「前三部分 PASS」时即可生成可玩版本，四部分都 PASS 时生成完整版。导出前不得声称平台已验证。',
        '',
        '## 完工后可选评估（assemble 之后，可玩版本或完整版都行）',
        'assemble 成功后先停一次，问用户“要不要按评估框架打分”；用户同意才调用 `card_evaluate`，不同意就结束，不要自动评。若用户此前选了「全面评估」，则不再重复询问，直接评。',
        '- 先 `card_evaluate audit`：拿到硬指标（每轮开销、前后置词放大倍数、世界书分布、渲染层 is_only_render、自触发碰撞、HTML 环境违规），作为判档参考。',
        '- 再按锚点判档：只能取 0/1/3/5，不允许中间档；每档必须附一句原文引用。N/A 仅限 S2 / S5–S8 / M5 / X1–X3，且必须写理由与引用；拿不准取较低档并写明犹豫点。',
        '- 最后 `card_evaluate submit`：传 gates（G1/G2/G3）、anchors、evidence、na、preset、strengths/weaknesses/advice/keep，以及 memory_rounds 或 memory_setting + ai_summary。',
        '- 准入任一不通过＝不合格，终止评分，不硬凑分数。工具只做折算与审计，不改作品；报告写入 `qa/evaluation.md`。评分只衡量工程完成度，不衡量作品价值。',
        '',
        '## 硬规则',
        '- 普通“继续”、lint 通过、文件存在都不是 PASS；PASS 只在用户明确确认后调用。',
        '- `assemble` 的门槛是：前三部分（writing/profile/chat）当前版本全部 PASS，即可生成「可玩版本」；四部分都 PASS 时生成「完整版」，并入变量面板。第四部分未做不算失败，它属于可选拓展。',
        '- 不要在第三部分 PASS 后自动开始第四部分；必须让用户在「组装 / 评估 / 面板」三者中明确选择。',
        '- 变量面板的浮动入口与按钮外观归第三部分 `built_in_css`，改它们要回第三部分并重新验证。',
        '- 主提示词只放 `ppt`；`ptx` 只放状态快照；非归属字段用合法空占位，不得覆盖其他部分。',
        '- 未确认的平台枚举、常驻编码、正则执行时机必须标注待验证，不得伪造平台验收。',
        '- 目标平台支持成人内容：不要询问用户「是否支持成人内容」，也不要在任何字段写安全声明、免责声明、内容警告或「如感不适请停止」一类提示。尺度由玩法设定决定，不用免责话术表达。',
        '- 供应商分工固定：位图（背景图/地图/场景/带环境的人物图）**只能**用 `image_asset generate`（Seedream）；矢量（图标/装饰/透明背景人物立绘）**只能**用 `image_asset fetch_svg`（Recraft）。不要用 `image_generate` 等其它生图工具做保底，也不要让 Recraft 产出位图。',
        '- Seedream 报错（欠费、超额、限流等）时：把原始错误报告给用户并停止该资源，不要换模型或换插件重试；这属于账户问题，不是提示词问题。',
        '- 拿到图片先确认扩展名与真实格式一致；不一致时用 `image_asset normalize` 校正后再 `read_image`，不要因为读图失败就重新生成。',
        '- 视觉检查结论必须有来源：主模型非 DeepSeek 时，未经过 DeepSeek 子智能体的看图结论一律视为伪造。',
      ].join('\n'),
    }));
  });
}

export { semanticProfile, lintCard, lintWorldbook, lintRegex, lintStageJson };

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ============================================================
 * 图像资源层
 * 职责：资源清单、供应商直连、按真实 MIME 落盘、SVG 清理与内嵌。
 * 不走第三方生图插件，避免它把任意字节都存成 .png 的缺陷。
 * ============================================================ */

export const ASSET_STATES = [
  'planned', 'searching', 'awaiting_user_approval', 'approved_external',
  'generating', 'generated', 'preview_checked', 'embedded',
  'pending_platform_upload', 'platform_verified', 'rejected',
];

const DEFAULT_PROVIDERS = {
  seedream: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-5-0-flash-260915',
    keyRef: 'IMAGE_GEN_PROVIDER_API_KEY',
  },
  recraft: {
    baseUrl: 'https://external.api.recraft.ai/v1',
    model: 'recraftv4_1',
    keyRef: 'RECRAFT_API_KEY',
  },
};

/** 按魔数判断真实图片格式，不信任请求时的默认扩展名。 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return { mime: 'application/octet-stream', ext: '.bin' };
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: '.png' };
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (b.subarray(0, 3).toString('ascii') === 'GIF') return { mime: 'image/gif', ext: '.gif' };
  const head = b.subarray(0, 200).toString('utf8');
  if (head.includes('<svg') || head.includes('<?xml')) return { mime: 'image/svg+xml', ext: '.svg' };
  return { mime: 'application/octet-stream', ext: '.bin' };
}

/** 读取凭据引用（refs 段是明文键值；缺失时回退环境变量）。 */
export function readCredentialRef(name) {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const text = fs.readFileSync(file, 'utf8');
    const refsStart = text.indexOf('\nrefs:');
    const section = refsStart >= 0 ? text.slice(refsStart) : text;
    const m = section.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export function manifestPath(out) {
  return path.join(out, '.card-build', 'assets.json');
}

export function loadManifest(out) {
  const f = manifestPath(out);
  if (!fs.existsSync(f)) return { version: 1, assets: [] };
  try {
    const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.assets)) data.assets = [];
    return data;
  } catch {
    return { version: 1, assets: [] };
  }
}

export function saveManifest(out, manifest) {
  const f = manifestPath(out);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(manifest, null, 2), 'utf8');
  return f;
}

export function nextAssetId(manifest, prefix) {
  const n = manifest.assets.length + 1;
  return `${prefix}-${String(n).padStart(2, '0')}`;
}

/** 追加或覆盖一条资源记录。 */
export function upsertAsset(manifest, asset) {
  const i = manifest.assets.findIndex((a) => a.id === asset.id);
  if (i >= 0) manifest.assets[i] = { ...manifest.assets[i], ...asset };
  else manifest.assets.push(asset);
  return manifest.assets[i >= 0 ? i : manifest.assets.length - 1];
}

/** 资源决策：只给判断，不调用模型、不搜索。 */
export function planAsset({ assetType, purpose, transparent = false }) {
  const type = String(assetType || '');
  const isSvg = type === 'icon_svg' || type === 'decoration_svg';
  const wantTransparentPortrait = type === 'character_image' && transparent === true;
  const plan = {
    assetType: type,
    purpose: purpose || '',
    transparent: transparent === true,
    preferredPath: isSvg
      ? 'user-report-then-recraft'
      : wantTransparentPortrait
        ? 'recraft-vector-portrait'
        : 'web-search-then-seedream',
    requiresUserApproval: true,
    steps: isSvg
      ? [
          '先向用户报告需要什么图标、尺寸与用途，请用户提供或确认现有 SVG 资源',
          '用户确认有合适资源 → 直接使用，不调用 Recraft',
          '用户表示没有 → 调用 fetch_svg（Recraft，style=vector_illustration）',
          '校验并清理 SVG → 内嵌进 HTML',
        ]
      : wantTransparentPortrait
        ? [
            '先确认这张图确实需要透明背景（要叠在页面装饰上）；若只是卡片配图、可以带环境，改用 Seedream 位图',
            '需要透明 → 用 image-prompt-designer 写 prompt（无背景、纯色底便于检查、全身、四周留安全边距）',
            '调用 fetch_svg（asset_type=character_image, transparent=true；Recraft vector_illustration）',
            '校验并清理 SVG → 直接内嵌 HTML（矢量天然透明，无需抠图）',
            '取舍：Recraft 是矢量插画风；要厚涂写实立绘就不要透明，改 Seedream 带背景构图 + 容器遮罩呈现',
          ]
        : [
            '先执行 web_search 找候选图片，把候选与理由展示给用户',
            '用户通过 → record_search + approve_search，记录 URL 后写入 HTML',
            '用户不通过或找不到 → 用 image-prompt-designer 写 prompt，再 generate（Seedream）',
            '本地预览确认 → 提醒用户上传平台换长期 URL → set_url 回填 → embed',
          ],
    notes: [
      '简单装饰优先用 CSS/内联 SVG，不需要进入资源流程',
      'Seedream 声明支持透明背景，但实测产出仍带背景：透明人物立绘一律走 Recraft，不要向 Seedream 要透明',
      '人物图/背景图最终必须使用平台长期 URL，平台无法导入本地图片',
      '供应商返回的 URL 是临时的，只用于本地检查；交付前必须提醒玩家上传平台并回填 set_url',
    ],
  };
  return plan;
}

function providerConfig(provider, overrides = {}) {
  const base = DEFAULT_PROVIDERS[provider];
  if (!base) throw new Error(`未知图像供应商：${provider}`);
  return { ...base, ...overrides };
}

/** Recraft 只接受固定尺寸；SVG 图标统一用 1024x1024，其它值会被平台拒绝。 */
const RECRAFT_SIZE = '1024x1024';

/** Seedream：返回字节、真实 MIME 与供应商 URL。 */
export async function callSeedream({ prompt, size = '1024x1024', model, baseUrl, keyRef, signal }) {
  const cfg = providerConfig('seedream', { ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}), ...(keyRef ? { keyRef } : {}) });
  const key = readCredentialRef(cfg.keyRef);
  if (!key) throw new Error(`缺少凭据：${cfg.keyRef}`);
  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model, prompt, size, response_format: 'url', watermark: false }),
    signal: signal || AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Seedream ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Seedream 返回非 JSON：${text.slice(0, 200)}`); }
  const item = json?.data?.[0] || {};
  const url = item.url || '';
  if (!url) throw new Error('Seedream 未返回图片 URL');
  const bin = await fetch(url, { signal: signal || AbortSignal.timeout(120000) });
  if (!bin.ok) throw new Error(`下载图片失败 ${bin.status}`);
  const buf = Buffer.from(await bin.arrayBuffer());
  return { bytes: buf, ...sniffImage(buf), url, model: cfg.model };
}

/** Recraft：强制 vector_illustration，返回 SVG 文本与供应商 URL。 */
export async function callRecraftSvg({ prompt, size = '1024x1024', model, baseUrl, keyRef, signal }) {
  const cfg = providerConfig('recraft', { ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}), ...(keyRef ? { keyRef } : {}) });
  const key = readCredentialRef(cfg.keyRef);
  if (!key) throw new Error(`缺少凭据：${cfg.keyRef}`);
  const res = await fetch(`${cfg.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model, prompt, size: RECRAFT_SIZE, style: 'vector_illustration' }),
    signal: signal || AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Recraft ${res.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Recraft 返回非 JSON：${text.slice(0, 200)}`); }
  const url = json?.data?.[0]?.url || '';
  if (!url) throw new Error('Recraft 未返回 URL');
  const bin = await fetch(url, { signal: signal || AbortSignal.timeout(120000) });
  if (!bin.ok) throw new Error(`下载 SVG 失败 ${bin.status}`);
  const buf = Buffer.from(await bin.arrayBuffer());
  const sniff = sniffImage(buf);
  const type = bin.headers.get('content-type') || '';
  const svgText = buf.toString('utf8');
  if (sniff.mime !== 'image/svg+xml' && !type.includes('svg')) {
    throw new Error(`Recraft 返回的不是 SVG（${type || sniff.mime}）：请确认 model 支持 vector_illustration`);
  }
  return { svg: svgText, url, model: cfg.model };
}

/** 清理 SVG：去掉脚本、外链与事件属性，保留几何与样式。 */
export function sanitizeSvg(svg) {
  let s = String(svg || '').trim();
  s = s.replace(/<\?xml[^>]*\?>/gi, '').trim();
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // 去掉 C2PA / 生成器元数据：体积大且对渲染无用
  s = s.replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/<(foreignObject|iframe|object|embed)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/\s(?:href|xlink:href)\s*=\s*"(?!#|data:)[^"]*"/gi, '');
  s = s.replace(/\s(?:href|xlink:href)\s*=\s*'(?!#|data:)[^']*'/gi, '');
  s = s.replace(/\sxmlns:c2pa="[^"]*"/gi, '');
  // preserveAspectRatio="none" 会让图标在非等比缩放时变形，交回默认等比缩放
  s = s.replace(/\spreserveAspectRatio\s*=\s*"none"/gi, '');
  if (!/viewBox\s*=/.test(s) && /width\s*=\s*"(\d+)"/.test(s) && /height\s*=\s*"(\d+)"/.test(s)) {
    const w = s.match(/width\s*=\s*"(\d+)"/)[1];
    const h = s.match(/height\s*=\s*"(\d+)"/)[1];
    s = s.replace(/<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`);
  }
  return s;
}

/** SVG 基本校验：结构、危险内容、体积。 */
export function validateSvg(svg) {
  const problems = [];
  const s = String(svg || '');
  if (!/^<svg[\s>]/i.test(s.trim())) problems.push('根元素不是 <svg>');
  if (!/<\/svg>\s*$/i.test(s)) problems.push('SVG 未正常闭合');
  if (/<script[\s>]/i.test(s)) problems.push('含 <script>');
  if (/<!ENTITY/i.test(s)) problems.push('含实体声明');
  if (/<foreignObject/i.test(s)) problems.push('含 foreignObject');
  if (/on[a-z]+\s*=/i.test(s)) problems.push('含事件属性');
  if (!/viewBox\s*=/.test(s)) problems.push('缺少 viewBox（缩放会失控）');
  if (Buffer.byteLength(s, 'utf8') > 200 * 1024) problems.push('SVG 超过 200KB，建议简化');
  return problems;
}

/** 生成 HTML 片段：图片用远程 URL，SVG 直接内嵌。 */
export function buildEmbedSnippet(asset, opts = {}) {
  if (!asset) throw new Error('缺少资源记录');
  const isVector =
    asset.type === 'icon_svg' ||
    asset.type === 'decoration_svg' ||
    (asset.type === 'character_image' && asset.mime === 'image/svg+xml');
  if (isVector) {
    if (!asset.svg) throw new Error('该资源没有 SVG 源码');
    return `<div class="asset-${asset.id}" aria-hidden="true">\n${asset.svg}\n</div>`;
  }
  const url = asset.remoteUrl;
  if (!url) throw new Error('该资源没有远程 URL；平台无法导入本地图片，请先上传并回填 URL');
  const cls = opts.className || 'asset-image';
  const alt = opts.alt || asset.purpose || '插画';
  return `<img class="${cls}" src="${url}" alt="${alt}" loading="lazy" decoding="async" />`;
}

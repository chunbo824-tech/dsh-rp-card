import fs from 'node:fs';
import path from 'node:path';
import {
  ASSET_STATES, loadManifest, saveManifest, upsertAsset, nextAssetId, planAsset,
  callSeedream, callRecraftSvg, sanitizeSvg, validateSvg, buildEmbedSnippet, sniffImage,
} from './assets.js';
import { keyStatus, setupPayload, needSetupPayload, saveKeys, skipImages } from './image-setup.js';

const IMAGE_ACTIONS = ['setup', 'plan', 'record_search', 'approve_search', 'generate', 'fetch_svg', 'validate_svg', 'normalize', 'embed', 'list', 'set_status', 'set_url'];

// 分工：位图（背景图/地图/场景/带环境的人物图）只走 Seedream；
// 矢量（图标/装饰/需要透明背景的人物立绘）只走 Recraft。两边都不许越界。
const IMAGE_TYPES = ['character_image', 'background_image'];
const SVG_TYPES = ['icon_svg', 'decoration_svg'];

/** 用户选择不接入图像模型时的统一返回：给纯代码指引，不报错。 */
const PURE_CODE_GUIDANCE = {
  ok: false,
  pureCode: true,
  kind: 'image-setup',
  message: '用户已选择「不接入图像模型」：本卡按纯代码前端执行，不生成任何图像资产。',
  steps: [
    '前端改用纯代码实现：排版、装饰、图形用 CSS / inline SVG / 布局完成',
    '不要调用 generate / fetch_svg，也不要留图片占位或外链',
    '交付说明里写明「按用户选择未接入图像模型，前端为纯代码实现」',
  ],
};

function isVectorAsset(asset) {
  return asset.type === 'icon_svg'
    || asset.type === 'decoration_svg'
    || (asset.type === 'character_image' && asset.mime === 'image/svg+xml');
}

function assetDir(out) {
  const dir = path.join(out, 'assets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBinary(dir, base, bytes, ext) {
  const file = path.join(dir, `${base}${ext}`);
  fs.writeFileSync(file, bytes);
  return file;
}

/**
 * 资源动作分发。所有写入都落在 <out>/ 下，清单在 .card-build/assets.json。
 */
export async function runAssetAction(args, out) {
  const action = String(args.action || 'plan');
  if (!IMAGE_ACTIONS.includes(action)) throw new Error(`未知资源动作：${action}（可选 ${IMAGE_ACTIONS.join(' / ')}）`);

  const manifest = loadManifest(out);

  // 纯代码模式：涉及产图的动作一律给指引，不尝试调用、也不报错
  if (keyStatus().pureCode && ['record_search', 'approve_search', 'generate', 'fetch_svg'].includes(action)) {
    return { action, ...PURE_CODE_GUIDANCE };
  }

  if (action === 'list') {
    return { action, count: manifest.assets.length, assets: manifest.assets };
  }

  // 图像能力设置：填写密钥 / 选择不接入图像模型
  if (action === 'setup') {
    const mode = String(args.mode || '').trim();
    if (mode === 'none') return { action, ...skipImages() };
    if (mode === 'keys' && !args.seedream_key && !args.recraft_key) {
      return { action, ...setupPayload() };
    }
    if (args.seedream_key || args.recraft_key) {
      const saved = saveKeys({ seedream: String(args.seedream_key || ''), recraft: String(args.recraft_key || '') });
      return { action, ...setupPayload(), ...saved };
    }
    return { action, ...setupPayload() };
  }

  if (action === 'plan') {
    const st = keyStatus();
    const plan = planAsset({
      assetType: args.asset_type,
      purpose: args.purpose,
      transparent: args.transparent === true,
    });
    if (st.pureCode) {
      return {
        action,
        ...plan,
        pureCode: true,
        imageSetup: st,
        steps: [
          '用户已选择「不接入图像模型」：本卡不生成任何图像资产',
          '第二部分改用纯代码前端：排版、装饰、图形用 CSS / inline SVG / 布局实现',
          '不要调用 generate / fetch_svg，也不要留图片占位',
          '交付说明里写明「按用户选择未接入图像模型，前端为纯代码实现」',
        ],
      };
    }
    return { action, ...plan, imageSetup: st, needSetup: st.needSetup };
  }

  if (action === 'record_search') {
    const results = Array.isArray(args.search_results) ? args.search_results : [];
    if (!results.length) throw new Error('record_search 需要 search_results 数组');
    const id = String(args.asset_id || nextAssetId(manifest, args.asset_type === 'background_image' ? 'bg' : 'img'));
    const asset = upsertAsset(manifest, {
      id,
      type: String(args.asset_type || 'character_image'),
      purpose: String(args.purpose || ''),
      provider: 'web-search',
      state: 'awaiting_user_approval',
      candidates: results.map((r) => ({ url: String(r.url || ''), title: String(r.title || ''), note: String(r.note || '') })),
      createdAt: new Date().toISOString(),
    });
    saveManifest(out, manifest);
    return { action, asset, next: '把 candidates 展示给用户；用户选中后调用 approve_search' };
  }

  if (action === 'approve_search') {
    const id = String(args.asset_id || '');
    const asset = manifest.assets.find((a) => a.id === id);
    if (!asset) throw new Error(`找不到资源：${id}`);
    const url = String(args.url || '');
    if (url && !asset.candidates.some((c) => c.url === url)) throw new Error('该 URL 不在候选列表里');
    asset.remoteUrl = url || (asset.candidates[0] || {}).url || '';
    asset.state = 'approved_external';
    asset.approvedAt = new Date().toISOString();
    saveManifest(out, manifest);
    return { action, asset };
  }

  if (action === 'generate') {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw new Error('generate 需要 prompt');
    const gate = keyStatus();
    if (gate.pureCode) {
      return { action, ...PURE_CODE_GUIDANCE };
    }
    if (!gate.seedream) {
      return needSetupPayload('seedream', '缺少 Seedream 密钥（IMAGE_GEN_PROVIDER_API_KEY）：无法生成位图。先完成图像能力设置，或由用户选择不接入图像模型。');
    }
    const type = String(args.asset_type || 'character_image');
    const transparent = args.transparent === true;
    if (SVG_TYPES.includes(type)) {
      throw new Error(`${type} 是矢量图标，必须用 fetch_svg（Recraft）；generate 只用于人物图/背景图等位图`);
    }
    if (type === 'character_image' && transparent) {
      throw new Error(
        '透明背景的人物立绘必须用 fetch_svg（asset_type=character_image, transparent=true，Recraft vector_illustration）。' +
        'Seedream 虽声明支持透明背景，但实测产出仍带背景，不要指望它抠图；背景图/地图/场景插画继续用 generate。'
      );
    }
    if (transparent) {
      throw new Error('只有人物立绘需要透明背景；背景图/地图/场景插画不需要透明，直接用 generate 生成位图');
    }
    const id = String(args.asset_id || nextAssetId(manifest, args.asset_type === 'background_image' ? 'bg' : 'img'));
    let result;
    try {
      result = await callSeedream({ prompt, size: String(args.size || '1024x1024') });
    } catch (e) {
      // 不要静默换供应商：位图只走 Seedream，失败就把原因交回给用户
      throw new Error(`Seedream 生成失败：${e && e.message ? e.message : e}。位图只由 Seedream 生成，不要改用其他模型或别的生图插件做保底；把该错误报告给用户。`);
    }
    const dir = assetDir(out);
    const file = writeBinary(dir, id, result.bytes, result.ext);
    const asset = upsertAsset(manifest, {
      id,
      type: String(args.asset_type || 'character_image'),
      purpose: String(args.purpose || ''),
      provider: 'seedream',
      model: result.model,
      prompt,
      size: String(args.size || '1024x1024'),
      localFile: path.relative(out, file).split(path.sep).join('/'),
      mime: result.mime,
      remoteUrl: result.url,
      remoteUrlSource: 'provider-temporary',
      state: 'generated',
      createdAt: new Date().toISOString(),
    });
    saveManifest(out, manifest);
    return {
      action,
      asset,
      note: '供应商 URL 是临时的，只用于本地检查；交付前必须换成平台长期地址。',
      nextSteps: [
        '本地文件只用于视觉检查（必要时委托视觉检查子智能体）；不要把它写进 HTML',
        '把这张图上传到平台资源库或图床，复制平台返回的长期 URL',
        '把该 URL 交给 agent，调用 image_asset set_url 回填到该资源',
        '回填后再 embed；HTML 里只能出现平台长期 URL',
      ],
    };
  }

  if (action === 'fetch_svg') {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw new Error('fetch_svg 需要 prompt');
    const gate = keyStatus();
    if (gate.pureCode) {
      return { action, ...PURE_CODE_GUIDANCE };
    }
    if (!gate.recraft) {
      return needSetupPayload('recraft', '缺少 Recraft 密钥（RECRAFT_API_KEY）：无法生成 SVG 图标、装饰或透明立绘。先完成图像能力设置，或由用户选择不接入图像模型。');
    }
    const type = String(args.asset_type || 'icon_svg');
    const transparent = args.transparent === true;
    if (type === 'background_image') {
      throw new Error('background_image 是位图资源，必须用 generate（Seedream）；Recraft 只输出矢量');
    }
    if (IMAGE_TYPES.includes(type) && type !== 'character_image') {
      throw new Error(`${type} 是位图资源，必须用 generate（Seedream）；Recraft 只用来出 SVG`);
    }
    if (type === 'character_image' && !transparent) {
      throw new Error('不透明的角色图走 generate（Seedream 位图更写实）；只有需要透明背景的立绘才用 fetch_svg，并显式传 transparent=true');
    }
    const id = String(args.asset_id || nextAssetId(manifest, type === 'character_image' ? 'svgportrait' : 'svg'));
    const result = await callRecraftSvg({ prompt, size: String(args.size || '1024x1024') });
    const cleaned = sanitizeSvg(result.svg);
    const problems = validateSvg(cleaned);
    if (problems.length) throw new Error(`SVG 校验未通过：${problems.join('；')}`);
    const dir = assetDir(out);
    const file = path.join(dir, `${id}.svg`);
    fs.writeFileSync(file, cleaned, 'utf8');
    const asset = upsertAsset(manifest, {
      id,
      type,
      purpose: String(args.purpose || ''),
      provider: 'recraft',
      model: result.model,
      prompt,
      transparent: type === 'character_image',
      localFile: path.relative(out, file).split(path.sep).join('/'),
      mime: 'image/svg+xml',
      remoteUrl: result.url,
      remoteUrlSource: 'provider-temporary',
      state: 'generated',
      createdAt: new Date().toISOString(),
    });
    saveManifest(out, manifest);
    return {
      action,
      asset,
      bytes: Buffer.byteLength(cleaned, 'utf8'),
      note: type === 'character_image'
        ? '透明立绘以 SVG 内嵌，天然无背景；Recraft 是矢量插画风，若要厚涂写实请改用 Seedream 带背景构图 + 容器遮罩。'
        : 'SVG 校验通过，直接内嵌；不引用外链、不转位图。',
    };
  }

  if (action === 'validate_svg') {
    const id = String(args.asset_id || '');
    const asset = manifest.assets.find((a) => a.id === id);
    if (!asset) throw new Error(`找不到资源：${id}`);
    const svg = asset.svg || (asset.localFile ? fs.readFileSync(path.join(out, asset.localFile), 'utf8') : '');
    const problems = validateSvg(sanitizeSvg(svg));
    return { action, assetId: id, ok: problems.length === 0, problems };
  }

  // 按真实字节修正扩展名：别的工具（或旧产物）常把 WebP/JPEG 存成 .png，导致 read_image 失败
  if (action === 'normalize') {
    const rel = String(args.path || '');
    if (!rel) throw new Error('normalize 需要 path（图片文件路径）');
    const abs = path.isAbsolute(rel) ? rel : path.join(out, rel);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const buf = fs.readFileSync(abs);
    const sniff = sniffImage(buf);
    if (sniff.ext === '.bin') throw new Error('无法识别该文件的真实图片格式');
    const current = path.extname(abs).toLowerCase();
    const relOld = path.relative(out, abs).split(path.sep).join('/');
    if (current === sniff.ext) {
      return { action, file: relOld, mime: sniff.mime, renamed: false, note: '扩展名已经正确' };
    }
    const target = abs.slice(0, abs.length - current.length) + sniff.ext;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    fs.renameSync(abs, target);
    const relNew = path.relative(out, target).split(path.sep).join('/');
    for (const a of manifest.assets) {
      if (a.localFile === relOld) a.localFile = relNew;
    }
    saveManifest(out, manifest);
    return { action, from: relOld, to: relNew, mime: sniff.mime, renamed: true };
  }

  if (action === 'embed') {
    const id = String(args.asset_id || '');
    const asset = manifest.assets.find((a) => a.id === id);
    if (!asset) throw new Error(`找不到资源：${id}`);
    // SVG 不存进清单，用到时从文件读，避免 manifest 膨胀
    if (!asset.svg && asset.localFile && asset.mime === 'image/svg+xml') {
      asset.svg = fs.readFileSync(path.join(out, asset.localFile), 'utf8');
    }
    const html = buildEmbedSnippet(asset, { className: args.class_name, alt: args.alt });
    asset.state = 'embedded';
    asset.embeddedAt = new Date().toISOString();
    saveManifest(out, manifest);
    const warning = asset.remoteUrlSource === 'provider-temporary'
      ? '当前仍是供应商临时 URL：可以本地预览，但交付前必须提醒用户上传平台、把长期 URL 交给 agent 用 set_url 回填。'
      : '';
    return {
      action,
      assetId: id,
      html,
      warning,
      note: isVectorAsset(asset) ? 'SVG 已内嵌，无需外链' : '图片使用远程 URL；本地文件不进入交付物',
    };
  }

  if (action === 'set_url') {
    const id = String(args.asset_id || '');
    const asset = manifest.assets.find((a) => a.id === id);
    if (!asset) throw new Error(`找不到资源：${id}`);
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('set_url 需要 http(s) URL（平台上传后的地址）');
    asset.remoteUrl = url;
    asset.remoteUrlSource = 'platform';
    asset.uploadedAt = new Date().toISOString();
    asset.state = 'pending_platform_upload';
    saveManifest(out, manifest);
    return {
      action,
      asset,
      note: '已回填平台长期 URL；平台内实际显示仍需人工验证，验证通过后再 set_status(platform_verified)。',
    };
  }

  if (action === 'set_status') {
    const id = String(args.asset_id || '');
    const state = String(args.state || '');
    if (!ASSET_STATES.includes(state)) throw new Error(`未知状态：${state}`);
    const asset = manifest.assets.find((a) => a.id === id);
    if (!asset) throw new Error(`找不到资源：${id}`);
    asset.state = state;
    asset.updatedAt = new Date().toISOString();
    saveManifest(out, manifest);
    return { action, asset };
  }

  throw new Error(`未处理的动作：${action}`);
}

export { sniffImage };

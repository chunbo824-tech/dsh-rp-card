import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffImage, sanitizeSvg, validateSvg, planAsset, buildEmbedSnippet } from '../lib/assets.js';
import { runAssetAction } from '../lib/asset-actions.js';

// 1. MIME 嗅探：不信任扩展名
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from([0, 0, 0, 0])]);
const svgBuf = Buffer.from('<svg viewBox="0 0 1 1"></svg>');
assert.equal(sniffImage(jpeg).ext, '.jpg');
assert.equal(sniffImage(png).ext, '.png');
assert.equal(sniffImage(webp).ext, '.webp');
assert.equal(sniffImage(svgBuf).ext, '.svg');

// 2. 决策：图像先搜索，SVG 先问用户
const img = planAsset({ assetType: 'character_image', purpose: '立绘' });
assert.equal(img.preferredPath, 'web-search-then-seedream');
assert.equal(img.requiresUserApproval, true);
assert.match(img.steps.join('\n'), /web_search/);
const icon = planAsset({ assetType: 'icon_svg', purpose: '齿轮图标' });
assert.equal(icon.preferredPath, 'user-report-then-recraft');
assert.match(icon.steps.join('\n'), /Recraft/);

// 透明立绘走 Recraft 矢量路线，不透明的角色图仍走位图路线
const transparentPortrait = planAsset({ assetType: 'character_image', purpose: '立绘', transparent: true });
assert.equal(transparentPortrait.preferredPath, 'recraft-vector-portrait');
assert.match(transparentPortrait.steps.join('\n'), /fetch_svg/);
assert.match(transparentPortrait.notes.join('\n'), /Seedream 声明支持透明背景/);

// 3. SVG 清理：脚本、事件属性、外链都要去掉
const dirty = '<svg viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><rect width="10" height="10" fill="#123456"/><use href="https://evil.example/x.svg"/></svg>';
const clean = sanitizeSvg(dirty);
assert.ok(!/<script/.test(clean), 'script 未清除');
assert.ok(!/onload/.test(clean), '事件属性未清除');
assert.ok(!/evil\.example/.test(clean), '外链未清除');
assert.ok(/viewBox/.test(clean), 'viewBox 丢失');
assert.deepEqual(validateSvg(clean), { errors: [], warnings: [] });

// 3b. 生成器元数据与形变属性要被清掉
const dirty2 = '<svg viewBox="0 0 10 10" preserveAspectRatio="none" xmlns:c2pa="http://c2pa.org/manifest"><metadata>PAYLOAD</metadata><rect width="10" height="10"/></svg>';
const clean2 = sanitizeSvg(dirty2);
assert.ok(!/metadata/.test(clean2), 'metadata 未清除');
assert.ok(!/c2pa/.test(clean2), 'c2pa 命名空间未清除');
assert.ok(!/preserveAspectRatio/.test(clean2), 'preserveAspectRatio 未清除');
assert.ok(clean2.length < dirty2.length);

// 4. 缺 viewBox 要报出来（致命错误）
assert.ok(validateSvg('<svg><rect/></svg>').errors.some((p) => p.includes('viewBox')));

// 4b. 体积分两级：300KB 以内不提示；超过只给 warnings，不算错误（玩家自己决定用不用）
const midSvg = `<svg viewBox="0 0 10 10">${'<rect width="10" height="10"/>'.repeat(4500)}</svg>`;
assert.ok(Buffer.byteLength(midSvg, 'utf8') < 300 * 1024, '样例应小于 300KB');
assert.deepEqual(validateSvg(midSvg), { errors: [], warnings: [] }, '300KB 以内不该提示');

const bigSvg = `<svg viewBox="0 0 10 10">${'<rect width="10" height="10"/>'.repeat(16000)}</svg>`;
assert.ok(Buffer.byteLength(bigSvg, 'utf8') > 300 * 1024, '构造的样例没超过 300KB');
const bigCheck = validateSvg(bigSvg);
assert.deepEqual(bigCheck.errors, [], '体积不该算错误');
assert.equal(bigCheck.warnings.length, 1, '体积超线应给一条警告');
assert.match(bigCheck.warnings[0], /300KB/);

// 5. 内嵌片段：SVG 直嵌、图片必须用远程 URL
const svgAsset = { id: 'svg-01', type: 'icon_svg', svg: clean };
const svgHtml = buildEmbedSnippet(svgAsset);
assert.match(svgHtml, /^<div class="asset-svg-01"/);
assert.match(svgHtml, /<svg/);

const imgAsset = { id: 'img-01', type: 'character_image', remoteUrl: 'https://cdn.example/a.jpg', purpose: '立绘' };
const imgHtml = buildEmbedSnippet(imgAsset);
assert.match(imgHtml, /src="https:\/\/cdn\.example\/a\.jpg"/);
assert.match(imgHtml, /loading="lazy"/);

assert.throws(() => buildEmbedSnippet({ id: 'img-02', type: 'character_image' }), /远程 URL/);

// 6. 供应商分工：位图走 Seedream，矢量/透明立绘走 Recraft，越界必须直接拒绝
// 用假密钥把「缺密钥」分支挡掉，保证这组断言只验证分工，不依赖本机是否配过密钥
process.env.IMAGE_GEN_PROVIDER_API_KEY = 'test-seedream-key';
process.env.RECRAFT_API_KEY = 'test-recraft-key';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-guard-'));
fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true });
await assert.rejects(() => runAssetAction({ action: 'generate', asset_type: 'icon_svg', prompt: 'x' }, tmp), /必须用 fetch_svg/);
await assert.rejects(
  () => runAssetAction({ action: 'generate', asset_type: 'character_image', prompt: 'x', transparent: true }, tmp),
  /透明背景的人物立绘必须用 fetch_svg/,
);
await assert.rejects(
  () => runAssetAction({ action: 'generate', asset_type: 'background_image', prompt: 'x', transparent: true }, tmp),
  /不需要透明/,
);
await assert.rejects(
  () => runAssetAction({ action: 'fetch_svg', asset_type: 'character_image', prompt: 'x' }, tmp),
  /不透明的角色图走 generate/,
);
await assert.rejects(
  () => runAssetAction({ action: 'fetch_svg', asset_type: 'background_image', prompt: 'x' }, tmp),
  /必须用 generate/,
);

// 6b. 透明立绘以 SVG 内嵌；位图仍必须给远程 URL
const svgPortrait = { id: 'svgportrait-01', type: 'character_image', mime: 'image/svg+xml', svg: clean };
assert.match(buildEmbedSnippet(svgPortrait), /<svg/);

// 7. normalize：按真实字节纠正扩展名（别的工具常把 WebP/JPEG 存成 .png）
fs.writeFileSync(path.join(tmp, 'assets', 'wrong.png'), jpeg);
const fixed = await runAssetAction({ action: 'normalize', path: 'assets/wrong.png' }, tmp);
assert.equal(fixed.renamed, true);
assert.equal(fixed.to, 'assets/wrong.jpg');
assert.ok(!fs.existsSync(path.join(tmp, 'assets', 'wrong.png')));
assert.ok(fs.existsSync(path.join(tmp, 'assets', 'wrong.jpg')));

// 8. validate_svg：体积超线只给 warnings，ok 仍为 true（产物可照常使用，由玩家决定）
fs.writeFileSync(path.join(tmp, 'assets', 'big.svg'), bigSvg, 'utf8');
fs.mkdirSync(path.join(tmp, '.card-build'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, '.card-build', 'assets.json'),
  JSON.stringify({ version: 1, assets: [{ id: 'svg-99', type: 'decoration_svg', localFile: 'assets/big.svg' }] }),
  'utf8',
);
const checked = await runAssetAction({ action: 'validate_svg', asset_id: 'svg-99' }, tmp);
assert.equal(checked.ok, true, '体积超线不应判失败');
assert.equal(checked.problems.length, 0);
assert.equal(checked.warnings.length, 1);
assert.match(checked.warnings[0], /300KB/);

console.log('assets tests passed');
delete process.env.IMAGE_GEN_PROVIDER_API_KEY;
delete process.env.RECRAFT_API_KEY;

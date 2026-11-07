import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  keyStatus, setupPayload, saveKeys, skipImages, resumeImages,
  readImageMode, handleRpc, credentialsPath, statePath, PROVIDER_KEYS,
} from '../lib/image-setup.js';
import { runAssetAction } from '../lib/asset-actions.js';

// 隔离：所有读写落在临时目录，不碰真实 ~/.dsh
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-image-setup-'));
process.env.RP_CARD_DSH_DIR = home;
delete process.env[PROVIDER_KEYS.seedream];
delete process.env[PROVIDER_KEYS.recraft];

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-image-out-'));
const reset = () => {
  for (const f of [statePath(), credentialsPath()]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
};

// 1. 默认：未配置、需要弹卡
reset();
let st = keyStatus();
assert.equal(st.mode, 'keys');
assert.equal(st.needSetup, true, '没有密钥时应要求设置');
assert.equal(st.pureCode, false);

// 2. 设置卡数据带链接与供应商信息
const payload = setupPayload();
assert.equal(payload.kind, 'image-setup');
assert.ok(payload.links.seedream.includes('volcengine'));
assert.ok(payload.links.recraft.includes('recraft.ai'));
assert.equal(payload.providers.seedream.configured, false);

// 3. 保存一个密钥 → 不再强制设置，另一个仍缺
saveKeys({ seedream: 'sk-seedream-test' });
st = keyStatus();
assert.equal(st.seedream, true);
assert.equal(st.recraft, false);
assert.equal(st.needSetup, false, '有一个密钥就不该强制弹卡');

// 4. 保存第二个密钥 → 两个都就绪，且文件保留其他内容
fs.writeFileSync(
  credentialsPath(),
  'model: x\nrefs:\n  IMAGE_GEN_PROVIDER_API_KEY: sk-seedream-test\n  OTHER_KEY: keep-me\n',
  'utf8',
);
saveKeys({ recraft: 'sk-recraft-test' });
st = keyStatus();
assert.equal(st.seedream, true);
assert.equal(st.recraft, true);
const credText = fs.readFileSync(credentialsPath(), 'utf8');
assert.ok(credText.includes('OTHER_KEY: keep-me'), '不能覆盖已有的其他凭据');
assert.ok(credText.includes('RECRAFT_API_KEY: sk-recraft-test'));

// 5. 环境变量优先于文件
process.env[PROVIDER_KEYS.seedream] = 'env-key';
assert.equal(keyStatus().seedream, true);
delete process.env[PROVIDER_KEYS.seedream];

// 6. 选择不接入 → 不再弹卡，且写入持久状态
skipImages();
st = keyStatus();
assert.equal(st.mode, 'none');
assert.equal(st.pureCode, true);
assert.equal(st.needSetup, false, '选择不接入后不应再要求设置');
assert.equal(readImageMode(), 'none');
assert.ok(fs.existsSync(statePath()));

// 7. 重新启用
resumeImages();
assert.equal(keyStatus().mode, 'keys');
assert.equal(keyStatus().needSetup, false, '密钥还在，不需要重新设置');

// 8. RPC 端点
const rpcState = await handleRpc('state', {});
assert.equal(rpcState.kind, 'image-setup');
const rpcSkip = await handleRpc('skip', {});
assert.equal(rpcSkip.mode, 'none');
const rpcResume = await handleRpc('resume', {});
assert.equal(rpcResume.mode, 'keys');
await assert.rejects(() => handleRpc('nope', {}), /未知端点/);

// 9. plan：未配置时透出 needSetup；不接入时给出纯代码步骤
reset();
const plan1 = await runAssetAction({ action: 'plan', asset_type: 'background_image', purpose: '封面' }, out);
assert.equal(plan1.needSetup, true);
skipImages();
const plan2 = await runAssetAction({ action: 'plan', asset_type: 'background_image', purpose: '封面' }, out);
assert.equal(plan2.pureCode, true);
assert.ok(plan2.steps.join(' ').includes('纯代码'));

// 10. generate：未配置密钥 → 返回 needSetup，不抛错、不发网络请求
reset();
const gen = await runAssetAction({ action: 'generate', prompt: 'x', asset_type: 'background_image' }, out);
assert.equal(gen.ok, false);
assert.equal(gen.needSetup, true);
assert.equal(gen.provider, 'seedream');

// 11. generate：选择不接入 → 返回纯代码指引，不抛错、不尝试调用
skipImages();
const pureGen = await runAssetAction({ action: 'generate', prompt: 'x', asset_type: 'background_image' }, out);
assert.equal(pureGen.ok, false);
assert.equal(pureGen.pureCode, true);
assert.ok(pureGen.steps.join(' ').includes('纯代码'));

// 12. fetch_svg：缺 Recraft 密钥 → needSetup(recraft)
reset();
const svg = await runAssetAction({ action: 'fetch_svg', prompt: '图标', asset_type: 'icon_svg' }, out);
assert.equal(svg.needSetup, true);
assert.equal(svg.provider, 'recraft');

// 13. setup 动作：mode=none 持久化
reset();
const setupNone = await runAssetAction({ action: 'setup', mode: 'none' }, out);
assert.equal(setupNone.mode, 'none');
assert.equal(keyStatus().mode, 'none');

// 14. setup 动作：写入密钥
reset();
const setupKeys = await runAssetAction({ action: 'setup', seedream_key: 'sk-abc' }, out);
assert.equal(setupKeys.seedream, true);

// 15. 「不接入」也可通过凭据条目表达（客户端写的就是这里）
reset();
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(credentialsPath(), 'refs:\n  RP_CARD_IMAGE_MODE: none\n', 'utf8');
assert.equal(readImageMode(), 'none');
assert.equal(keyStatus().pureCode, true);
assert.equal(keyStatus().needSetup, false);
fs.writeFileSync(credentialsPath(), 'refs:\n  RP_CARD_IMAGE_MODE: keys\n', 'utf8');
assert.equal(readImageMode(), 'keys');

for (const dir of [home, out]) fs.rmSync(dir, { recursive: true, force: true });
console.log('image setup tests passed');

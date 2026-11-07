import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// 只在测试中使用已安装 DSH 的 Cordis；插件运行时不依赖它。
const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS_PATH,
  path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'),
  path.join(os.homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter(Boolean);
const cordisPath = CORDIS_CANDIDATES.find((p) => fs.existsSync(p));
if (!cordisPath) {
  console.log('skip: 未找到 Cordis 安装路径，跳过注入时序测试');
  process.exit(0);
}

const { Context } = await import(pathToFileURL(cordisPath).href);
const pluginUrl = pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href;
const plugin = await import(pluginUrl);

const registered = [];
const tick = () => new Promise((r) => setTimeout(r, 30));

const ctx = new Context();
// 关键时序：插件先于服务加载，复现真实 profile 中的加载顺序。
ctx.plugin({ apply: plugin.apply });
await tick();
assert.deepEqual(registered, [], '服务尚未提供时不应注册任何东西');

ctx.provide('commands', { register: (d) => { registered.push(`command:${d.name}`); return () => {}; } });
ctx.provide('tools', { register: (d) => { registered.push(`tool:${d.name}`); return () => {}; } });
ctx.provide('systemPrompt', { section: (s) => { registered.push(`prompt:${s.name}`); return () => {}; } });
await tick();

assert.deepEqual(
  registered.sort(),
  ['command:card-build', 'prompt:rp-card-workflow', 'tool:card_build', 'tool:image_asset', 'tool:card_evaluate'].sort(),
  `服务就绪后应完成注册，实际：${JSON.stringify(registered)}`,
);
console.log('inject registration test passed:', registered.join(', '));
process.exit(0);

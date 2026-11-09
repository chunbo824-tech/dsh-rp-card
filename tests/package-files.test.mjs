import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1. files 必须覆盖 lib 下的子目录（1.6.0–1.6.2 曾漏掉 lib/library，导致装上去加载失败）
const coversLib = pkg.files.some((f) => f === 'lib/**' || f === 'lib/library/**' || f === 'lib');
assert.ok(coversLib, 'files 必须包含 lib/**，否则 lib/library 不会被打包');

// 2. 源码里确实有这些文件
assert.ok(fs.existsSync(path.join(root, 'lib/library/index.js')), 'lib/library/index.js 应存在');
assert.ok(fs.existsSync(path.join(root, 'lib/library/tool.js')), 'lib/library/tool.js 应存在');

// 3. index.js 引用了 library 模块时，必须保证它会被打包
const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
if (idx.includes('./lib/library/')) {
  assert.ok(coversLib, 'index.js 引用 lib/library，files 必须覆盖它');
}

// 4. 规范文件也要随包分发
const coversDocs = pkg.files.some((f) => f === 'docs/**' || f === 'docs/supplements/**');
assert.ok(coversDocs, 'files 必须包含 docs/**');
assert.ok(fs.existsSync(path.join(root, 'docs/supplements/资料库.md')), '资料库.md 应存在');

console.log('package files tests passed');

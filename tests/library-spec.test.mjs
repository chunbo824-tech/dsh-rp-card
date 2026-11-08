import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// 1. 资料库规范存在且含关键约定
const doc = fs.readFileSync(path.join(root, 'docs/supplements/资料库.md'), 'utf8');
const musts = [
  ['触发条件', /触发条件/],
  ['防误触', /不触发（防误触）/],
  ['材料缺失处理', /材料缺失时的处理/],
  ['附件落盘', /对话附件/],
  ['剧本按集', /剧本[\s\S]{0,40}按集/],
  ['四种材料类型', /novel[\s\S]{0,80}screenplay[\s\S]{0,80}setting-book[\s\S]{0,80}game-script/],
  ['两套取舍方案', /方案 A · 沉浸优先[\s\S]{0,400}方案 B · 轻量优先/],
  ['视觉独立交付', /独立交付：`visual\.json` \+ `visual-proposal\.md`/],
  ['方案审批门禁', /propose \/ approve-design/],
  ['阶段门控', /known_from/],
  ['库校验', /LIB001[\s\S]{0,600}LIB007/],
];
for (const [name, re] of musts) {
  assert.ok(re.test(doc), '资料库规范缺少：' + name);
}

// 2. supplements README 登记了资料库
const readme = fs.readFileSync(path.join(root, 'docs/supplements/README.md'), 'utf8');
assert.match(readme, /资料库\.md/, 'README 未登记资料库.md');

// 3. 注入层包含触发规则
const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
assert.match(idx, /## 资料库流程（同人 \/ 改编 \/ 参考材料）/, '缺少资料库流程注入');
assert.match(idx, /不传则取消该流程/, '缺少取消分支');
assert.match(idx, /\.card-build\/library\/sources\//, '缺少附件落盘路径');
assert.match(idx, /两个硬性停点/, '缺少停点说明');

// 4. 规范不越界：不写 ppt / 不写页面代码
assert.match(doc, /资料库不写 `ppt`、不写开场白、不写页面代码/);

console.log('library spec tests passed');

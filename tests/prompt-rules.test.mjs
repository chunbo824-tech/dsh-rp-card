import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href);

let captured = '';
const ctx = {
  effect: (fn) => fn(),
  inject: (_d, cb) => cb(ctx),
  get: (n) => ({
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    systemPrompt: { section: (s) => { captured = s.text; return () => {}; } },
  })[n],
};
mod.apply(ctx);

// 1. 规范路径注入
assert.match(captured, /docs\\5-成人向补充\.txt|docs\/5-成人向补充\.txt/, '必须注入成人向补充路径');
assert.match(captured, /supplements/, '必须注入补充材料目录');

// 2. 数值卡是高级选项，且必须先征得同意
assert.match(captured, /数值卡\.md/, '必须指向数值卡补充材料');
assert.match(captured, /玩家同意后才读/, '读数值卡前必须征得玩家同意');
assert.match(captured, /token 增加/, '必须说明 token 增加的代价');
assert.match(captured, /心算/, '必须说明心算误差的风险');

// 3. 成人向格式方案与部分名 PASS 规则
assert.match(captured, /format-mode --mode semantic/);
assert.match(captured, /部分名/);

console.log('prompt rules tests passed');

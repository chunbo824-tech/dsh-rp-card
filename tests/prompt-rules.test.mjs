import assert from 'node:assert/strict';
import fs from 'node:fs';
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

// 4. 跨部分边界：聊天原生输入归第三部分，desc 不得另造聊天输入
assert.match(captured, /desc 只做初始化页 iframe 内控件/);
assert.match(captured, /不得在 desc 里新建聊天输入替代它/);
assert.match(captured, /视觉类请求/);
assert.match(captured, /不透明度 0/);
assert.match(captured, /不能把空字段直接当无背景/);
const profileDoc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'docs', '2-档案页.txt'), 'utf8');
assert.match(profileDoc, /4\.5 跨部分边界/);
assert.match(profileDoc, /不得在 `desc` 内创建“聊天输入 \/ 发送”/);
const chatDoc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'docs', '3-聊天页.txt'), 'utf8');
for (const needle of ['8.9.1 图像背景上的控件保底', '8.9.2 固定气泡背景的联动触发', '9.2 视觉类请求的触发范围', '图像 / 跟随平台（无背景）', '背景类型判定', '不能把空字段直接当无背景', '不透明度 0', '8.10 控件分层命名', '8.11 平台图标不可靠时的自绘', '9.1 改样式前置动作', '固定尺寸按钮反例', '#customized-ai-input-container', '#ai-mod-button2', '[data-slot="pagination-item"]', 'aria-current="page"', '#customized-model-selector', '#ai-model-selector', '[data-slot="popover-trigger"]', '!important 判据', '实底填充例外', 'outline-color']) {
  assert.ok(chatDoc.includes(needle), `聊天页规范缺少：${needle}`);
}

console.log('prompt rules tests passed');

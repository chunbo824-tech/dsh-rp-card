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

// 4.1 消息内面板切换按条件使用 radio / details（实测更正：失败原因是 association / checked 字面量）
assert.match(chatDoc, /2\.6 面板交互实现规范/, '聊天页规范缺少 2.6 面板交互实现规范');
assert.match(chatDoc, /2\.6\.2 单选切换的四条硬条件/, '聊天页规范缺少单选切换四条硬条件');
assert.match(chatDoc, /正则生成的 HTML 中禁止出现 "checked" 字面量/, '规范必须禁止正则侧写 checked 字面量');
assert.match(chatDoc, /details\[name="…"\]/, '规范必须给出同组互斥展开写法');
assert.match(chatDoc, /7\.2 互斥切换（消息内可用，但有条件）/, '聊天页规范缺少 7.2 条件使用小节');
assert.match(captured, /面板 \/ 页签 \/ 条目切换可用 radio \+ `:checked` 或 `details`/, '系统提示词必须给出 radio 的条件使用口径');
assert.ok(!chatDoc.includes('禁止用 radio + ":checked"'), '不应再保留全面禁止 radio 的表述');

// 5. 复制能力：平台 iframe 实测只有 execCommand 可用（2026-11-16）
assert.match(captured, /document\.execCommand\("copy"\)/, '系统提示词必须写明复制只走 execCommand');
assert.match(captured, /禁止 `navigator\.clipboard`/, '系统提示词必须禁止 navigator.clipboard 作主路径或兜底');
assert.match(captured, /data-panel-copy/, '变量面板复制必须指向平台原生 data-panel-copy');
assert.match(profileDoc, /3\.6\.1 平台 iframe 内的复制实现/, '档案页规范缺少复制实现小节');
assert.match(profileDoc, /navigator\.clipboard/, '档案页规范必须点名不可用的异步剪贴板 API');
assert.match(profileDoc, /window\.clipboardData/, '档案页规范必须点名不可用的 window.clipboardData');
assert.match(chatDoc, /复制在聊天页只有三条路/, '聊天页规范缺少复制边界');
const variablesDoc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'docs', '4-变量面板.txt'), 'utf8');
assert.match(variablesDoc, /面板内的复制没有脚本可用/, '变量面板规范缺少复制边界');
assert.match(variablesDoc, /data-panel-copy/, '变量面板规范缺少平台原生复制说明');

console.log('prompt rules tests passed');

import assert from 'node:assert/strict';
import { lintChatCss, lintStageJson, pickBackground, toPlatform } from '../lib/core.js';

const ids = (css) => lintChatCss(css).map((x) => x.id);
const has = (css, id) => ids(css).includes(id);

// 1. 气泡本体无条件背景：会覆盖平台不透明度滑块
assert.ok(has(`#customized-answer-content { background: #151515 !important; }`, 'CSS001'));
assert.ok(has(`#customized-question-content { background-color: #000 !important; }`, 'CSS001'));

// 2. 带 :not([style]) / [style=""] 守卫时放行
const guarded = `
#customized-answer-content:not([style]),
#customized-answer-content[style=""] { background: #151515 !important; }
`;
assert.deepEqual(ids(guarded), []);
assert.ok(!has(`#customized-question-content:not([style]) { background: #000 !important; }`, 'CSS001'));

// 3. 内层透明不算违规（背景只挂在最外层是允许的）
const inner = `
#customized-answer { background: transparent !important; }
#customized-answer-container, #customized-answer-content-container { background: transparent !important; }
#customized-answer-content .markdown-body { background: transparent !important; }
`;
assert.deepEqual(ids(inner), []);

// 4. pointer-events/文字装饰挂在气泡上不算背景问题
assert.ok(!has(`#customized-answer-content { position: relative !important; isolation: isolate !important; }`, 'CSS001'));

// 5. backdrop-filter 会模糊背景图
assert.ok(has(`#customized-answer-content { backdrop-filter: blur(6px) !important; }`, 'CSS002'));

// 6. 页面根容器不透明背景会盖住 bg_image / bg_mobile
assert.ok(has(`body { background: #0a0708; }`, 'CSS003'));
assert.ok(has(`html { background-color: #000 !important; }`, 'CSS003'));
assert.ok(!has(`body { background: transparent; }`, 'CSS003'));

// 7. 交付检查已接入 chat 部分（warning 不阻断，但必须出现在诊断里）
const chatStage = {
  title: '测试卡', ppt: '', ptx: '', post_text: '', opening_statement: '', wb: [],
  desc: '', built_in_css: '#customized-answer-content { background: #111 !important; }',
  rgx_rep: [], ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};
const diag = lintStageJson('chat', chatStage);
assert.ok(diag.some((x) => x.id === 'CSS001'), 'chat 阶段应带出 CSS001');
assert.equal(diag.filter((x) => x.severity === 'error').length, 0, 'CSS 检查不应阻断交付');

// 8. 按钮锚点：MUI 动态类禁止，已登记 ID 放行
assert.ok(has(`button.css-m3x93c { color: #E8E8E8; }`, 'CSS004'), 'emotion 动态类应报 CSS004');
assert.ok(has(`#customized-copy-button .css-abc123 { color: red; }`, 'CSS004'));
assert.ok(!has(`#ai-mod-button { color: #E8D5A3; }`, 'CSS004'));
assert.ok(!has(`#customized-ai-summary-button { color: #E8D5A3; }`, 'CSS006'), '已登记的新增页面按钮不应报清单缺失');
assert.ok(!has(`#toggle-sub-buttons { color: #E8D5A3; }`, 'CSS006'));
// 平台文档补充锚点（2.3b）：面板壳层、快捷指令、两组图片/音频按钮都不应报清单缺失
assert.ok(!has(`#customized-variable-panel-floating-panel-header-actions-close { color: #E8D5A3; }`, 'CSS006'));
assert.ok(!has(`#customized-shortcut-command-button-3 { color: #E8D5A3; }`, 'CSS006'));
assert.ok(!has(`#customized-immersive-image-button { color: #E8D5A3; }`, 'CSS006'));

// 9. 清单外容器 ID 提示
assert.ok(has(`#customized-unknown-button { color: red; }`, 'CSS006'));

// 10. 焦点：删掉焦点提示报警，保留平台默认或 :focus-visible 放行
assert.ok(has(`#customized-copy-button:focus { outline: none; }`, 'CSS005'));
assert.ok(!has(`#customized-copy-button:focus-visible { outline: 2px solid #E8D5A3; outline-offset: 2px; }`, 'CSS005'));
assert.ok(!has(`#customized-copy-button:hover { color: #fff; }`, 'CSS005'), '平台默认焦点行为不应被改动');

// 11. 背景图只透传：给了 URL 就保留，没给就留空占位
assert.deepEqual(
  pickBackground({ bg_image: ' https://cdn.example/a.png ', bg_mobile: 'https://cdn.example/b.png' }),
  { bg_img: 'https://cdn.example/a.png', mobile_bg: 'https://cdn.example/b.png' },
);
assert.equal(toPlatform({ title: '测试卡', bg_img: 'https://cdn.example/a.png' }).bg_img, 'https://cdn.example/a.png');
assert.equal(toPlatform({ title: '测试卡' }).bg_img, '', '没有来源 URL 时保持空占位');
assert.equal(toPlatform({ title: '测试卡' }).mobile_bg, '');

console.log('chat background tests passed');

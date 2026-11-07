import assert from 'node:assert/strict';
import { lintChatCss } from '../lib/core.js';

const ids = (css) => lintChatCss(css).map((x) => x.id);
const has = (css, id) => ids(css).includes(id);

// 1. 双写打开态 + 顶层 z-index：通过
const good = `
#customized-variable-panel-floating-button[data-state="open"],
#customized-variable-panel-floating-button[aria-expanded="true"] {
  z-index: 2147483647 !important;
  width: 40px !important; height: 40px !important;
  left: 50% !important; bottom: 110px !important;
  translate: -50% 0 !important;
}
`;
assert.deepEqual(ids(good), []);

// 2. 只写一种打开态标记 → CSS008
assert.ok(has(`#customized-variable-panel-floating-button[data-state="open"] { z-index: 2147483647 !important; }`, 'CSS008'));
assert.ok(has(`#customized-variable-panel-floating-button[aria-expanded="true"] { z-index: 2147483647 !important; }`, 'CSS008'));

// 3. 双写但缺顶层 z-index → CSS007
assert.ok(has(`
#customized-variable-panel-floating-button[data-state="open"],
#customized-variable-panel-floating-button[aria-expanded="true"] { background: #14151B !important; }
`, 'CSS007'));

// 4. z-index 太小也拦
assert.ok(has(`
#customized-variable-panel-floating-button[data-state="open"],
#customized-variable-panel-floating-button[aria-expanded="true"] { z-index: 9998 !important; }
`, 'CSS007'));

// 5. 没有触碰浮动按钮的 CSS 不应报这两项
assert.ok(!has('.doc-card { border: 1px solid #424844; }', 'CSS007'));
assert.ok(!has('.doc-card { border: 1px solid #424844; }', 'CSS008'));

console.log('floating button tests passed');

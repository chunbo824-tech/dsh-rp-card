import assert from 'node:assert/strict';
import { lintRoutingConflict } from '../lib/core.js';

const writing = (over = {}) => ({
  ppt: '你是本世界的记录者。',
  post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】X\n\n【当前状态】\n· 她此刻：X',
  ...over,
});
const chat = (rules) => ({ built_in_css: '.x{}', rgx_rep: rules });

// 1. 纯文本锚点 + 正则：正常路线，不报
{
  const d = lintRoutingConflict(writing(), chat([
    { is_enable: true, match_regex: '【当前状态】([\\s\\S]*?)(?=【|$)', replace_text: '<div class="s">$1</div>' },
  ]));
  assert.deepEqual(d.map((x) => x.id), []);
}

// 2. 提示词里让 AI 输出 HTML 标签 + 有正则：路线冲突
{
  const d = lintRoutingConflict(
    writing({ post_text: '<ai><hd><d>【时间地点】</d><br></hd></ai>' }),
    chat([{ is_enable: true, match_regex: '【时间地点】', replace_text: '<b>x</b>' }]),
  );
  const c17 = d.find((x) => x.id === 'CUE017');
  assert.ok(c17, '应报 CUE017');
  assert.match(c17.message, /原因：/);
  assert.match(c17.message, /两条路：/);
}

// 3. 只让 AI 输出标签、但没有正则：不算冲突
{
  const d = lintRoutingConflict(writing({ post_text: '<div>【正文】</div>' }), chat([]));
  assert.ok(!d.some((x) => x.id === 'CUE017'), '没有正则时不算冲突');
}

// 4. 正则匹配不到模板内容：CUE018
{
  const d = lintRoutingConflict(writing(), chat([
    { is_enable: true, match_regex: '【不存在的锚点】', replace_text: '<b>x</b>' },
  ]));
  const c18 = d.find((x) => x.id === 'CUE018');
  assert.ok(c18, '应报 CUE018');
  assert.match(c18.message, /原因：/);
  assert.match(c18.message, /两条路：/);
}

// 5. 正则语法错误：CUE018 且给出原因
{
  const d = lintRoutingConflict(writing(), chat([
    { is_enable: true, match_regex: '([unclosed', replace_text: 'x' },
  ]));
  const c18 = d.find((x) => x.id === 'CUE018');
  assert.ok(c18);
  assert.match(c18.message, /语法无效/);
}

// 6. 停用的规则不检查
{
  const d = lintRoutingConflict(writing(), chat([
    { is_enable: false, match_regex: '【不存在】', replace_text: 'x' },
  ]));
  assert.deepEqual(d.map((x) => x.id), []);
}

console.log('routing conflict tests passed');

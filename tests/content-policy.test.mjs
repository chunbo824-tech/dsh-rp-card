import assert from 'node:assert/strict';
import { lintStageJson } from '../lib/core.js';

const base = (over = {}) => ({
  title: '测试卡',
  ppt: '你是叙事者，按设定推进。',
  ptx: '【当前状态】· 时间：X',
  post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】X',
  opening_statement: '开始。',
  wb: [],
  desc: '',
  built_in_css: '',
  rgx_rep: [],
  ai_variable_tmpl: '',
  ai_v_prompt: '',
  ai_v_json: '',
  ext: { ai_variable_enabled: false },
  ...over,
});

const ids = (v) => lintStageJson('writing', v).map((d) => d.id);

// 1. 正常文本不误报
assert.ok(!ids(base()).includes('CUE011'), '正常文本不应触发 CUE011');
assert.ok(!ids(base()).includes('CUE009'), '正常文本不应触发 CUE009');

// 2. 自我审查痕迹会被抓到
for (const phrase of [
  '他把她按在墙上，此处省略三千字。',
  '两人相拥，镜头一转，天亮了。',
  '接下来的事不可描述。',
  '（内容略）',
  '春宵一刻，此处不表。',
]) {
  const v = base({ post_text: `【正文】${phrase}` });
  assert.ok(ids(v).includes('CUE011'), `应抓到自我审查痕迹：${phrase}`);
}

// 3. 免责话术仍单独报 CUE009，且不误报 CUE011
const disclaimer = base({ ppt: '本卡包含成人内容，如感不适请停止。' });
const d2 = ids(disclaimer);
assert.ok(d2.includes('CUE009'), '免责话术应报 CUE009');
assert.ok(!d2.includes('CUE011'), '免责话术不应误判为自我审查');

// 3b. 否定语境里提到这些词属正当写作要求，不应误报
for (const text of [
  '不得用「此处省略」代替场景。',
  '禁止在正文里写「镜头一转」。',
  '避免使用「此处不表」这类写法。',
  '严禁把「（内容略）」留在卡里。',
]) {
  const v = base({ ppt: text });
  assert.ok(!ids(v).includes('CUE011'), `否定句不该误报：${text}`);
}

// 3c. 同一条文本里，否定句与真实痕迹共存时仍应抓到
const mixed = base({ post_text: '【正文】不得用「镜头一转」，但这里真的镜头一转了。' });
assert.ok(ids(mixed).includes('CUE011'), '真实痕迹应仍被抓到');

// 4. 运行时内容规则写法不触发任何告警
const runtime = base({ ppt: '本卡为成人向虚构作品，按设定推进，不回避亲密描写。' });
const d3 = ids(runtime);
assert.ok(!d3.includes('CUE009') && !d3.includes('CUE011'), '运行时内容规则不应被告警');

console.log('content policy tests passed');

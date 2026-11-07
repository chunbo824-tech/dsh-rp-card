import assert from 'node:assert/strict';
import { toPlatform, V2_KEY_ORDER, LORE_ENTRY_KEYS } from '../lib/core.js';

/**
 * 黄金快照：只锁「格式形状」，不锁「哪些字段有内容」。
 * 这样第二部分/第三部分/第四部分填上内容后，本测试仍然通过。
 */

const EXPECTED_TYPES = {
  desc: 'string', sys_opt: 'boolean', avail_np: 'boolean', lc: 'string',
  summary_config: 'object', name: 'string', cvr: 'null', ref_id2: 'number',
  preset_tp: 'number', plat_vis: 'number', bg_img: 'string', ext_cfg: 'object',
  mobile_bg: 'string', suggest_q_after: 'object', ianon: 'boolean',
  cover_tiny: 'string', mod_pm: 'number', msc: 'object', no_css_mod: 'boolean',
  shortcut_commands: 'array', ptx: 'string', sq: 'array', ai_variable_tmpl: 'string',
  opening_statement: 'string', cgb: 'array', lore_bk: 'array', def_msg_cnt: 'number',
  ai_v_json: 'string', ps_chats: 'array', knd: 'number', built_in_css: 'string',
  pre_prompt: 'string', category: 'number', post_text: 'string', extend: 'object',
  rgx_rep: 'array', sum_info: 'string', ai_variable_prompt: 'string',
  labels: 'array', ban_wd: 'array',
};

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const baseCard = {
  title: '测试卡', ppt: '主提示词', ptx: '状态模板', post_text: '输出协议',
  opening_statement: '开场', wb: [
    { group: 'g', match_type: 2, key: '_or_a@wb@b', key_region: 6, value_region: 1, value: '正文', depth: 4, enable: true },
  ],
  desc: '', built_in_css: '', rgx_rep: [], ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};

function checkShape(label, card) {
  assert.deepEqual(Object.keys(card).sort(), [...V2_KEY_ORDER].sort(), `${label}: 顶层键集合与平台样例不一致`);
  for (const [key, expected] of Object.entries(EXPECTED_TYPES)) {
    assert.equal(typeOf(card[key]), expected, `${label}: ${key} 类型应为 ${expected}，实际 ${typeOf(card[key])}`);
  }
  for (const entry of card.lore_bk) {
    assert.deepEqual(Object.keys(entry).sort(), [...LORE_ENTRY_KEYS].sort(), `${label}: 世界书条目字段集合不一致`);
    assert.equal(typeOf(entry.value), 'string', `${label}: 世界书 value 必须是字符串`);
    assert.equal(typeOf(entry.enable), 'boolean', `${label}: 世界书 enable 必须是布尔`);
  }
}

// 1. 只交付第一部分时的导出件
const onlyWriting = toPlatform(baseCard, 'v2');
checkShape('仅第一部分', onlyWriting);
assert.equal(onlyWriting.pre_prompt, '主提示词');
assert.equal(onlyWriting.desc, '');
assert.equal(onlyWriting.built_in_css, '');

// 2. 四部分都填好时的导出件：内容变了，形状必须不变
const fullCard = {
  ...baseCard,
  desc: '<!DOCTYPE html><html><body>初始化页</body></html>',
  built_in_css: '.msg{color:#fff}',
  rgx_rep: [{ scope: 10, title: 'r', is_enable: true, match_regex: 'a', replace_text: 'b', is_only_render: false }],
  ai_variable_tmpl: '<div>{{level}}</div>',
  ai_v_prompt: '只输出 JSON',
  ai_v_json: '{"type":"object"}',
  ext: { ai_variable_enabled: true },
};
const full = toPlatform(fullCard, 'v2');
checkShape('四部分齐全', full);
assert.equal(full.desc, fullCard.desc);
assert.equal(full.built_in_css, fullCard.built_in_css);
assert.equal(full.rgx_rep.length, 1);
assert.equal(full.ai_variable_tmpl, fullCard.ai_variable_tmpl);
assert.equal(full.ai_variable_prompt, fullCard.ai_v_prompt);
assert.equal(full.ai_v_json, fullCard.ai_v_json);
assert.equal(full.extend.ai_variable_enabled, true);

// 3. 只支持一种格式：传别的格式必须报错
assert.throws(() => toPlatform(baseCard, 'v1'), /不支持的导出格式/);

// 4. 配置骨架固定值：这些由平台样例固化，不允许被内容覆盖
assert.equal(onlyWriting.knd, 1);
assert.equal(onlyWriting.mod_pm, 4);
assert.equal(onlyWriting.preset_tp, 1);
assert.equal(onlyWriting.def_msg_cnt, 6);
assert.equal(onlyWriting.lc, 'zh-Hans');
assert.deepEqual(onlyWriting.msc, { tracks: [], autoplay: true });
assert.equal(onlyWriting.cvr, null);

console.log('golden v2 tests passed');

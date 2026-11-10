import test from 'node:test';
import assert from 'node:assert/strict';

import { FIELD_ALIASES, PLATFORM_KEY_ALIASES, pickField } from '../lib/core.js';
import { normalizeReviewCard, detectCardFormat, parseCardJson } from '../lib/review.js';

/** fengyue.ai 现行导出件的最小样本（第三套键名）。 */
const SAMPLE = {
  app_name: '末日拘束系统',
  pre_pt: '主提示词正文',
  pretxt: '前缀词正文',
  posttxt: '后缀词正文',
  descr: '<div>档案页</div>',
  rrep: [{ scope: 1, is_enable: true, match_regex: 'a', replace_text: 'b' }],
  world_bk: [{ group: '测试', key: '_or_钥匙', value: '条目正文', enable: true }],
  built_in_css: '.x{color:red}',
  ost: '选择一段开场白',
  ai_variable_json: '{}',
  ai_variable_tmpl: '模板',
  ext: { ai_variable_enabled: true },
  // 平台设置键
  anonymous: true,
  cov_tn: '封面缩略图',
  banned_words: ['词'],
  bg_music: { tracks: [], autoplay: true },
  sc_cmds: ['一键饮食'],
  sqaa: { enabled: true },
  cvr_url: 'https://example.com/c.png',
  avail_not_pub: false,
  cate: 3,
  dcm: true,
  modp: 7,
  bg_mobile: 'https://example.com/m.png',
  language: 'zh-Hans',
  ps_type: 1,
  vp_mode: 0,
  ui_flag: [],
  image_bk: [],
  abs_txt: '简介',
  tags: [],
};

test('现行导出件：六个内容字段都能按别名读到', () => {
  assert.equal(pickField(SAMPLE, 'title'), '末日拘束系统');
  assert.equal(pickField(SAMPLE, 'ppt'), '主提示词正文');
  assert.equal(pickField(SAMPLE, 'ptx'), '前缀词正文');
  assert.equal(pickField(SAMPLE, 'post_text'), '后缀词正文');
  assert.equal(pickField(SAMPLE, 'desc'), '<div>档案页</div>');
  assert.equal(pickField(SAMPLE, 'opening_statement'), '选择一段开场白');
  assert.equal(pickField(SAMPLE, 'rgx_rep').length, 1);
  assert.equal(pickField(SAMPLE, 'wb').length, 1);
});

test('现行导出件：归一后各字段不再为空', () => {
  const { card } = normalizeReviewCard(parseCardJson(JSON.stringify(SAMPLE)));
  assert.equal(card.title, '末日拘束系统');
  assert.equal(card.ppt, '主提示词正文');
  assert.equal(card.ptx, '前缀词正文');
  assert.equal(card.post_text, '后缀词正文');
  assert.equal(card.desc, '<div>档案页</div>');
  assert.equal(card.opening_statement, '选择一段开场白');
  assert.equal(card.built_in_css, '.x{color:red}');
  assert.equal(card.wb.length, 1);
  assert.equal(card.rgx_rep.length, 1);
  assert.equal(card.ext.ai_variable_enabled, true);
});

test('现行导出件：格式识别与别名命中记录', () => {
  assert.equal(detectCardFormat(SAMPLE), 'v2');
  const { card } = normalizeReviewCard(SAMPLE);
  assert.ok(card);
  // 别名表里必须能查到这三套键名
  assert.ok(FIELD_ALIASES.ppt.includes('pre_pt'));
  assert.ok(FIELD_ALIASES.ptx.includes('pretxt'));
  assert.ok(FIELD_ALIASES.desc.includes('descr'));
  assert.ok(FIELD_ALIASES.rgx_rep.includes('rrep'));
});

test('现行导出件：设置键都有映射或已登记', () => {
  const mapped = {
    anonymous: 'ianon', cov_tn: 'cover_tiny', banned_words: 'ban_wd', bg_music: 'msc',
    sc_cmds: 'shortcut_commands', sqaa: 'suggest_q_after', cvr_url: 'cvr',
    avail_not_pub: 'avail_np', cate: 'category', dcm: 'no_css_mod', modp: 'mod_pm',
    bg_mobile: 'mobile_bg', language: 'lc', ext: 'extend',
  };
  for (const [from, to] of Object.entries(mapped)) {
    assert.equal(PLATFORM_KEY_ALIASES[from], to, from + ' 应映射到 ' + to);
  }
});

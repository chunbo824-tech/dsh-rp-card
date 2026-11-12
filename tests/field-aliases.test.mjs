import test from 'node:test';
import assert from 'node:assert/strict';

import { FIELD_ALIASES, PLATFORM_KEY_ALIASES, pickField } from '../lib/core.js';
import { normalizeReviewCard, detectCardFormat, parseCardJson, buildPlatformExport } from '../lib/review.js';

/** fengyue.ai 平台随机键名组合之一的最小样本。 */
const SAMPLE = {
  app_name: '末日拘束系统',
  pre_pt: '主提示词正文',
  pretxt: '前置词正文',
  posttxt: '后置词正文',
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
  assert.equal(pickField(SAMPLE, 'ptx'), '前置词正文');
  assert.equal(pickField(SAMPLE, 'post_text'), '后置词正文');
  assert.equal(pickField(SAMPLE, 'desc'), '<div>档案页</div>');
  assert.equal(pickField(SAMPLE, 'opening_statement'), '选择一段开场白');
  assert.equal(pickField(SAMPLE, 'rgx_rep').length, 1);
  assert.equal(pickField(SAMPLE, 'wb').length, 1);
});

test('现行导出件：归一后各字段不再为空', () => {
  const { card } = normalizeReviewCard(parseCardJson(JSON.stringify(SAMPLE)));
  assert.equal(card.title, '末日拘束系统');
  assert.equal(card.ppt, '主提示词正文');
  assert.equal(card.ptx, '前置词正文');
  assert.equal(card.post_text, '后置词正文');
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
  // 自动总结设置只登记、不映射：脚本不能把它写进 v2 键，也不能当未知字段。
  assert.equal(PLATFORM_KEY_ALIASES.ai_s_config, undefined, 'ai_s_config 不应再映射到 summary_config');
});

test('随机键名：登记为已知键，不进入 alias-suggestions 候选', () => {
  const raw = {
    title: '占位', ppt: 'x', wb: [],
    smry: '简介', tag_list: [{ name: '标签' }], suggested_questions: ['问题'],
    suggested_questions_after_answer: { enabled: false }, lang: 'zh-Hans',
    block_wd: ['词'], default_msg_count: 6, cover: 'https://example.com/c.png',
    categ: 0, is_avail_np: true, dis_css_mod: false, bgmob: 'https://example.com/m.png',
    ai_s_config: { enable_status: 2 },
    preset_ch: ['未知'],
  };
  const { meta } = normalizeReviewCard(raw);
  for (const k of ['smry', 'tag_list', 'suggested_questions', 'suggested_questions_after_answer',
    'lang', 'block_wd', 'default_msg_count', 'cover', 'categ', 'is_avail_np', 'dis_css_mod', 'bgmob', 'ai_s_config']) {
    assert.ok(!meta.unknownKeys.includes(k), k + ' 应已登记为已知键');
  }
  assert.deepEqual(meta.unknownKeys, [], '本卡所有键都已登记为已知键');
});

test('随机键名：自动总结不参与导出，ai_s_config 不映射也不进 extras', () => {
  const raw = {
    title: '占位', ppt: 'x', wb: [],
    ai_s_config: { big_prompt: 'B', small_prompt: 'S', model_config: { name: 'n', provider: 'p' }, enable_status: 1 },
  };
  const { card } = normalizeReviewCard(raw);
  const built = buildPlatformExport(raw, card);
  assert.deepEqual(built.platform.summary_config, {
    big_prompt: '', model_config: { name: '', provider: '' }, small_prompt: '', enable_status: 2,
  }, '自动总结不参与导出，保持平台默认关闭骨架');
  assert.deepEqual(built.extras, [], '自动总结配置不随导入件带出（平台会读 extras，带上会变开启）');
});

test('2026-11-11 导出件：suffix_txt / bicss / ai_variable_text 能读入', () => {
  const SAMPLE_1111 = {
    app_name: '代码测试',
    pre_pt: '主提示词',
    pretxt: '前缀',
    suffix_txt: '玩家输入已结束。\n文风约束',
    descr: '<div>档案页</div>',
    bicss: '.x{color:red}',
    ai_variable_text: '变量提示',
    ai_s_config: { big_prompt: '', small_prompt: '', model_config: { name: '', provider: '' }, enable_status: 2 },
    world_bk: [],
    sum_info: '请勿打开',
  };
  assert.equal(pickField(SAMPLE_1111, 'post_text'), '玩家输入已结束。\n文风约束');
  assert.equal(pickField(SAMPLE_1111, 'built_in_css'), '.x{color:red}');
  assert.equal(pickField(SAMPLE_1111, 'ai_v_prompt'), '变量提示');
  const { card } = normalizeReviewCard(SAMPLE_1111);
  assert.equal(card.post_text, '玩家输入已结束。\n文风约束');
  assert.equal(card.built_in_css, '.x{color:red}');
  assert.equal(card.ai_v_prompt, '变量提示');
});

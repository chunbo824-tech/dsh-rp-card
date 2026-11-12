import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeReviewCard, buildPlatformExport } from '../lib/review.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures', f), 'utf8').replace(/^\uFEFF/, ''));

const on = load('platform-export-e-summary-on.json');
const off = load('platform-export-f-summary-off.json');
const roundtrip = load('platform-export-g-import-roundtrip.json');

test('自动总结开启（E）：字段读得出来，enable_status=1 且带自定义提示词', () => {
  const { card, meta } = normalizeReviewCard(on);
  assert.equal(card.ppt, 'x', 'prompt_pre 必须能读成 ppt');
  assert.equal(card.ptx, 'x');
  assert.equal(card.post_text, 'x');
  assert.equal(card.opening_statement, '選擇一段开场白');
  assert.equal(card.desc, '<div>x</div>');
  assert.equal(card.built_in_css, '/* x */');
  assert.equal(card.bg_img, 'https://catai.wiki/b92bac9e-55d7-4e2b-4c44-5f7ee5b3d200/bg', 'bgi 必须能读成桌面背景');
  assert.equal(meta.unknownKeys.length, 0, '这份导出里的键都应已登记');
  assert.equal(on.ai_summary_config.enable_status, 1);
  assert.ok(on.ai_summary_config.big_prompt.length > 0);
  assert.ok(on.ai_summary_config.small_prompt.length > 0);
});

test('自动总结关闭（F）：enable_status=2、提示词为空，内容照常读出', () => {
  const { card, meta } = normalizeReviewCard(off);
  assert.equal(card.ppt, 'x', 'prompt_pre 必须能读成 ppt');
  assert.equal(card.ptx, 'x');
  assert.equal(card.post_text, 'x');
  assert.equal(card.opening_statement, '選擇一段开场白');
  assert.equal(card.desc, '<div>x</div>');
  assert.equal(card.built_in_css, '/* x */');
  assert.equal(card.bg_img, 'https://catai.wiki/b92bac9e-55d7-4e2b-4c44-5f7ee5b3d200/bg');
  assert.equal(meta.unknownKeys.length, 0);
  assert.equal(off.ai_summary_config.enable_status, 2);
  assert.equal(off.ai_summary_config.big_prompt, '');
  assert.equal(off.ai_summary_config.small_prompt, '');
});

test('平台会读导出件里的自动总结 extras：v2 导入件必须剥掉它', () => {
  const { card } = normalizeReviewCard(on);
  const built = buildPlatformExport(on, card);
  assert.equal(built.platform.summary_config.enable_status, 2, '插件导入件强制默认关闭');
  assert.equal(built.platform.summary_config.big_prompt, '');
  assert.ok(!built.extras.includes('ai_summary_config'), 'ai_summary_config 不能作为 extras 带出（平台会读它并显示开启）');
  assert.ok(!built.extras.includes('ai_s_config'));
  assert.equal(built.platform.name, 'x');
  assert.equal(built.platform.cvr, on.cvr);
  assert.equal(built.platform.bg_img, on.bgi);
});

test('导入我们的 40 键件后（G）：自动总结保持关闭，图片/音乐/快捷指令保留', () => {
  const { card, meta } = normalizeReviewCard(roundtrip);
  assert.equal(meta.unknownKeys.length, 0, 'G 的键都应已登记');
  assert.equal(roundtrip.summary_config.enable_status, 2);
  assert.equal(roundtrip.summary_config.big_prompt, '');
  assert.equal(roundtrip.summary_config.small_prompt, '');
  assert.match(roundtrip.cover, /^https:\/\/catai\.wiki\//);
  assert.match(roundtrip.back_img, /^https:\/\/catai\.wiki\//);
  assert.match(roundtrip.bg_mobile, /^https:\/\/catai\.wiki\//);
  assert.match(roundtrip.bgmusic.tracks[0].url, /^https:\/\/bg-music\.catai\.wiki\//);
  assert.match(roundtrip.cg_bk[0].image_url, /^catai\.wiki\//);
  assert.equal(roundtrip.shortcut_cmd[0].label, '呃呃呃');
  assert.equal(roundtrip.ban_wd[0], '哈克');
  assert.equal(card.bg_img, roundtrip.back_img);
  assert.equal(card.mobile_bg, roundtrip.bg_mobile);
  const built = buildPlatformExport(roundtrip, card);
  assert.equal(built.platform.cvr, roundtrip.cover, 'cover 要能映射回 cvr');
  assert.equal(built.platform.plat_vis, roundtrip.vis_pf, 'vis_pf 要能映射回 plat_vis');
  assert.equal(built.platform.category, roundtrip.cat, 'cat 要能映射回 category');
  assert.equal(built.platform.shortcut_commands[0].label, '呃呃呃', 'shortcut_cmd 要能映射回 shortcut_commands');
  assert.equal(built.platform.summary_config.enable_status, 2);
});

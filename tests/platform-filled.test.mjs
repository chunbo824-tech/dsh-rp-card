import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeReviewCard } from '../lib/review.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures', 'platform-export-d-filled.json'), 'utf8').replace(/^\uFEFF/, ''));

test('填满后的平台导出（D）：第一部分字段全部读得出来', () => {
  const { card, meta } = normalizeReviewCard(raw);
  assert.equal(card.title, 'x');
  assert.equal(card.ppt, 'x');
  assert.equal(card.ptx, 'x', 'pre_tx 必须能读成 ptx');
  assert.equal(card.post_text, 'x');
  assert.equal(card.opening_statement, '選擇一段开场白');
  assert.equal(card.wb.length, 1);
  assert.equal(card.wb[0].key, '_or_x');
  assert.equal(card.desc, '<div>x</div>');
  assert.equal(card.built_in_css, '/* x */');
  assert.equal(card.ai_variable_tmpl, 'x');
  assert.equal(card.ai_v_prompt, 'x');
  assert.equal(card.ai_v_json, '{}');
  assert.deepEqual(card.rgx_rep, [{ group: '', scope: 1, title: 'x', is_enable: true, match_regex: 'x', replace_text: 'x', is_only_render: null }]);
  assert.equal(meta.unknownKeys.length, 0, '填满后的导出件里的键都应已登记');
  assert.equal(meta.fieldMap.ptx, 'pre_tx');
  assert.equal(meta.fieldMap.desc, 'descr');
  assert.equal(meta.fieldMap.built_in_css, 'bicss');
});

test('图片/音乐字段导出为平台 URL，不是本地路径或 base64', () => {
  for (const k of ['cvr', 'back_img', 'bg_mobile']) {
    assert.match(String(raw[k]), /^https:\/\/catai\.wiki\//, `${k} 应是平台 https URL`);
  }
  assert.match(raw.music.tracks[0].url, /^https:\/\/bg-music\.catai\.wiki\/music\//);
  assert.match(String(raw.cg_book[0].image_url), /^catai\.wiki\//, 'CG 图片 URL 不带协议头，导出时保持原样');
  assert.equal(raw.cvr_tiny, '', '封面缩略图未随导出生成');
});

test('自动总结开启时 enable_status=1，且带自定义提示词', () => {
  assert.equal(raw.ai_summary_config.enable_status, 1, '1=开启（默认空骨架是 2=关闭）');
  assert.ok(raw.ai_summary_config.big_prompt.length > 0, '大总结提示词应保留');
  assert.ok(raw.ai_summary_config.small_prompt.length > 0, '小总结提示词应保留');
});

test('平台其它结构：CG / 预设对话 / 快捷指令 / 正则', () => {
  assert.equal(raw.cg_book[0].key_mode, 'or');
  assert.deepEqual(raw.cg_book[0].key_region, ['ai']);
  assert.equal(typeof raw.cg_book[0].image_url, 'string');
  assert.equal(raw.ps_chats[0].title, '的');
  assert.equal(raw.ps_chats[0].chats[0].query, '的');
  assert.equal(raw.shortcut_commands[0].label, '呃呃呃');
  assert.equal(raw.shortcut_commands[0].command_text, '去请求');
  assert.equal(raw.regex_replaces[0].is_only_render, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeReviewCard, detectCardFormat } from '../lib/review.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures', name), 'utf8').replace(/^\uFEFF/, ''));
}

const cases = [
  {
    name: 'A',
    file: 'platform-export-a.json',
    fieldMap: {
      title: 'app_name', ppt: 'pre_prompt', ptx: 'pre_text', post_text: 'post_text',
      opening_statement: 'opening_statement', desc: 'dsc', built_in_css: 'builtCss',
      ai_variable_tmpl: 'ai_variable_tmpl', ai_v_prompt: 'ai_variable_text', ai_v_json: 'ai_v_json',
    },
  },
  {
    name: 'B',
    file: 'platform-export-b.json',
    fieldMap: {
      title: 'title', ppt: 'prpt', ptx: 'pre_text', post_text: 'posttxt',
      opening_statement: 'opening', desc: 'intro', built_in_css: 'builtCss',
      ai_variable_tmpl: 'ai_variable_template', ai_v_prompt: 'ai_variable_prompt', ai_v_json: 'ai_variable_json',
    },
  },
  {
    name: 'C',
    file: 'platform-export-c.json',
    fieldMap: {
      title: 'nm', ppt: 'prpt', ptx: 'pre_text', post_text: 'posttxt',
      opening_statement: 'greet_st', desc: 'description', built_in_css: 'built_in_css',
      ai_variable_tmpl: 'ai_variable_template', ai_v_prompt: 'ai_v_prompt', ai_v_json: 'ai_variable_json',
    },
  },
];

for (const c of cases) {
  test(`平台随机导出 ${c.name}：第一部分字段都能读出来`, () => {
    const raw = load(c.file);
    const { card, meta } = normalizeReviewCard(raw);
    assert.equal(meta.recognized, true);
    assert.equal(card.title, 'x');
    assert.equal(card.ppt, 'x', '主提示词不能读空（prpt/pre_prompt/pre_pt 都要能认）');
    assert.equal(card.ptx, 'x');
    assert.equal(card.post_text, 'x');
    assert.equal(card.opening_statement, 'x');
    assert.equal(card.wb.length, 1, '世界书不能读空（lore_bk/world_book/world_bk 都要能认）');
    assert.equal(card.wb[0].key, '_or_x');
    assert.deepEqual(card.rgx_rep, []);
    assert.equal(card.desc, '');
    assert.equal(card.built_in_css, '');
    assert.equal(card.ai_variable_tmpl, '');
    assert.equal(card.ai_v_prompt, '');
    assert.equal(card.ai_v_json, '');
    assert.deepEqual(meta.fieldMap, c.fieldMap, `${c.name} 用的同义键要与预期一致`);
    assert.equal(meta.unknownKeys.length, 0, '三份随机导出件里的键都应在字段库里登记');
  });
}

test('三份随机导出件都被识别为同一张卡（legacy 键名组合）', () => {
  for (const c of cases) {
    assert.equal(detectCardFormat(load(c.file)), 'legacy');
  }
});

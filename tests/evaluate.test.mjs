import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditCard, computeScore, evaluateAction, validateAnchors, DIMENSIONS,
} from '../lib/evaluate.js';

const all5 = () => Object.fromEntries(DIMENSIONS.map((d) => [d.id, 5]));
const all3 = () => Object.fromEntries(DIMENSIONS.map((d) => [d.id, 3]));
const evAll = () => Object.fromEntries(DIMENSIONS.map((d) => [d.id, `原文引用 ${d.id}`]));

test('档位只能取 0/1/3/5，且必须带证据', () => {
  const anchors = all5();
  anchors.F1 = 2;
  let errors = validateAnchors(anchors, evAll(), []);
  assert.ok(errors.some((e) => e.includes('档位只能取')));

  const noEv = evAll();
  delete noEv.F2;
  errors = validateAnchors(all5(), noEv, []);
  assert.ok(errors.some((e) => e.includes('缺少证据引用：F2')));

  errors = validateAnchors(all5(), evAll(), ['F1']);
  assert.ok(errors.some((e) => e.includes('不允许 N/A')));
});

test('全 5 档得满分并封顶 100', () => {
  const r = computeScore({ anchors: all5(), na: [] });
  assert.equal(r.base, 100);
  assert.equal(r.ext, 10);
  assert.equal(r.total, 100);
  assert.equal(r.grade, 'S');
});

test('全 3 档：基础 60 + 扩展 6', () => {
  const r = computeScore({ anchors: all3(), na: [] });
  assert.equal(r.base, 60);
  assert.equal(r.ext, 6);
  assert.equal(r.total, 66);
  assert.equal(r.grade, 'B');
});

test('N/A 按有效满分等比折算', () => {
  const anchors = all5();
  const r = computeScore({ anchors, na: ['S5', 'S6', 'S7', 'S8'] });
  assert.equal(r.modules.S.score, 30);
  assert.equal(r.modules.S.lowConfidence, false);
});

test('权重预设只改模块间比例', () => {
  const r = computeScore({ anchors: all3(), na: [], preset: 'gameplay' });
  assert.equal(r.modules.M.presetMax, 31);
  assert.equal(r.modules.M.score, round1(0.6 * 31));
});

function round1(n) {
  return Math.round(n * 10) / 10;
}

test('审计能抓到长前后置词、不安全正则与环境违规', () => {
  const card = {
    name: '测试卡',
    pre_prompt: 'x'.repeat(3000),
    ptx: 'y'.repeat(120),
    post_text: 'z'.repeat(120) + '<script>document.title=1</script> localStorage.setItem("a","b")',
    lore_bk: [
      { key: 'Lv.1', key_region: 4, match_type: 2, value: 'low', sort: 0, depth: 0, probability: 100 },
      { key: 'Lv.10', key_region: 4, match_type: 2, value: 'high', sort: 3, depth: 5, probability: 80 },
    ],
    rgx_rep: [
      { match_regex: '(a+)+b', replace_text: '', is_only_render: true },
      { match_regex: '\\[\\[x\\]\\]', replace_text: '<b>x</b>', is_only_render: false },
    ],
    ai_v_json: '{bad json',
    extend: { ai_variable_enabled: true },
  };
  const audit = auditCard(card, { memoryRounds: 10 });
  assert.ok(audit.metrics.prefixSuffix.length >= 240);
  assert.equal(audit.metrics.prefixSuffix.amplification, 1);
  assert.equal(audit.metrics.prefixSuffix.historyMessages, 10);
  assert.equal(audit.metrics.prefixSuffix.level, 'ok');
  assert.ok(audit.metrics.selfTrigger.collisions.some((c) => c.includes('Lv.1')));
  assert.equal(audit.metrics.render.onlyRenderTrue, 1);
  assert.equal(audit.metrics.render.onlyRenderFalse, 1);
  assert.ok(audit.metrics.render.dangerous.length >= 1);
  assert.equal(audit.metrics.dataChannel.schemaOk, false);
  assert.ok(audit.warnings.some((w) => w.code === 'ENV' && w.message.includes('<script>')));
});

test('换行+空白类嵌套量词不按灾难性回溯处理', () => {
  const audit = auditCard({
    name: '任务面板卡', pre_prompt: 'p', post_text: 's', wb: [], rgx_rep: [
      { match_regex: '【状态栏】[ \\t]*(?:\\r?\\n[ \\t]*)+\\*\\*[ \\t]*等级', replace_text: '', is_only_render: true },
    ],
  });
  assert.equal(audit.metrics.render.dangerous.length, 0);
});

test('desc 允许内联脚本、事件与外部图片；localStorage 仍视为风险', () => {
  const ok = auditCard({
    name: '前端页', pre_prompt: 'p', post_text: 's', wb: [], rgx_rep: [],
    desc: '<script>draw()</script><img src="https://example.com/a.png" onerror="this.remove()">',
  });
  assert.ok(!ok.warnings.some((w) => w.code === 'ENV' && w.where === 'desc'), 'desc 的 JS/外链不应报 ENV');

  const bad = auditCard({
    name: '前端页', pre_prompt: 'p', post_text: 's', wb: [], rgx_rep: [],
    desc: '<script>localStorage.setItem("a","b")</script>',
  });
  assert.ok(bad.warnings.some((w) => w.code === 'ENV' && w.where === 'desc' && w.message.includes('浏览器存储')));
});

test('submit 写报告，缺证据或缺档位会被拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-eval-'));
  fs.writeFileSync(path.join(dir, 'card.json'), JSON.stringify({
    name: '测试卡', pre_prompt: 'p', ptx: 'a', post_text: 'b', lore_bk: [], rgx_rep: [],
  }), 'utf8');

  assert.throws(() => evaluateAction({ action: 'submit', anchors: all5(), evidence: {} }, dir), /评分不完整/);
  assert.throws(() => evaluateAction({ action: 'submit', anchors: all5(), evidence: evAll(), gates: { G1: false } }, dir), /准入未通过/);

  const out = evaluateAction({
    action: 'submit',
    anchors: all5(),
    evidence: evAll(),
    gates: { G1: true, G2: true, G3: true },
    strengths: 's', weaknesses: 'w', advice: 'a', keep: 'k',
  }, dir);
  assert.equal(out.total, 100);
  assert.ok(fs.existsSync(path.join(dir, 'qa', 'evaluation.md')));
  const md = fs.readFileSync(path.join(dir, 'qa', 'evaluation.md'), 'utf8');
  assert.ok(md.includes('角色卡评估报告'));
  assert.ok(md.includes('工程审计'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit 在未组装时明确报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-eval-'));
  assert.throws(() => evaluateAction({ action: 'audit' }, dir), /找不到 card.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { reviewAction, readReviewState } from '../lib/review.js';
import { V2_KEY_ORDER, sha256 } from '../lib/core.js';

const dirs = [];
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-review-flow-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function rawCard(over = {}) {
  return {
    name: '上传测试卡',
    pre_prompt: '你是记录员。\n规则一。',
    ptx: '【当前状态】\n地点：X',
    post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】X',
    opening_statement: '开场',
    lore_bk: [{ group: '基础', match_type: 2, key: '_or_旧唱片', key_region: 6, value: '店里只在下雨的夜晚营业。', value_region: 1, sort: 0, depth: 0, probability: 100, enable: true }],
    desc: '<!DOCTYPE html><html><body>介绍</body></html>',
    built_in_css: '.x{color:red}',
    rgx_rep: [{ match_regex: '【正文】', replace_text: '<div class="body">$&</div>', is_enable: true, is_only_render: true }],
    ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
    extend: { ai_variable_enabled: false },
    labels: ['末日', '生存'],
    msc: { tracks: ['a.mp3'], autoplay: false },
    def_msg_cnt: 9,
    bg_img: 'https://example.com/bg.png',
    mobile_bg: 'https://example.com/m.png',
    ...over,
  };
}

function writeCard(dir, raw) {
  const file = path.join(dir, 'uploaded.json');
  fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return file;
}

test('完整流程：ingest → audit → plan → apply → export，平台设置保留', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());

  assert.equal(reviewAction({ action: 'status' }, dir).phase, 'not_started');
  assert.throws(() => reviewAction({ action: 'audit' }, dir), /还没有导入/);
  assert.throws(() => reviewAction({ action: 'plan' }, dir), /还没有导入/);
  assert.throws(() => reviewAction({ action: 'export' }, dir), /还没有导入/);

  const ing = reviewAction({ action: 'ingest', file }, dir);
  assert.equal(ing.phase, 'ingested');
  assert.equal(ing.format, 'v2');
  assert.equal(ing.title, '上传测试卡');
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/source.json')));
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/source.raw.json')));

  const aud = reviewAction({ action: 'audit' }, dir);
  assert.equal(aud.phase, 'audited');
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/audit.md')));
  assert.equal(typeof aud.summary.perTurnMin, 'number');

  const plan = reviewAction({ action: 'plan' }, dir);
  assert.equal(plan.phase, 'planned');
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/plan.md')));

  const apply = reviewAction({
    action: 'apply',
    text: JSON.stringify({ ptx: '【当前状态】\n地点：X\n玩家：X' }),
  }, dir);
  assert.equal(apply.phase, 'applied');
  assert.deepEqual(apply.changedFields, ['ptx']);
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/optimized.json')));
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/compare.md')));
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/compare.json')));
  const optimized = JSON.parse(fs.readFileSync(path.join(dir, '.card-build/review/optimized.json'), 'utf8'));
  assert.equal(optimized.title, '上传测试卡');
  assert.equal(optimized.ppt, '你是记录员。\n规则一。', '没提交的字段必须保持不变');
  assert.equal(optimized.ptx, '【当前状态】\n地点：X\n玩家：X');

  const exp = reviewAction({ action: 'export' }, dir);
  assert.equal(exp.phase, 'exported');
  assert.equal(exp.keys, V2_KEY_ORDER.length);
  const platform = JSON.parse(fs.readFileSync(path.join(dir, exp.file), 'utf8'));
  assert.deepEqual(Object.keys(platform), V2_KEY_ORDER);
  assert.equal(platform.name, '上传测试卡');
  assert.equal(platform.ptx, '【当前状态】\n地点：X\n玩家：X');
  assert.deepEqual(platform.labels, ['末日', '生存']);
  assert.deepEqual(platform.msc, { tracks: ['a.mp3'], autoplay: false });
  assert.equal(platform.def_msg_cnt, 9);
  assert.equal(platform.bg_img, 'https://example.com/bg.png');
  assert.equal(platform.mobile_bg, 'https://example.com/m.png');
  assert.ok(fs.existsSync(path.join(dir, '.card-build/review/review-report.md')));
  const report = fs.readFileSync(path.join(dir, '.card-build/review/review-report.md'), 'utf8');
  assert.match(report, /导入方法/);
  assert.match(report, /内部相对量/);
  assert.match(report, /平台按积分计费/);
  assert.match(report, /整卡覆盖/);

  assert.equal(reviewAction({ action: 'status' }, dir).phase, 'exported');
});

test('闸门：plan 需要 audit，apply 需要 plan，export 需要 apply', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  assert.throws(() => reviewAction({ action: 'plan' }, dir), /plan 必须先 audit/);
  assert.throws(() => reviewAction({ action: 'apply', text: JSON.stringify({ ptx: 'x' }) }, dir), /当前不能写入改写版/);
  assert.throws(() => reviewAction({ action: 'export' }, dir), /当前不能导出/);
});

test('改写引入新的必修问题会被拒收；force 才放行并留记录', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);

  const badPatch = JSON.stringify({
    lore_bk: [{ group: 'g', match_type: 2, key: '甲', key_region: 6, value: '新正文', enable: true }],
  });
  assert.throws(() => reviewAction({ action: 'apply', text: badPatch }, dir), /新的必修问题/);

  const forced = reviewAction({ action: 'apply', text: badPatch, force: true }, dir);
  assert.equal(forced.phase, 'applied');
  assert.equal(forced.forced, true);
  assert.ok(forced.newErrors.length >= 1);
  const state = readReviewState(dir);
  assert.equal(state.optimized.forced, true);
  assert.match(fs.readFileSync(path.join(dir, '.card-build/review/compare.md'), 'utf8'), /force/);
});

test('补丁没有可识别字段时明确报错', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  assert.throws(() => reviewAction({ action: 'apply', text: '{"foo":1}' }, dir), /没有任何可识别字段/);
});

test('手工改 source.json 会被摘要校验拦住', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  const source = path.join(dir, '.card-build/review/source.json');
  const obj = JSON.parse(fs.readFileSync(source, 'utf8'));
  obj.ppt += '（被手工改过）';
  fs.writeFileSync(source, JSON.stringify(obj, null, 2), 'utf8');
  assert.throws(() => reviewAction({ action: 'plan' }, dir), /被手工修改/);
});

test('重新 ingest 会清空下游状态，导出必须重新走流程', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  reviewAction({ action: 'apply', text: JSON.stringify({ ptx: '新前缀' }) }, dir);
  reviewAction({ action: 'export' }, dir);
  assert.equal(readReviewState(dir).phase, 'exported');

  const again = reviewAction({ action: 'ingest', file }, dir);
  assert.equal(again.phase, 'ingested');
  const state = readReviewState(dir);
  assert.equal(state.optimized, null);
  assert.equal(state.export, null);
  assert.throws(() => reviewAction({ action: 'export' }, dir), /当前不能导出/);
});

test('v2 导出遇到不认识的字段原样保留，不静默丢弃', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard({ foo_unknown: { keep: true }, type: 1, tmp_val: 'default' }));
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  reviewAction({ action: 'apply', text: JSON.stringify({ ptx: 'x' }) }, dir);
  const exp = reviewAction({ action: 'export' }, dir);
  assert.equal(exp.kind, 'v2');
  assert.ok(exp.extras.includes('foo_unknown'));
  const platform = JSON.parse(fs.readFileSync(path.join(dir, exp.file), 'utf8'));
  assert.deepEqual(platform.foo_unknown, { keep: true });
  assert.equal(platform.type, 1);
  assert.equal(platform.tmp_val, 'default');
});

test('旧版键名导出件沿用原字段名，cover/标签/背景不丢', () => {
  const dir = workspace();
  const legacy = {
    nm: '旧版卡', pre_prompt: '你是记录员。', pre_text: '旧前缀', post_tx: '【时间地点】\n时间：X\n地点：X',
    greet_st: '开场', world_book: [], inner_css: '.x{}', ai_v_template: '模板',
    ext: { ai_variable_enabled: false }, back_img: 'https://example.com/old-bg.png',
    cover: 'https://example.com/cover.png', tag_list: ['标签'], lang: 'zh-Hans',
  };
  const file = writeCard(dir, legacy);
  const ing = reviewAction({ action: 'ingest', file }, dir);
  assert.equal(ing.format, 'legacy');
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  reviewAction({ action: 'apply', text: JSON.stringify({ post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】X' }) }, dir);
  const exp = reviewAction({ action: 'export' }, dir);
  assert.equal(exp.kind, 'source');
  assert.match(exp.file, /card\.optimized\.source\.json$/);
  const platform = JSON.parse(fs.readFileSync(path.join(dir, exp.file), 'utf8'));
  assert.equal(platform.nm, '旧版卡');
  assert.equal(platform.pre_text, '旧前缀');
  assert.equal(platform.post_tx.includes('【正文】X'), true);
  assert.equal(platform.back_img, 'https://example.com/old-bg.png');
  assert.equal(platform.cover, 'https://example.com/cover.png', '未映射的封面必须原样保留');
  assert.deepEqual(platform.tag_list, ['标签'], '标签原样保留');
  assert.equal(platform.lang, 'zh-Hans');
  assert.equal(platform.ext.ai_variable_enabled, false);
  assert.equal(exp.dropped.length, 0);
  const report = fs.readFileSync(path.join(dir, '.card-build/review/review-report.md'), 'utf8');
  assert.match(report, /原导出件键名/);
});

test('记忆参数：memory_setting 直接按历史消息条数写进状态', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file, memory_setting: 20 }, dir);
  const aud = reviewAction({ action: 'audit' }, dir);
  assert.equal(aud.summary.amplification, 1);
  const state = readReviewState(dir);
  assert.equal(state.memory.rounds, 20);
  assert.equal(state.memory.source, 'memory_setting');
});

test('无法识别的内容与坏 JSON 给可执行的两条路', () => {
  const dir = workspace();
  assert.throws(() => reviewAction({ action: 'ingest', text: '{"foo":1}' }, dir), /无法识别|两条路/);
  assert.throws(() => reviewAction({ action: 'ingest', text: '{bad' }, dir), /两条路/);
  assert.throws(() => reviewAction({ action: 'ingest' }, dir), /需要卡片内容/);
});

test('status 在无状态时给出下一步', () => {
  const dir = workspace();
  const st = reviewAction({ action: 'status' }, dir);
  assert.equal(st.phase, 'not_started');
  assert.match(st.next, /ingest/);
});

test('连续 apply 基于当前优化版合并，不丢上一次改动', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  reviewAction({ action: 'apply', text: JSON.stringify({ ptx: '第一版前缀' }) }, dir);
  reviewAction({ action: 'apply', text: JSON.stringify({ post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】第二版' }) }, dir);
  const optimized = JSON.parse(fs.readFileSync(path.join(dir, '.card-build/review/optimized.json'), 'utf8'));
  assert.equal(optimized.ptx, '第一版前缀', '第二次 apply 不得把第一次的改动丢掉');
  assert.match(optimized.post_text, /第二版/);
  assert.equal(reviewAction({ action: 'status' }, dir).phase, 'applied');
});

test('补丁里 wb / rgx_rep 类型不对时明确拒绝，不静默清空', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  assert.throws(() => reviewAction({ action: 'apply', text: JSON.stringify({ lore_bk: { a: 1 } }) }, dir), /不是数组/);
  assert.throws(() => reviewAction({ action: 'apply', text: JSON.stringify({ rgx_rep: 'not-array' }) }, dir), /不是数组/);
  assert.equal(readReviewState(dir).phase, 'planned');
});

test('没有世界书字段的卡不再误报 RV007；给了非数组才报', () => {
  const dir = workspace();
  const raw = rawCard();
  delete raw.lore_bk;
  const file = writeCard(dir, raw);
  reviewAction({ action: 'ingest', file }, dir);
  const aud = reviewAction({ action: 'audit' }, dir);
  assert.equal(aud.counts.error, 0, `缺 wb 字段不应报必修：${JSON.stringify(aud.top)}`);

  const dir2 = workspace();
  const bad = rawCard({ lore_bk: { not: 'array' } });
  const file2 = writeCard(dir2, bad);
  assert.throws(() => reviewAction({ action: 'ingest', file: file2 }, dir2), /世界书字段不是数组/);
});

test('RV105 会检查全部常驻条目，不只最长的 5 条', () => {
  const dir = workspace();
  const wb = [];
  for (let i = 0; i < 8; i += 1) {
    wb.push({ group: `g${i}`, match_type: 2, key: '_or_玩家', key_region: 6, value: 'x'.repeat(700), enable: true });
  }
  const file = writeCard(dir, rawCard({ post_text: '【时间地点】\n时间：X\n地点：X\n\n玩家在此。', lore_bk: wb }));
  reviewAction({ action: 'ingest', file }, dir);
  const aud = reviewAction({ action: 'audit' }, dir);
  const audit = JSON.parse(fs.readFileSync(path.join(dir, '.card-build/review/audit.json'), 'utf8'));
  assert.equal(audit.issues.filter((i) => i.code === 'RV105').length, 8);
});

test('apply 时 audit 文件缺失给友好错误，不抛 ENOENT', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  fs.rmSync(path.join(dir, '.card-build/review/audit.json'), { force: true });
  assert.throws(() => reviewAction({ action: 'apply', text: JSON.stringify({ ptx: 'x' }) }, dir), /审计结果不存在/);
});

test('重新 ingest 会删掉旧的导出件，避免误导入', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  reviewAction({ action: 'apply', text: JSON.stringify({ ptx: '新前缀' }) }, dir);
  const exp = reviewAction({ action: 'export' }, dir);
  const exportFile = path.join(dir, exp.file);
  assert.ok(fs.existsSync(exportFile));
  reviewAction({ action: 'ingest', file }, dir);
  assert.ok(!fs.existsSync(exportFile), '重新 ingest 后旧导出件必须删掉');
  assert.ok(!fs.existsSync(path.join(dir, '.card-build/review/optimized.json')));
});

test('世界书索引位移不会把旧问题误判为新增', () => {
  const dir = workspace();
  const valid = { group: 'a', match_type: 2, key: '_or_甲', key_region: 6, value: '正常内容', enable: true };
  const invalid = { group: 'b', match_type: 3, key: '(', key_region: 6, value: '正则条目', enable: true };
  const file = writeCard(dir, rawCard({ lore_bk: [valid, invalid] }));
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  const applied = reviewAction({ action: 'apply', text: JSON.stringify({ lore_bk: [invalid] }) }, dir);
  assert.equal(applied.phase, 'applied', '同一条非法正则从 wb[2] 移到 wb[1] 不应算新增');
  const optimized = JSON.parse(fs.readFileSync(path.join(dir, '.card-build/review/optimized.json'), 'utf8'));
  assert.equal(optimized.wb.length, 1);
});

test('同位置换成另一条非法正则会算新增并被拒收', () => {
  const dir = workspace();
  const valid = { group: 'a', match_type: 2, key: '_or_甲', key_region: 6, value: '正常内容', enable: true };
  const invalid = { group: 'b', match_type: 3, key: '(', key_region: 6, value: '正则条目', enable: true };
  const file = writeCard(dir, rawCard({ lore_bk: [valid, invalid] }));
  reviewAction({ action: 'ingest', file }, dir);
  reviewAction({ action: 'audit' }, dir);
  reviewAction({ action: 'plan' }, dir);
  const otherInvalid = { ...invalid, key: '[' };
  assert.throws(
    () => reviewAction({ action: 'apply', text: JSON.stringify({ lore_bk: [valid, otherInvalid] }) }, dir),
    /新的必修问题/,
  );
});

test('未登记别名写入本机候选表，重复 ingest 会累计次数', () => {
  const dir = workspace();
  const raw = rawCard({ postxx: '【时间地点】\n时间：X\n地点：X' });
  const file = writeCard(dir, raw);
  reviewAction({ action: 'ingest', file }, dir);
  const logPath = path.join(dir, '.card-build', 'alias-suggestions.json');
  assert.ok(fs.existsSync(logPath), '应生成本机别名候选表');
  let log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const hit = log.suggestions.find((s) => s.key === 'postxx');
  assert.ok(hit, 'postxx 应被记录');
  assert.equal(hit.suggested, 'post_text');
  assert.equal(hit.count, 1);

  reviewAction({ action: 'ingest', file }, dir);
  log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  assert.equal(log.suggestions.find((s) => s.key === 'postxx').count, 2);
});

test('file 相对路径按作品目录解析', () => {
  const dir = workspace();
  const raw = rawCard();
  fs.writeFileSync(path.join(dir, 'uploaded.json'), JSON.stringify(raw), 'utf8');
  const ing = reviewAction({ action: 'ingest', file: 'uploaded.json' }, dir);
  assert.equal(ing.phase, 'ingested');
});

test('别名表变化后的旧状态会被要求重新 ingest', () => {
  const dir = workspace();
  const file = writeCard(dir, rawCard());
  reviewAction({ action: 'ingest', file }, dir);
  // 模拟旧版本按旧别名读入：source 里后缀为空，但 raw 里有原始字段
  const sourcePath = path.join(dir, '.card-build/review/source.json');
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  source.post_text = '';
  fs.writeFileSync(sourcePath, JSON.stringify(source, null, 2), 'utf8');
  const state = readReviewState(dir);
  state.source.digest = sha256(JSON.stringify(source));
  fs.writeFileSync(path.join(dir, '.card-build/review/state.json'), JSON.stringify(state, null, 2), 'utf8');
  assert.throws(() => reviewAction({ action: 'audit' }, dir), /重新 ingest/);
});

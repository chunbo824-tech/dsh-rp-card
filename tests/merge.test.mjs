import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href);
const { V2_KEY_ORDER } = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'core.js')).href);

// 假服务：验证 deliver 自动产出「单部分导入件 + 累计组装件」。
const registered = {};
const ctx = {
  effect: (fn) => fn(),
  inject: (_deps, cb) => cb(ctx),
  get: (name) => ({
    commands: { register: (d) => { registered.command = d; return () => {}; } },
    tools: { register: (d) => { registered.tool = d; return () => {}; } },
    systemPrompt: { section: (s) => { registered.prompt = s; return () => {}; } },
  })[name],
};
mod.apply(ctx);

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-merge-'));
const run = (line) => {
  const r = registered.command.handler({ rawInput: line });
  assert.equal(r.kind, 'success', `命令失败：${line} → ${r.text}`);
  return r.text;
};

const writingStage = {
  title: '雨夜咖啡馆',
  ppt: '你是店主。',
  ptx: '【当前状态】地点：咖啡馆',
  post_text: [
    '【时间地点】',
    '时间：X',
    '地点：X',
    '',
    '【正文】X',
    '',
    '【角色信息】',
    '姓名：X｜性别：X｜年龄：X｜外貌：X｜身份：X｜性格：X｜偏好：X｜禁忌：X',
    '',
    '【记忆区】',
    '短期：1. X',
    '长期：1. X',
    '',
    '【行动建议】',
    '1. X',
    '2. X',
    '3. X',
    '4. 自定义：',
  ].join('\n'),
  opening_statement: '你推门进来。',
  wb: [{ group: '基础', match_type: 2, key: '_or_旧唱片@wb@月井', key_region: 6, value_region: 1, value: '店内只在下雨的夜晚营业。', enable: true }],
  desc: '', built_in_css: '', rgx_rep: [],
  ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};

const writeStage = (name, data) => {
  const f = path.join(out, name);
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  return f;
};

run(`start --out "${out}" --title "雨夜咖啡馆" --type "日常角色扮演"`);

// 1. 交付第一部分：同时产出单部分导入件与累计组装件
const msg1 = run(`deliver --part writing --file "${writeStage('s1.json', writingStage)}"`);
assert.match(msg1, /累计组装件/);
assert.match(msg1, /可导入件（仅本部分）/);
assert.ok(fs.existsSync(path.join(out, 'part-1-writing.v2.json')), '应有单部分导入件');
const card1 = JSON.parse(fs.readFileSync(path.join(out, 'card.json'), 'utf8'));
assert.deepEqual(Object.keys(card1).sort(), [...V2_KEY_ORDER].sort(), '累计件键集合应与平台样例一致');
assert.equal(card1.name, '雨夜咖啡馆');
assert.equal(card1.pre_prompt, '你是店主。');
assert.equal(card1.lore_bk.length, 1);
assert.equal(card1.desc, '', '未交付的 profile 应为空占位');
const part1 = JSON.parse(fs.readFileSync(path.join(out, 'part-1-writing.v2.json'), 'utf8'));
assert.equal(part1.name, '雨夜咖啡馆', '单部分件保留卡名便于平台识别');
assert.equal(part1.pre_prompt, '你是店主。');
assert.equal(part1.desc, '', '单部分件不应带其它部分字段');

let state = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.deepEqual(state.merged.parts, ['writing']);
assert.deepEqual(state.merged.missing, ['profile', 'chat', 'variables']);

// 2. 第二、三部分陆续并入，累计件持续更新且不丢前面的字段
run(`pass --out "${out}" --part writing`);
run(`deliver --part profile --file "${writeStage('s2.json', { ...writingStage, desc: '<!DOCTYPE html><html></html>' })}"`);
const card2 = JSON.parse(fs.readFileSync(path.join(out, 'card.json'), 'utf8'));
assert.equal(card2.desc, '<!DOCTYPE html><html></html>');
assert.equal(card2.pre_prompt, '你是店主。', '并入新部分不能丢已有字段');
const part2 = JSON.parse(fs.readFileSync(path.join(out, 'part-2-description.v2.json'), 'utf8'));
assert.equal(part2.desc, '<!DOCTYPE html><html></html>');
assert.equal(part2.pre_prompt, '', '单部分件不应带 writing 的提示词');
run(`pass --out "${out}" --part profile`);
run(`deliver --part chat --file "${writeStage('s3.json', { ...writingStage, built_in_css: '.x{color:red}' })}"`);
const card3 = JSON.parse(fs.readFileSync(path.join(out, 'card.json'), 'utf8'));
assert.equal(card3.built_in_css, '.x{color:red}');
assert.equal(card3.desc, '<!DOCTYPE html><html></html>');

// 3. 重交付较早部分后，依赖它的 PASS 变 stale，不能继续并入（待验证的 chat 仍并入）
run(`deliver --part writing --file "${writeStage('s1b.json', writingStage)}"`);
const card4 = JSON.parse(fs.readFileSync(path.join(out, 'card.json'), 'utf8'));
assert.equal(card4.desc, '', 'stale 的 profile 不应并入');
assert.equal(card4.built_in_css, '.x{color:red}', '仍待验证的 chat 应继续并入');
state = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.deepEqual(state.merged.parts, ['writing', 'chat']);
assert.deepEqual(state.merged.stale, ['profile']);

// 4. merge 动作可手动重出，并报告缺失/过期
const merged = JSON.parse(run(`merge --out "${out}"`));
assert.equal(merged.file, 'card.json');
assert.deepEqual(merged.parts, ['writing', 'chat']);
assert.ok(merged.notes.join('\n').includes('已过期未并入'));

// 5. 未全部 PASS 时 assemble 仍拒绝
const asm = registered.command.handler({ rawInput: `assemble --out "${out}"` });
assert.equal(asm.kind, 'error');
assert.match(asm.text, /尚未取得当前版本用户 PASS/);

fs.rmSync(out, { recursive: true, force: true });
console.log('merge test passed');

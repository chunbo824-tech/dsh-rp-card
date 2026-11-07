import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href);
const { V2_KEY_ORDER } = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'core.js')).href);

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

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-playable-'));
const run = (line) => {
  const r = registered.command.handler({ rawInput: line });
  assert.equal(r.kind, 'success', `命令失败：${line} → ${r.text}`);
  return r.text;
};
const call = (line) => registered.command.handler({ rawInput: line });
const state = () => JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));

const writing = {
  title: '可玩版本测试',
  ppt: '你是守夜人。',
  ptx: '【当前状态】地点：X',
  post_text: [
    '【时间地点】', '时间：X', '地点：X', '',
    '【正文】X', '',
    '【角色信息】', '姓名：X｜性别：X｜年龄：X｜外貌：X｜身份：X｜性格：X｜偏好：X｜禁忌：X', '',
    '【记忆区】', '短期：1. X', '长期：1. X', '',
    '【行动建议】', '1. X', '2. X', '3. X', '4. 自定义：',
  ].join('\n'),
  opening_statement: '夜班开始。',
  wb: [{ group: '基础', match_type: 2, key: '_or_守夜@wb@夜班', key_region: 6, value_region: 1, value: '塔楼只在夜里运行。', enable: true }],
  desc: '', built_in_css: '', rgx_rep: [],
  ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};
const writeStage = (name, data) => {
  const f = path.join(out, name);
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
  return f;
};

run(`start --out "${out}" --title "可玩版本测试" --type "日常角色扮演"`);
run(`deliver --part writing --file "${writeStage('w.json', writing)}"`);

// 1. 前一部分未 PASS 前仍给出下一步提示
const pass1 = run(`pass --out "${out}" --part writing`);
assert.match(pass1, /第二部分/);

run(`deliver --part profile --file "${writeStage('p.json', { ...writing, desc: '<!DOCTYPE html><html></html>' })}"`);
run(`pass --out "${out}" --part profile`);

// 2. 第三部分交互仍不可跳过
const early = call(`deliver --part variables --content "{}" --out "${out}"`);
assert.equal(early.kind, 'error');

run(`deliver --part chat --file "${writeStage('c.json', { ...writing, built_in_css: '.x{color:red}' })}"`);
const pass3 = run(`pass --out "${out}" --part chat`);

// 3. 第三部分 PASS 后：可玩版本 + 三选一 + 面板按钮归属提醒
assert.match(pass3, /可玩版本/);
assert.match(pass3, /完整组装/);
assert.match(pass3, /全面评估/);
assert.match(pass3, /进入拓展功能/);
assert.match(pass3, /built_in_css/, '必须提醒面板按钮外观属于第三部分 CSS');

// 4. status 给出分支，而不是直接要求第四部分
const st = JSON.parse(run(`status --out "${out}"`));
assert.equal(st.playableReady, true);
assert.equal(st.allPassed, false);
assert.match(st.next, /branch/);
assert.equal(st.options.length, 3);

// 5. 不做第四部分也能组装：产物是可玩版本，面板字段为空
const asm = run(`assemble --out "${out}"`);
assert.match(asm, /可玩版本/);
assert.match(asm, /背景图/);
const card = JSON.parse(fs.readFileSync(path.join(out, 'card.json'), 'utf8'));
assert.deepEqual(Object.keys(card).sort(), [...V2_KEY_ORDER].sort());
assert.equal(card.pre_prompt, '你是守夜人。');
assert.equal(card.built_in_css, '.x{color:red}');
assert.equal(card.extend.ai_variable_enabled, false);
assert.equal(card.ai_variable_tmpl, '');
const report = fs.readFileSync(path.join(out, 'build-report.md'), 'utf8');
assert.match(report, /可玩版本/);
assert.match(report, /built_in_css/, '报告要写明面板按钮外观归第三部分');

// 6. 之后进入拓展功能：做完第四部分再组装即为完整版
run(`deliver --part variables --file "${writeStage('v.json', writing)}"`);
run(`pass --out "${out}" --part variables`);
const asm2 = run(`assemble --out "${out}"`);
assert.match(asm2, /完整版/);
const card2 = JSON.parse(fs.readFileSync(path.join(out, 'card.json'), 'utf8'));
assert.equal(card2.extend.ai_variable_enabled, false);

// 7. 之后再交付会刷新 card.json：之前 assemble 的 final 必须被标记为「已被取代」
assert.equal(state().final.supersededAt, undefined, '刚 assemble 完不应被标记取代');
run(`deliver --part variables --file "${writeStage('v2.json', writing)}"`);
const stAfterDeliver = JSON.parse(run(`status --out "${out}"`));
assert.equal(stAfterDeliver.finalSuperseded, true);
assert.ok(stAfterDeliver.final.supersededAt);
assert.equal(stAfterDeliver.final.supersededBy, 'deliver');

// 8. 重新 assemble 后 final 再次代表当前 card.json
run(`assemble --out "${out}"`);
const stAfterAssemble = JSON.parse(run(`status --out "${out}"`));
assert.equal(stAfterAssemble.finalSuperseded, false);

fs.rmSync(out, { recursive: true, force: true });
console.log('playable branch tests passed');

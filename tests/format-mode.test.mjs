import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href);

const registered = {};
const ctx = {
  effect: (fn) => fn(),
  inject: (_d, cb) => cb(ctx),
  get: (n) => ({
    commands: { register: (d) => { registered.command = d; return () => {}; } },
    tools: { register: (d) => { registered.tool = d; return () => {}; } },
    systemPrompt: { section: (s) => { registered.prompt = s; return () => {}; } },
  })[n],
};
mod.apply(ctx);

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-format-mode-'));
const run = (line) => {
  const r = registered.command.handler({ rawInput: line });
  assert.equal(r.kind, 'success', `命令失败：${line} → ${r.text}`);
  return String(r.text);
};
const call = (line) => registered.command.handler({ rawInput: line });
const state = () => JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));

const adult = {
  title: '成人向格式测试',
  ppt: '你是本世界的忠实记录者。本卡为成人向虚构作品，按设定推进，不回避亲密描写。\n【内容纪律】\n必须呈现：亲密关系。\n允许出现：独处场景。\n禁止出现：无。\n每轮停在玩家可接管的点，不替玩家决定。',
  ptx: '【当前状态】地点：X',
  post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】X\n\n【角色信息】\n姓名：X\n\n【记忆区】\n短期：1. X\n\n【行动建议】\n1. X\n2. X\n3. X\n4. 自定义：',
  opening_statement: '开始。',
  wb: [{ group: '基础', match_type: 2, key: '_or_夜', key_region: 6, value_region: 1, value: '夜里运行。', enable: true }],
  desc: '', built_in_css: '', rgx_rep: [], ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};
const sfw = { ...adult, ppt: '你是温柔的店主，用日常对话推进故事。', title: '普通卡' };
const w = (name, data) => { const f = path.join(out, name); fs.writeFileSync(f, JSON.stringify(data, null, 2)); return f; };

// 1. 成人向卡第一部分交付后必须先选择，未选择不能 PASS
run(`start --out "${out}" --title 成人向格式测试`);
const d1 = JSON.parse(run(`deliver --part writing --file "${w('w.json', adult)}"`));
assert.match(d1.message, /是否将美化代码内置到第一部分的提示词内/, '必须给出选择询问');
assert.match(d1.message, /可部分改善ai输出截断问题，缺点，增加token消耗，且ai有输出错误的可能性/, '必须原样说明优缺点');
let st = state();
assert.equal(st.adultContent, true);
assert.equal(st.formatChoice, 'pending');
assert.equal(call(`pass --out "${out}" --part writing`).kind, 'error', '未作选择前 PASS 应被阻止');
assert.match(call(`pass --out "${out}" --part writing`).text, /format-mode/);

// 2. 选择 semantic：第一部分转待修订，顺序变为 writing → chat → profile
run(`format-mode --mode semantic --out "${out}"`);
st = state();
assert.equal(st.formatChoice, 'semantic');
assert.deepEqual(st.flowOrder, ['writing', 'chat', 'profile', 'variables']);
assert.deepEqual(st.dependencies.chat, ['writing']);
assert.deepEqual(st.dependencies.profile, ['writing', 'chat']);
assert.equal(st.parts.writing.status, 'needs_revision');
assert.equal(st.design.parts.writing.status, 'pending');
assert.equal(st.design.parts.chat.status, 'pending');

// 3. 第一部分重写并 PASS 后，下一步是第三部分
const plan = path.join(out, 'plan.md');
fs.writeFileSync(plan, '# 联合设计：输出格式 + 聊天样式\n', 'utf8');
run(`propose --part writing --out "${out}" --file "${plan}"`);
run(`approve-design --part writing --out "${out}"`);
run(`deliver --part writing --file "${w('w2.json', adult)}"`);
run(`pass --out "${out}" --part writing`);
st = state();
assert.equal(st.currentPart, 'chat');
assert.match(run(`status --out "${out}"`), /第三部分/);
// 第二部分此时不能提前交付
assert.equal(call(`deliver --part profile --file "${w('p.json', { ...adult, desc: '<!DOCTYPE html><html></html>' })}"`).kind, 'error');

// 4. 第三部分同样走方案审批，PASS 后才允许第二部分
run(`propose --part chat --out "${out}" --file "${plan}"`);
run(`approve-design --part chat --out "${out}"`);
run(`deliver --part chat --file "${w('c.json', { ...adult, built_in_css: '.x{color:red}' })}"`);
run(`pass --out "${out}" --part chat`);
st = state();
assert.equal(st.currentPart, 'profile');
const d2 = run(`deliver --part profile --file "${w('p2.json', { ...adult, desc: '<!DOCTYPE html><html></html>' })}"`);
assert.match(d2, /第二部分/);

// 5. 普通卡不触发选择，直接按常规顺序
{
  const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-format-sfw-'));
  const run2 = (line) => {
    const r = registered.command.handler({ rawInput: line });
    assert.equal(r.kind, 'success', `命令失败：${line} → ${r.text}`);
    return String(r.text);
  };
  const f = path.join(out2, 'w.json');
  fs.writeFileSync(f, JSON.stringify(sfw), 'utf8');
  run2(`start --out "${out2}" --title 普通卡`);
  const dd = run2(`deliver --part writing --file "${f}"`);
  assert.ok(!/是否将美化代码内置/.test(dd), '普通卡不应询问格式方案');
  const st2 = JSON.parse(fs.readFileSync(path.join(out2, '.card-build', 'state.json'), 'utf8'));
  assert.equal(st2.adultContent, false);
  assert.equal(st2.formatChoice, 'standard');
  assert.deepEqual(st2.flowOrder, ['writing', 'profile', 'chat', 'variables']);
  fs.rmSync(out2, { recursive: true, force: true });
}

// 6. 普通卡调用 format-mode 应被拒绝
{
  const out3 = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-format-deny-'));
  const f = path.join(out3, 'w.json');
  fs.writeFileSync(f, JSON.stringify(sfw), 'utf8');
  registered.command.handler({ rawInput: `start --out "${out3}" --title 普通卡` });
  registered.command.handler({ rawInput: `deliver --part writing --file "${f}"` });
  const r = registered.command.handler({ rawInput: `format-mode --mode semantic --out "${out3}"` });
  assert.equal(r.kind, 'error');
  assert.match(r.text, /只用于成人向卡/);
  fs.rmSync(out3, { recursive: true, force: true });
}

fs.rmSync(out, { recursive: true, force: true });
console.log('format mode tests passed');

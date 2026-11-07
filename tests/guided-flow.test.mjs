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

const run = (line) => registered.command.handler({ rawInput: line });
const ok = (line) => { const r = run(line); assert.equal(r.kind, 'success', `${line} → ${r.text}`); return String(r.text); };
const fail = (line) => { const r = run(line); assert.equal(r.kind, 'error', `应当失败：${line} → ${r.text}`); return String(r.text); };
const stateOf = (out) => JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));

const stage = {
  title: '引导流程测试', ppt: '你是叙事者。', ptx: '【当前状态】· 时间：X',
  post_text: [
    '【时间地点】', '时间：X', '地点：X', '',
    '【正文】X', '',
    '【角色信息】', '姓名：X', '',
    '【记忆区】', '短期：1. X', '',
    '【行动建议】', '1. X', '2. X', '3. X', '4. 自定义：',
  ].join('\n'),
  opening_statement: '开始。',
  wb: [{ group: '基础', match_type: 2, key: '_or_守夜', key_region: 6, value_region: 1, value: '夜里运行。', enable: true }],
  desc: '', built_in_css: '', rgx_rep: [], ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};

const writeStage = (out, data = stage) => {
  const f = path.join(out, 'stage.json');
  fs.writeFileSync(f, JSON.stringify(data), 'utf8');
  return f;
};

// 1. 明确需求：默认 start，不需要方案审批即可交付
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guided-clear-'));
  ok(`start --out "${out}" --design clear --title 清晰需求`);
  const st = stateOf(out);
  assert.equal(st.design.phase, 'approved');
  assert.equal(st.design.parts.writing.status, 'approved');
  const d = JSON.parse(ok(`deliver --part writing --out "${out}" --file "${writeStage(out)}"`));
  assert.match(d.message, /已交付并停止/);
  fs.rmSync(out, { recursive: true, force: true });
}

// 2. 模糊需求：start design=brainstorm，方案未批不能交付
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guided-brainstorm-'));
  const msg = ok(`start --out "${out}" --design brainstorm --request "做一个末世卡"`);
  assert.match(msg, /头脑风暴/);
  let st = stateOf(out);
  assert.equal(st.design.phase, 'brainstorming');
  assert.equal(st.design.parts.writing.status, 'pending');

  const blocked = fail(`deliver --part writing --out "${out}" --file "${writeStage(out)}"`);
  assert.match(blocked, /设计方案还没审批/);

  // 2a. 记录方案 → 仍是待审批
  const proposal = path.join(out, 'plan.md');
  fs.writeFileSync(proposal, '# 第一部分方案\n- 生存 + 关系双线\n', 'utf8');
  ok(`propose --part writing --out "${out}" --file "${proposal}"`);
  st = stateOf(out);
  assert.equal(st.design.parts.writing.status, 'pending');
  assert.ok(fs.existsSync(path.join(out, '00-design-writing.md')));
  assert.match(fail(`deliver --part writing --out "${out}" --file "${writeStage(out)}"`), /设计方案还没审批/);

  // 2b. 用户确认 → 放行
  ok(`approve-design --part writing --out "${out}"`);
  st = stateOf(out);
  assert.equal(st.design.parts.writing.status, 'approved');
  assert.equal(st.design.phase, 'approved');
  const d = JSON.parse(ok(`deliver --part writing --out "${out}" --file "${writeStage(out)}"`));
  assert.match(d.message, /已交付并停止/);

  // 2c. status 暴露方案状态
  const status = JSON.parse(ok(`status --out "${out}"`));
  assert.equal(status.design.parts.writing.status, 'approved');
  fs.rmSync(out, { recursive: true, force: true });
}

// 3. 后续部分同样先方案后交付
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guided-part2-'));
  ok(`start --out "${out}" --design clear --title 分段方案`);
  ok(`deliver --part writing --out "${out}" --file "${writeStage(out)}"`);
  ok(`pass --out "${out}" --part writing`);

  // 直接交付第二部分 → 没有方案记录时按默认放行（向后兼容）
  const profileStage = path.join(out, 'profile.json');
  fs.writeFileSync(profileStage, JSON.stringify({ ...stage, desc: '<!DOCTYPE html><html></html>' }), 'utf8');
  ok(`deliver --part profile --out "${out}" --file "${profileStage}"`);
  ok(`pass --out "${out}" --part profile`);

  // 第三部分：先 propose，未批不能交付
  const proposal = path.join(out, 'plan-chat.md');
  fs.writeFileSync(proposal, '# 第三部分方案\n- 聊天气泡 + 【时间地点】容器\n', 'utf8');
  ok(`propose --part chat --out "${out}" --file "${proposal}"`);
  assert.match(fail(`deliver --part chat --out "${out}" --file "${writeStage(out, { ...stage, built_in_css: '.x{}' })}"`), /设计方案还没审批/);
  ok(`approve-design --part chat --out "${out}"`);
  ok(`deliver --part chat --out "${out}" --file "${writeStage(out, { ...stage, built_in_css: '.x{}' })}"`);
  fs.rmSync(out, { recursive: true, force: true });
}

// 4. propose 缺内容时报错
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-guided-empty-'));
  ok(`start --out "${out}" --design clear`);
  assert.match(fail(`propose --part writing --out "${out}"`), /需要方案内容/);
  fs.rmSync(out, { recursive: true, force: true });
}

console.log('guided flow tests passed');

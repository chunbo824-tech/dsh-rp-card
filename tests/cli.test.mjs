import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.js')).href);
const { V2_KEY_ORDER } = await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'core.js')).href);

// 用即时可用的假服务验证命令处理链路（start/template/deliver/pass/assemble）。
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
assert.ok(registered.command && registered.tool && registered.prompt, '三类资源都应注册');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cli-'));
const run = (line) => {
  const r = registered.command.handler({ rawInput: line });
  assert.equal(r.kind, 'success', `命令失败：${line} → ${r.text}`);
  return r.text;
};

// 1. start 只建工作区，不伪造待验证产物
run(`start --out "${out}" --title "雨夜咖啡馆" --type "日常角色扮演" --platform "SillyTavern" --brief "测试构思"`);
const state1 = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.equal(state1.parts.writing.status, 'generating');
assert.equal(state1.title, '雨夜咖啡馆');
assert.ok(fs.existsSync(path.join(out, '00-work-order.md')));
const analysis = fs.readFileSync(path.join(out, '00-requirement-analysis.md'), 'utf8');
for (const needle of ['需求预处理', '需求 → 四部分归属', '框架补齐', '关键假设', '功能一致性自检', '唯一归属', '不重复实现', '硬约束不被改写']) {
  assert.ok(analysis.includes(needle), `需求预处理模板缺少小节：${needle}`);
}
assert.ok(!fs.existsSync(path.join(out, 'part-1-writing.json')), 'start 不应生成阶段 JSON');

// 2. template 写骨架
run(`template --part writing --out "${out}"`);
const skeletonPath = path.join(out, '.card-build', 'template-part-1-writing.json');
assert.ok(fs.existsSync(skeletonPath));

// 3. deliver 空骨架应被拦截，且不得落盘任何产物
const empty = run(`deliver --part writing --file "${skeletonPath}"`);
assert.match(empty, /未通过交付检查/);
assert.equal(JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8')).parts.writing.status, 'needs_revision');
assert.ok(!fs.existsSync(path.join(out, 'part-1-writing.json')), '校验失败不得写入阶段 JSON');
assert.ok(!fs.existsSync(path.join(out, '01-writing.md')), '校验失败不得写入源文件');

// 3b. needs_revision 不能直接 PASS（否则会出现无产物的 PASS）
const badPassFromRevision = registered.command.handler({ rawInput: `pass --out "${out}" --part writing` });
assert.equal(badPassFromRevision.kind, 'error');
assert.match(badPassFromRevision.text, /当前部分不能 PASS：第一部分/);

// 4. 填好内容后交付通过
const stage = {
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
  wb: [{
    group: '基础', match_type: 2, key: '_or_旧唱片@wb@月井', key_region: 6,
    value_region: 1, value: '店内只在下雨的夜晚营业。', depth: 3, enable: true,
  }],
  desc: '', built_in_css: '', rgx_rep: [],
  ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};
fs.writeFileSync(skeletonPath, JSON.stringify(stage, null, 2), 'utf8');

// 4a. 触发词出现在前缀词/后置词中必须被拦（否则会变成每轮误触发的常驻条目）
const overlap = JSON.parse(JSON.stringify(stage));
overlap.wb[0].key = '_or_咖啡馆@wb@旧唱片';
fs.writeFileSync(skeletonPath, JSON.stringify(overlap, null, 2), 'utf8');
const overlapText = run(`deliver --part writing --file "${skeletonPath}"`);
assert.match(overlapText, /未通过交付检查/);
assert.match(overlapText, /CUE007/);

fs.writeFileSync(skeletonPath, JSON.stringify(stage, null, 2), 'utf8');
const okText = run(`deliver --part writing --file "${skeletonPath}"`);
assert.match(okText, /已交付并停止/);
const state2 = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.equal(state2.parts.writing.status, 'awaiting_user_validation');
assert.ok(fs.existsSync(path.join(out, '01-writing.md')));
assert.ok(fs.existsSync(path.join(out, 'part-1-writing.json')));

// 4b. 交付后可单独导出该部分的平台格式（供该部分人工平台验证）
const exp = JSON.parse(run(`export --part writing --format v2 --out "${out}"`));
assert.equal(exp.format, 'v2');
assert.ok(fs.existsSync(path.join(out, exp.file)));
const exported = JSON.parse(fs.readFileSync(path.join(out, exp.file), 'utf8'));
assert.deepEqual(Object.keys(exported).sort(), [...V2_KEY_ORDER].sort(), '导出件键集合应与平台样例一致');
assert.equal(exported.name, '雨夜咖啡馆');
assert.equal(exported.pre_prompt, '你是店主。');
assert.equal(exported.lore_bk.length, 1);

// 4c. 未交付的部分不能导出
const notDelivered = registered.command.handler({ rawInput: `export --part chat --out "${out}"` });
assert.equal(notDelivered.kind, 'error');
assert.match(notDelivered.text, /尚未交付/);

// 5. 前置未 PASS 时不能交付后续部分
const blocked = registered.command.handler({ rawInput: `deliver --part chat --content "{}" --out "${out}"` });
assert.equal(blocked.kind, 'error');
assert.match(blocked.text, /前置部分必须先取得真实 PASS/);

// 6. 未全部 PASS 时不能组装
const asm = registered.command.handler({ rawInput: `assemble --out "${out}"` });
assert.equal(asm.kind, 'error');
assert.match(asm.text, /尚未取得当前版本用户 PASS/);

// 7. PASS 后进入下一部分
run(`pass --out "${out}" --part writing`);
const state3 = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.equal(state3.parts.writing.status, 'pass');
assert.equal(state3.currentPart, 'profile');

// 8. 手工改动已 PASS 文件 → 摘要失效
fs.appendFileSync(path.join(out, 'part-1-writing.json'), '\n', 'utf8');
run(`status --out "${out}"`);
const state4 = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.equal(state4.parts.writing.status, 'needs_revision', '摘要不一致应使 PASS 失效');

// 9. 重新交付较早部分 → 后续部分基于旧内容的 PASS 必须失效
run(`deliver --part writing --file "${skeletonPath}"`);
run(`pass --out "${out}" --part writing`);
const profileStage = path.join(out, 'stage-profile.json');
fs.writeFileSync(profileStage, JSON.stringify({ ...stage, desc: '<!DOCTYPE html><html></html>' }, null, 2), 'utf8');
run(`deliver --part profile --file "${profileStage}"`);
run(`pass --out "${out}" --part profile`);
let s9 = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.equal(s9.parts.profile.status, 'pass');
run(`deliver --part writing --file "${skeletonPath}"`);
s9 = JSON.parse(fs.readFileSync(path.join(out, '.card-build', 'state.json'), 'utf8'));
assert.equal(s9.parts.profile.status, 'stale', '重新交付 writing 后 profile 的 PASS 必须变为 stale');

// 10. 非法部分与不可 PASS 状态给出可读错误
const badPart = registered.command.handler({ rawInput: `pass --out "${out}" --part nonexistent` });
assert.equal(badPart.kind, 'error');
assert.match(badPart.text, /未知部分/);
const badPass = registered.command.handler({ rawInput: `pass --out "${out}" --part chat` });
assert.equal(badPass.kind, 'error');
assert.match(badPass.text, /当前部分不能 PASS：第三部分/);

// 11. 省略 out 时落在当前工作目录；平台默认 fengyue.ai；类型默认 auto；request 原样保存
const originCwd = process.cwd();
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ws-'));
process.chdir(ws);
try {
  const text = run('start --request "做一个赛博朋克高塔电梯里的守夜人"');
  assert.match(text, /fengyue\.ai/);
  const wsState = JSON.parse(fs.readFileSync(path.join(ws, '.card-build', 'state.json'), 'utf8'));
  assert.equal(wsState.platform, 'fengyue.ai');
  assert.equal(wsState.type, 'auto');
  assert.equal(wsState.brief, '做一个赛博朋克高塔电梯里的守夜人');
  assert.ok(fs.existsSync(path.join(ws, '00-work-order.md')));
  assert.equal(wsState.parts.writing.status, 'generating');
} finally {
  process.chdir(originCwd);
}

console.log('cli flow test passed');

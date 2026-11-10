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

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-tail-'));
const run = (line) => {
  const r = registered.command.handler({ rawInput: line });
  assert.equal(r.kind, 'success', `命令失败：${line} → ${r.text}`);
  return String(r.text);
};
const lastLine = (text) => text.trimEnd().split('\n').pop();
const messageOf = (json) => JSON.parse(json).message;

const writing = {
  title: '收尾格式测试',
  ppt: '你是守夜人。',
  ptx: '【当前状态】地点：X',
  post_text: '【时间地点】\n时间：X\n地点：X\n\n【正文】X\n\n【角色信息】\n姓名：X\n\n【记忆区】\n短期：1. X\n\n【行动建议】\n1. X\n2. X\n3. X\n4. 自定义：',
  opening_statement: '开始。',
  wb: [{ group: '基础', match_type: 2, key: '_or_守夜', key_region: 6, value_region: 1, value: '夜里运行。', enable: true }],
  desc: '', built_in_css: '', rgx_rep: [], ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false },
};
const w = (name, data) => { const f = path.join(out, name); fs.writeFileSync(f, JSON.stringify(data, null, 2)); return f; };

run(`start --out "${out}" --title 收尾格式测试`);

// 1. 第一部分交付：给下一部分入口，末行用部分名提示 PASS
const d1 = messageOf(run(`deliver --part writing --file "${w('w.json', writing)}"`));
assert.match(d1, /第二部分/, '应主动给出下一部分的想法入口');
assert.equal(lastLine(d1), '当前待确认：第一部分：写卡正文。确认后回复「第一部分：写卡正文 PASS」', '末行用部分名给出 PASS 提示');

// 2. 第二部分交付：问第三部分想法；仍有临时 URL 资源时要提醒回填
fs.mkdirSync(path.join(out, '.card-build'), { recursive: true });
fs.writeFileSync(path.join(out, '.card-build', 'assets.json'), JSON.stringify({
  version: 1,
  assets: [
    { id: 'bg-01', type: 'background_image', name: '审讯室-桌面', localFile: 'assets/bg-01.png', placement: 'desc 序章审讯室背景', mime: 'image/png', remoteUrlSource: 'provider-temporary' },
    { id: 'icon-02', type: 'icon_svg', mime: 'image/svg+xml', remoteUrlSource: 'provider-temporary' },
  ],
}, null, 2));
run(`pass --out "${out}" --part writing`);
const d2raw = run(`deliver --part profile --file "${w('p.json', { ...writing, desc: '<!DOCTYPE html><html><body><input placeholder="说点什么"><button>发送</button></body></html>' })}"`);
const d2 = messageOf(d2raw);
const d2res = JSON.parse(d2raw);
assert.ok(d2res.diagnostics.some((x) => x.id === 'OWN002'), 'desc 内输入框+发送语义要提示越界');
assert.match(d2, /第三部分/, '应主动给出第三部分的想法入口');
assert.match(d2, /图像资源待回填/, '有临时 URL 资源时必须提醒');
assert.match(d2, /bg-01/, '要点名具体资源');
assert.match(d2, /审讯室-桌面/, '要给出图片名');
assert.match(d2, /assets[\\/]bg-01\.png/, '要给出本地文件位置');
assert.match(d2, /待复制的图片名清单/, '要给出可直接复制的图片名清单');
assert.ok(!/icon-02/.test(d2), '矢量内嵌资源不该被当成待回填');
assert.equal(lastLine(d2), '当前待确认：第二部分：初始化档案页。确认后回复「第二部分：初始化档案页 PASS」');

// 3. 第三部分交付：不问第四部分想法，末行保留 PASS 提示
run(`pass --out "${out}" --part profile`);
const d3 = messageOf(run(`deliver --part chat --file "${w('c.json', { ...writing, built_in_css: '.x{color:red}' })}"`));
assert.ok(!/对第四部分/.test(d3), '第三部分不应在此询问面板想法');
assert.match(d3, /可选拓展/);
assert.equal(lastLine(d3), '当前待确认：第三部分：聊天页 CSS 与正则。确认后回复「第三部分：聊天页 CSS 与正则 PASS」');

// 4. 第四部分交付：末行 PASS 提示，且不再有下一部分提问
run(`pass --out "${out}" --part chat`);
const d4 = messageOf(run(`deliver --part variables --file "${w('v.json', writing)}"`));
assert.equal(lastLine(d4), '当前待确认：第四部分：变量面板。确认后回复「第四部分：变量面板 PASS」');

fs.rmSync(out, { recursive: true, force: true });
console.log('delivery tail tests passed');

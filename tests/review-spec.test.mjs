import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const mod = await import(pathToFileURL(path.join(root, 'index.js')).href);
const core = await import(pathToFileURL(path.join(root, 'lib', 'core.js')).href);
const review = await import(pathToFileURL(path.join(root, 'lib', 'review.js')).href);

let prompt = '';
const tools = {};
const commands = {};
const ctx = {
  effect: (fn) => fn(),
  inject: (_deps, cb) => cb(ctx),
  get: (name) => ({
    commands: { register: (d) => { commands[d.name] = d; return () => {}; } },
    tools: { register: (d) => { tools[d.name] = d; return () => {}; } },
    systemPrompt: { section: (s) => { prompt = s.text; return () => {}; } },
  })[name],
};
mod.apply(ctx);

// 1. 系统提示词必须把上传卡流程与四部分流程区分开
assert.match(prompt, /## 上传自制卡的评估与优化（工具 card_review \/ 命令 \/card-review）/, '提示词必须有上传卡章节');
for (const step of ['ingest', 'audit', 'plan', 'apply', 'export']) {
  assert.ok(prompt.includes(`\`${step}\``), `提示词必须写出步骤 ${step}`);
}
assert.match(prompt, /不要走 card_build 四部分流程/, '必须禁止误走四部分流程');
assert.match(prompt, /上传卡评估\.md/, '必须指向补充材料');
assert.match(prompt, /1-写卡提示词\.txt/, '必须引用第一部分规范');
assert.match(prompt, /4-变量面板\.txt/, '必须引用变量面板规范');
assert.match(prompt, /角色卡评估框架\.md/, '必须引用评估框架');
assert.match(prompt, /体量是内部相对量/, '必须说明体量是内部相对量');
assert.match(prompt, /不宣称具体 token 或积分数字|无法估算真实消耗/, '不得宣称平台消耗数字');
assert.match(prompt, /不得声称平台已验证|不要把审计结论说成「平台已验证」/, '不得伪造平台验证');
assert.match(prompt, /整卡覆盖/, '必须提醒整卡覆盖');
assert.match(prompt, /用户明确同意/, 'apply 前必须用户同意');

// 2. 版本与更新记录
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.version, '1.7.0');
assert.equal(core.FLOW_VERSION, '1.7.0');
assert.ok(pkg.files.includes('lib/**'), 'lib/** 必须在打包白名单里');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
assert.ok(changelog.includes('## 1.7.0'));
assert.ok(!changelog.includes('## 1.7.1'), '版本号回到 1.7.0，不应残留 1.7.1 小节');
assert.ok(changelog.includes('card_review'));

// 3. 补充材料必须给出闸门、口径与改写边界
const docPath = path.join(root, 'docs', 'supplements', '上传卡评估.md');
assert.ok(fs.existsSync(docPath), '缺少上传卡评估补充材料');
const doc = fs.readFileSync(docPath, 'utf8');
for (const needle of ['status → ingest', '闸门', 'RV104', 'RV228', 'RV229', 'RV232', 'RV233', 'RV234', '体量单位 ≈', '内部相对量', '规范依据', 'lib/core.js', 'lib/evaluate.js', '整卡覆盖', 'force', '改写守则']) {
  assert.ok(doc.includes(needle), `补充材料缺少：${needle}`);
}
const supReadme = fs.readFileSync(path.join(root, 'docs', 'supplements', 'README.md'), 'utf8');
assert.ok(supReadme.includes('上传卡评估.md'));
const writingDoc = fs.readFileSync(path.join(root, 'docs', '1-写卡提示词.txt'), 'utf8');
assert.ok(writingDoc.includes('子集关系天然覆盖'), '写卡规范必须保留子集覆盖规则');
assert.ok(writingDoc.includes('同一 key 内不要同时写子集词与父级词'), '写卡规范必须写明父子词不并存的规则');

// 4. 工具动作与实现同源
assert.deepEqual(review.REVIEW_ACTIONS, ['status', 'ingest', 'audit', 'plan', 'apply', 'export']);
assert.ok(review.REVIEW_DIR.endsWith('review'));

// 5. README 面向用户写清入口
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
assert.ok(readme.includes('card_review'));
assert.ok(readme.includes('上传自己的卡'));
assert.ok(readme.includes('card.optimized.v2.json'));
assert.ok(readme.includes('体量是内部相对量') || readme.includes('内部相对量'));

console.log('review spec tests passed');

test('card_review 工具与 card-review 命令端到端可跑通', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-review-spec-'));
  try {
    assert.ok(tools.card_review, '必须注册 card_review 工具');
    assert.ok(commands['card-review'], '必须注册 card-review 命令');

    const st = JSON.parse(await tools.card_review.execute({ action: 'status', out: dir }).then((r) => r.output));
    assert.equal(st.phase, 'not_started');

    const cardPath = path.join(dir, 'uploaded.json');
    fs.writeFileSync(cardPath, JSON.stringify({
      name: '工具链卡',
      pre_prompt: '你是记录员，按世界规则记录。',
      ptx: '【当前状态】地点：X',
      post_text: '【时间地点】\n时间：X\n地点：X',
      lore_bk: [],
      extend: { ai_variable_enabled: false },
    }), 'utf8');

    const ing = await tools.card_review.execute({ action: 'ingest', out: dir, file: cardPath });
    assert.equal(ing.ok, true, ing.output);
    assert.equal(JSON.parse(ing.output).phase, 'ingested');

    // 命令入口：--memory-rounds 必须真正生效（键名 - 与 _ 等价）
    const cmdAudit = commands['card-review'].handler({ rawInput: `audit --out "${dir}" --memory-rounds 9` });
    assert.equal(cmdAudit.kind, 'success', cmdAudit.text);
    const afterCmd = JSON.parse(await tools.card_review.execute({ action: 'status', out: dir }).then((r) => r.output));
    assert.equal(afterCmd.memory.rounds, 9);
    assert.equal(afterCmd.phase, 'audited');

    const aud = await tools.card_review.execute({ action: 'audit', out: dir });
    assert.equal(aud.ok, true, aud.output);
    assert.equal(JSON.parse(aud.output).phase, 'audited');

    const plan = await tools.card_review.execute({ action: 'plan', out: dir });
    assert.equal(plan.ok, true, plan.output);

    const apply = await tools.card_review.execute({
      action: 'apply', out: dir, text: JSON.stringify({ ptx: '【当前状态】地点：X\n玩家：X' }),
    });
    assert.equal(apply.ok, true, apply.output);

    const exp = await tools.card_review.execute({ action: 'export', out: dir });
    assert.equal(exp.ok, true, exp.output);
    const expData = JSON.parse(exp.output);
    assert.equal(expData.phase, 'exported');
    assert.ok(fs.existsSync(path.join(dir, expData.file)));

    const cmd = commands['card-review'].handler({ rawInput: `status --out "${dir}"` });
    assert.equal(cmd.kind, 'success');
    assert.equal(JSON.parse(cmd.text).phase, 'exported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

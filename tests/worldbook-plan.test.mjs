import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintStageJson, loadWbPlan, lintWorldbookPlan, WB_BUDGET_TOTAL, WB_BUDGET_PROFILES, detectComplexity } from '../lib/core.js';

const post = [
  '【时间地点】', '时间：X', '地点：X', '',
  '【正文】X', '',
  '【命运】', '赐福：X｜模式：X', '',
  '【状态】', '▸ 事件：IDLE / CONTINUE / END', '',
  '【角色信息】', '姓名：X', '',
  '【记忆区】', '短期：1. X', '',
  '【行动建议】', '1. X', '2. X', '3. X', '4. 自定义：',
].join('\n');

const entry = (key, value, match_type = 2, extra = {}) => ({
  group: '运行规则', match_type, key, key_region: 6, value_region: 1,
  value, depth: 0, probability: 100, enable: true, ...extra,
});

const residentWb = [
  entry('_or_游戏模式@wb@剧情模式@wb@任务模式', '路由：游戏模式/剧情模式/任务模式 各有细则。兜底按剧情模式处理。'),
  entry('_or_模式', '判定总则：1d20 加属性对 DC。'),
  entry('_or_END', '结算：事件结束后的数值结算表。'),
  entry('_or_IDLE', '空闲兜底：无事件时的日常规则。'),
];

const plan = {
  version: 1,
  entries: [
    { index: 1, 职责: '路由', 激活: '枚举锚', 载体: 'wb', anchorSource: 'post:模式' },
    { index: 2, 职责: '规则', 激活: '枚举锚', 载体: 'wb', anchorSource: 'post:模式' },
    { index: 3, 职责: '控制词', 激活: '控制锚', 载体: 'wb', anchorSource: 'control:END' },
    { index: 4, 职责: '规则', 激活: '控制锚', 载体: 'wb', anchorSource: 'control:IDLE' },
  ],
};

const stage = (over = {}) => ({
  title: '测试卡', ppt: '你是叙事者。', ptx: '【当前状态】· 时间：X', post_text: post,
  opening_statement: '开始。', wb: residentWb.map((e) => ({ ...e })),
  desc: '', built_in_css: '', rgx_rep: [], ai_variable_tmpl: '', ai_v_prompt: '', ai_v_json: '',
  ext: { ai_variable_enabled: false }, ...over,
});

const ids = (diag) => diag.map((x) => x.id);
const withPlan = (s, p) => lintStageJson('writing', s, { plan: p });

// 0. 合规基线：除标签外的内容错误不应出现
const base = withPlan(stage(), plan);
for (const id of ['WB101', 'WB103', 'WB105', 'WB106', 'WB107', 'WB109']) {
  assert.ok(!ids(base).includes(id), `基线不该报 ${id}：${JSON.stringify(base.filter((x) => x.id === id))}`);
}

// 1. 无 wb-plan：向后兼容，不做标签校验
assert.ok(!ids(lintStageJson('writing', stage())).some((id) => id.startsWith('WB1')), '无 plan 时不应出现 WB1xx');

// 2. WB101 缺标签
const noLabel = withPlan(stage(), { version: 1, entries: [] });
assert.ok(ids(noLabel).includes('WB101'));

// 3. WB102 预算超限（简单卡：单条 600 / 合计 800）
const huge = stage();
huge.wb[2].value = '结'.repeat(WB_BUDGET_TOTAL + 1);
assert.ok(ids(withPlan(huge, plan)).includes('WB102'));

// 3b. 复杂卡放宽到单条 900 / 合计 1600
{
  const makeWb = (residentLen) => Array.from({ length: 24 }, (_, i) => entry(
    '_or_测试',
    i === 0 ? '结'.repeat(residentLen) : '测试正文',
  ));
  const makePlan = (wb) => ({
    version: 1,
    entries: wb.map((_, i) => (i === 0
      ? { index: 1, 职责: '规则', 激活: '格式标记锚', 载体: 'wb', anchorSource: 'control:END' }
      : { index: i + 1, 职责: '知识', 激活: '内容锚', 载体: 'wb' })),
  });
  const wb800 = makeWb(800);
  const plan800 = makePlan(wb800);
  assert.ok(!ids(lintStageJson('writing', stage({ wb: wb800 }), { plan: plan800 })).includes('WB102'),
    '复杂卡 800 字单条不应报 WB102');

  const wb901 = makeWb(901);
  assert.ok(ids(lintStageJson('writing', stage({ wb: wb901 }), { plan: makePlan(wb901) })).includes('WB102'),
    '复杂卡 901 字单条应报 WB102');

  const forced = stage({ wb: wb800, complexity: 'simple' });
  assert.ok(ids(lintStageJson('writing', forced, { plan: plan800 })).includes('WB102'),
    '显式 simple 时 800 字应超限');
}

// 3c. 大世界卡：≥80 条或显式 large，预算 6000–8000 / 单条 1200
{
  const many = Array.from({ length: 80 }, (_, i) => entry(`_or_词${i}`, '测试正文'));
  assert.equal(detectComplexity({ wb: many }), 'large', '80 条世界书应判为大世界卡');
  assert.equal(detectComplexity({ wb: many.slice(0, 79) }), 'complex', '79 条仍按复杂卡');
  assert.equal(detectComplexity({ wb: [], complexity: 'large' }), 'large', '显式 large 生效');
  assert.equal(WB_BUDGET_PROFILES.large.total, 8000);
  assert.equal(WB_BUDGET_PROFILES.large.entry, 1200);
}

// 4. WB103 缺锚词证明 / 证明找不到
const noAnchor = { version: 1, entries: plan.entries.map((e) => (e.index === 2 ? { ...e, anchorSource: '' } : e)) };
assert.ok(ids(withPlan(stage(), noAnchor)).includes('WB103'));
const badAnchor = { version: 1, entries: plan.entries.map((e) => (e.index === 2 ? { ...e, anchorSource: 'post:不存在的字段' } : e)) };
assert.ok(ids(withPlan(stage(), badAnchor)).includes('WB103'));

// 5. WB104 路由未覆盖某个分支
const covStage = stage();
covStage.wb[0].value = '路由：只有游戏模式与剧情模式的细则。兜底按剧情模式。';
assert.ok(ids(withPlan(covStage, plan)).includes('WB104'));

// 6. WB105 路由缺兜底
const noFallback = stage();
noFallback.wb[0].value = '路由：游戏模式/剧情模式/任务模式 各有细则。';
assert.ok(ids(withPlan(noFallback, plan)).includes('WB105'));

// 7. WB106 控制词不成对：key 的词不在后置词里
const badControl = stage();
badControl.wb[2].key = '_or_结束';
assert.ok(ids(withPlan(badControl, plan)).includes('WB106'));

// 8. WB106 反向：后置词有控制词却没有条目承接
const orphanStage = stage();
orphanStage.wb = orphanStage.wb.filter((_, i) => i !== 3);
const orphanPlan = { version: 1, entries: plan.entries.filter((e) => e.index !== 4) };
assert.ok(ids(withPlan(orphanStage, orphanPlan)).includes('WB106'));

// 9. WB107 结算类被标成常驻
const wrongDuty = { version: 1, entries: plan.entries.map((e) => (e.index === 3 ? { ...e, 激活: '枚举锚' } : e)) };
assert.ok(ids(withPlan(stage(), wrongDuty)).includes('WB107'));

// 10. WB108 AND 词不可满足
const andStage = stage();
andStage.wb.push(entry('_and_甲词@wb@乙词', '组合触发的阶段细则。', 1));
andStage.wb[0].value += '\n兜底。甲词 也在这里出现。';
const andPlan = { version: 1, entries: [...plan.entries, { index: 5, 职责: '规则', 激活: '知识关键词', 载体: 'wb' }] };
assert.ok(ids(withPlan(andStage, andPlan)).includes('WB108'), '乙词没有证据，应报 WB108');

// 11. WB109 状态机缺 END 条目（保留下标对齐，只改 key）
const noEnd = stage();
noEnd.wb[2].key = '_or_无关词';
assert.ok(ids(withPlan(noEnd, plan)).includes('WB109'));

// 12. WB110 空承诺：未启用状态机但 ppt 承诺阶段
const promise = stage({ ppt: '你是叙事者。每个阶段给出目标、时限与奖励。' });
promise.wb = [entry('_or_城市', '城市的描述。')];
promise.post_text = post.replace('▸ 事件：IDLE / CONTINUE / END', '');
const promisePlan = { version: 1, entries: [{ index: 1, 职责: '知识', 激活: '知识关键词', 载体: 'wb' }] };
assert.ok(ids(withPlan(promise, promisePlan)).includes('WB110'));

// 13. CUE007 按类别放行：枚举锚撞 ptx/post 不报，知识关键词仍报
const anchorHit = stage();
anchorHit.wb[1].key = '_or_模式';
assert.ok(!ids(withPlan(anchorHit, plan)).includes('CUE007'), '枚举锚撞后置词应放行');

const knowledgeHit = stage();
knowledgeHit.wb.push(entry('_or_模式', '知识条目误用锚词。'));
const knowledgePlan = { version: 1, entries: [...plan.entries, { index: 5, 职责: '知识', 激活: '知识关键词', 载体: 'wb' }] };
assert.ok(ids(withPlan(knowledgeHit, knowledgePlan)).includes('CUE007'), '知识关键词撞后置词应报 CUE007');

// 14. loadWbPlan 读取与缺失
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-wbplan-'));
assert.equal(loadWbPlan(tmp), null);
fs.mkdirSync(path.join(tmp, '.card-build'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.card-build', 'wb-plan.json'), JSON.stringify(plan), 'utf8');
assert.equal(loadWbPlan(tmp).entries.length, 4);
fs.writeFileSync(path.join(tmp, '.card-build', 'wb-plan.json'), '{坏 JSON', 'utf8');
assert.equal(loadWbPlan(tmp), null);
fs.rmSync(tmp, { recursive: true, force: true });

// 15b. 新标签名同样成立：内容锚 / 格式字段锚 / 格式标记锚
const newPlan = {
  version: 1,
  entries: [
    { index: 1, 职责: '路由', 激活: '格式字段锚', 载体: 'wb', anchorSource: 'post:模式' },
    { index: 2, 职责: '规则', 激活: '格式字段锚', 载体: 'wb', anchorSource: 'post:模式' },
    { index: 3, 职责: '控制词', 激活: '格式标记锚', 载体: 'wb', anchorSource: 'control:END' },
    { index: 4, 职责: '规则', 激活: '格式标记锚', 载体: 'wb', anchorSource: 'control:IDLE' },
  ],
};
const newBase = withPlan(stage(), newPlan);
for (const id of ['WB101', 'WB103', 'WB105', 'WB106', 'WB107', 'WB109']) {
  assert.ok(!ids(newBase).includes(id), `新标签基线不该报 ${id}`);
}

// 15c. WB111 分隔符混用
const mixed = stage();
mixed.wb[1].key = '_or_经营 or 契约 or 客户@wb@账册';
assert.ok(ids(withPlan(mixed, plan)).includes('WB111'));

// 15d. WB112 key 编号与正文不一致
const codeStage = stage();
codeStage.wb[1].key = '_or_郗宝瓶@wb@FK-001';
codeStage.wb[1].value = '客户编号 FK-002，逾期滞留。';
assert.ok(ids(withPlan(codeStage, plan)).includes('WB112'));

// 15e. WB113 内容锚却挂在常驻锚上
const fakeContent = stage();
fakeContent.wb.push(entry('_or_模式', '这条其实是常驻规则。', 2));
const fakePlan = { version: 1, entries: [...plan.entries, { index: 5, 职责: '规则', 激活: '内容锚', 载体: 'wb' }] };
assert.ok(ids(withPlan(fakeContent, fakePlan)).includes('WB113'));

// 15f. 真正的内容锚（专名）不报 WB113
const realContent = stage();
realContent.wb.push(entry('_or_暴风城', '暴风城的描述。', 2));
const realPlan = { version: 1, entries: [...plan.entries, { index: 5, 职责: '知识', 激活: '内容锚', 载体: 'wb' }] };
assert.ok(!ids(withPlan(realContent, realPlan)).includes('WB113'));

// 15. 无 plan 时 lintWorldbookPlan 直接放行
assert.deepEqual(lintWorldbookPlan(stage(), null), []);

// 16. 集成：deliver 会读取 .card-build/wb-plan.json，并按标签分类拦截
{
  const { pathToFileURL } = await import('node:url');
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

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-wb-e2e-'));
  const run = (line) => registered.command.handler({ rawInput: line });
  assert.equal(run(`start --out "${out}" --title 标签卡`).kind, 'success');

  // template 会顺带产出标签骨架
  assert.equal(run(`template --part writing --out "${out}"`).kind, 'success');
  assert.ok(fs.existsSync(path.join(out, '.card-build', 'template-wb-plan.json')), 'template 应产出 wb-plan 骨架');

  const writePlan = (p) => fs.writeFileSync(path.join(out, '.card-build', 'wb-plan.json'), JSON.stringify(p), 'utf8');
  const writeStage = (s) => {
    const f = path.join(out, 'stage.json');
    fs.writeFileSync(f, JSON.stringify(s), 'utf8');
    return f;
  };

  // 16a. 控制锚的词不在后置词里 → 交付被拒（WB106）
  const badWb = stage();
  badWb.wb[2].key = '_or_结束';
  writePlan(plan);
  const rejected = run(`deliver --part writing --file "${writeStage(badWb)}"`);
  assert.equal(rejected.kind, 'success');
  assert.match(String(rejected.text), /未通过交付检查/);
  assert.match(String(rejected.text), /WB106/);

  // 16b. 证据齐全 → 正常交付
  writePlan(plan);
  const ok = run(`deliver --part writing --file "${writeStage(stage())}"`);
  assert.match(String(JSON.parse(ok.text).message), /已交付并停止/);

  // 16c. 删掉旁车后：锚词失去标签支撑，退回 CUE007 拦截（旧卡不启用锚词，互不影响）
  fs.rmSync(path.join(out, '.card-build', 'wb-plan.json'));
  const noPlanDeliver = run(`deliver --part writing --file "${writeStage(stage())}"`);
  assert.match(String(noPlanDeliver.text), /未通过交付检查/);
  assert.match(String(noPlanDeliver.text), /CUE007/);
  assert.match(String(noPlanDeliver.text), /wb-plan/);

  fs.rmSync(out, { recursive: true, force: true });
}

console.log('worldbook plan tests passed');

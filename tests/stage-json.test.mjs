import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintStageJson, matchWorldbook, assemble, readState, writeState, newState, markAwaiting, passPart, toPlatform, pickField, pickPanelFlag, V2_KEY_ORDER, PLATFORM_FORMATS, LORE_ENTRY_KEYS } from '../lib/core.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rp-card-plugin-')); const state=newState({brief:'合成测试',type:'auto',platform:'test'}); state.title='测试卡'; writeState(root,state);
const wb={group:'地点',match_type:2,key:'_or_星港@wb@港口',key_region:2,value_region:1,value:'星港是贸易节点。',enable:true};
assert.equal(matchWorldbook(wb,'进入星港',''),true); assert.equal(matchWorldbook({...wb,enable:false},'进入星港',''),false); assert.equal(matchWorldbook({...wb,key:'_and_星港@wb@封锁',match_type:1},'进入星港','封锁'),true);
const postText='【时间地点】\n时间：X\n地点：X\n\n【正文】X\n\n【角色信息】\n姓名：X｜性别：X｜年龄：X｜外貌：X\n\n【记忆区】\n短期：1. X\n长期：1. X\n\n【行动建议】\n1. X\n2. X\n3. X\n4. 自定义：';
const base={title:'测试卡',summary:'一句话简介',ppt:'主提示',ptx:'前缀',post_text:postText,opening_statement:'开场',wb:[wb],desc:'',built_in_css:'',rgx_rep:[],ai_variable_tmpl:'',ai_v_prompt:'',ai_v_json:'',ext:{ai_variable_enabled:false}};
assert.equal(lintStageJson('writing',base).filter(x=>x.severity==='error').length,0);
// 输出格式在 ppt 时：后缀首行必须是「玩家输入已结束。」，其后放文风约束；【时间地点】不再要求是 ppt 的第一个标题
const newArchBase={...base,ppt:'主提示\n'+postText};
assert.equal(lintStageJson('writing',{...newArchBase,post_text:'玩家输入已结束。\n文风约束：冷静克制。'}).filter(x=>x.severity==='error').length,0);
assert.ok(lintStageJson('writing',{...newArchBase,post_text:'文风约束：冷静克制。'}).some(x=>x.id==='CUE016'),'缺后缀首行应报 CUE016');
// 简介可选：旧阶段 JSON 没有 summary 时不应报错（补齐字段只在需要时写）
assert.equal(lintStageJson('writing',{...base,summary:undefined}).filter(x=>x.severity==='error').length,0);

// 【时间地点】固定首段：缺失、顺序错误、字段缺失都必须被拦（它是聊天页包裹正文的锚点）
const cueIds=(post)=>lintStageJson('writing',{...base,post_text:post}).map((x)=>x.id);
assert.ok(!cueIds(postText).includes('CUE010'));
assert.ok(cueIds('【正文】X\n\n【角色信息】\n姓名：X').includes('CUE010'),'缺少首段应报 CUE010');
assert.ok(cueIds('【正文】X\n\n【时间地点】\n时间：X\n地点：X').includes('CUE011'),'首段不在最前应报 CUE011');
assert.ok(cueIds('【时间地点】\n地点：X\n\n【正文】X').includes('CUE012'),'缺「时间：」应报 CUE012');
// 轻量卡：输出格式可挪到前置词，且允许内置 CSS 美化时用代码包裹固定段
const ptxFormat='【时间地点】\n时间：X\n地点：X\n\n【正文】X\n\n【角色信息】\n姓名：X\n\n【记忆区】\n短期：1. X\n\n【行动建议】\n1. X\n2. X\n3. X\n4. 自定义：';
const ptxBase={...base,ppt:'主提示',ptx:ptxFormat,post_text:'玩家输入已结束。\n文风约束：冷静克制。'};
assert.equal(lintStageJson('writing',ptxBase).filter(x=>x.severity==='error').length,0,'输出格式写在前置词时应放行');
const htmlFormat='<div class="time">时间地点：2077年，废墟</div>\n<div class="char">角色信息：姓名：X</div>\n<div class="mem">记忆区：短期 1. X</div>\n<div class="todo">行动建议：1. X</div>';
const htmlBase={...base,ppt:'主提示\n'+htmlFormat,post_text:'玩家输入已结束。\n文风约束：冷静克制。'};
assert.equal(lintStageJson('writing',htmlBase).filter(x=>x.severity==='error').length,0,'代码包裹的固定段应放行');
assert.ok(lintStageJson('writing',{...htmlBase,ppt:'主提示\n<div>时间地点：2077年，废墟</div>'}).some(x=>x.id==='CUE005'),'代码包裹也必须有角色信息/记忆区/行动建议');
for(const [part,file] of Object.entries({writing:'part-1-writing.json',profile:'part-2-description.json',chat:'part-3-chat.json',variables:'part-4-variable.json'})){const f=path.join(root,file);fs.writeFileSync(f,JSON.stringify(part==='writing'?base:{...base,desc:part==='profile'?'html':'',built_in_css:part==='chat'?'css':'',ai_variable_tmpl:part==='variables'?'tmpl':'',ext:{ai_variable_enabled:false}})); const s=readState(root);s.parts[part].status='pass';s.parts[part].files=[{path:file,digest:null}];writeState(root,s);}
const s=readState(root); for(const p of Object.keys(s.parts)){s.parts[p].files[0].digest=(await import('../lib/core.js')).sha256(fs.readFileSync(path.join(root,s.parts[p].files[0].path),'utf8'));} writeState(root,s);
const result=assemble(root);
// 默认导出 v2（平台当前格式）：主提示词在 pre_prompt，卡名在 name，世界书在 lore_bk
assert.equal(result.format,'v2');
assert.equal(result.card.pre_prompt,'主提示');
assert.equal(result.card.name,'测试卡');
assert.equal(result.card.lore_bk[0].value,'星港是贸易节点。');
assert.equal(result.card.desc,'html');
assert.equal(result.card.built_in_css,'css');
assert.equal(result.card.extend.ai_variable_enabled,false);
assert.equal(result.card.ptx,'前缀');
assert.equal(result.card.sum_info,'一句话简介');
// 世界书条目必须与平台真实形状一致（12 字段，含 value_type/value_configs/sort/probability，不含 name）
assert.deepEqual(Object.keys(result.card.lore_bk[0]).sort(), [...LORE_ENTRY_KEYS].sort());
assert.equal(result.card.lore_bk[0].value_type, 0);
assert.equal(result.card.lore_bk[0].probability, 100);
// 部署字段默认值：sort=0、depth=0、value_region=1（示例里的 depth=3 不是默认值）
assert.equal(result.card.lore_bk[0].sort, 0);
assert.equal(result.card.lore_bk[0].depth, 0);
assert.equal(result.card.lore_bk[0].value_region, 1);
assert.deepEqual(result.card.lore_bk[0].value_configs, []);

// 只支持一种导出格式：其它格式必须显式报错，而不是静默降级
assert.throws(() => toPlatform({ title: 'x' }, 'v1'), /不支持的导出格式/);

// 别名读入：平台随机键名组合仍能归一到规范字段（只影响读入，不影响导出格式）
assert.equal(pickField({ name: '卡名' }, 'title'), '卡名');
assert.equal(pickPanelFlag({ extend: { ai_variable_enabled: true } }), true);

// v2 导出键集合必须与平台实测样例完全一致（防止字段再次漂移无感）
assert.deepEqual(Object.keys(result.card).sort(), [...V2_KEY_ORDER].sort(), 'v2 键集合与平台样例不一致');
assert.equal(PLATFORM_FORMATS.v2.status,'platform-verified-import');

console.log('stage-json tests passed');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELD_ALIASES,
  PLATFORM_KEY_ALIASES,
  LEGACY_PLATFORM_SETTING_KEYS,
  BACKGROUND_FIELDS,
  V2_KEY_ORDER,
} from '../lib/core.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, '..', 'references', 'platform-fields.json');
const registry = JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('权威字段库：结构完整、id 与同义键不重复', () => {
  assert.ok(Array.isArray(registry.fields) && registry.fields.length >= 40, '字段数量应覆盖全部已观测字段');
  const ids = new Set();
  const v2Keys = new Set();
  const aliases = new Set();
  for (const f of registry.fields) {
    assert.ok(f.id && typeof f.id === 'string', '每个字段都要有 id');
    assert.ok(!ids.has(f.id), `字段 id 重复：${f.id}`);
    ids.add(f.id);
    if (f.v2Key) {
      assert.ok(!v2Keys.has(f.v2Key), `v2Key 重复：${f.v2Key}`);
      v2Keys.add(f.v2Key);
    }
    assert.ok(Array.isArray(f.aliases) && f.aliases.length >= 1, `${f.id} 要有同义词`);
    for (const a of f.aliases) {
      assert.ok(typeof a === 'string' && a, `${f.id} 的别名必须是非空字符串`);
      assert.ok(!aliases.has(a), `同义键重复登记：${a}`);
      aliases.add(a);
    }
    assert.ok(Array.isArray(f.evidence) && f.evidence.length >= 1, `${f.id} 要写证据文件`);
    for (const ev of f.evidence) assert.ok(registry.evidence[ev], `${f.id} 的证据 ${ev} 不在 evidence 表里`);
  }
});

test('权威字段库 ↔ 代码别名表：双向一致', () => {
  const content = new Set(Object.values(FIELD_ALIASES).flat());
  const mapped = new Set(Object.keys(PLATFORM_KEY_ALIASES));
  const legacy = new Set(LEGACY_PLATFORM_SETTING_KEYS);
  const bg = new Set(Object.values(BACKGROUND_FIELDS).flat());
  const v2 = new Set(V2_KEY_ORDER);
  const codeKeys = new Set([...content, ...mapped, ...legacy, ...bg, ...v2]);
  const registryKeys = new Set(registry.fields.flatMap((f) => f.aliases));

  const missingInCode = [...registryKeys].filter((k) => !codeKeys.has(k));
  const missingInRegistry = [...codeKeys].filter((k) => !registryKeys.has(k));
  assert.deepEqual(missingInCode, [], '字段库里的同义键必须已在代码里登记');
  assert.deepEqual(missingInRegistry, [], '代码里登记的键必须写进字段库');
});

test('权威字段库：内容字段的同义键必须能从 FIELD_ALIASES 读出', () => {
  const bgFields = new Set(Object.keys(BACKGROUND_FIELDS));
  for (const f of registry.fields) {
    if (!['content'].includes(f.exportMode)) continue;
    if (f.id === 'summary') continue; // 简介走 PLATFORM_KEY_ALIASES 的映射，不进 FIELD_ALIASES
    if (bgFields.has(f.id)) continue; // 背景图走 BACKGROUND_FIELDS
    const aliases = new Set(FIELD_ALIASES[f.id] || []);
    for (const a of f.aliases) {
      assert.ok(aliases.has(a), `${f.id} 的同义键 ${a} 必须写进 FIELD_ALIASES`);
    }
  }
});

test('权威字段库：标签与自动总结只读，不产出', () => {
  const labels = registry.fields.find((f) => f.id === 'labels');
  const autoSummary = registry.fields.find((f) => f.id === 'summary_config');
  assert.equal(labels.authorable, false, '标签不写');
  assert.equal(labels.exportMode, 'readonly');
  assert.equal(autoSummary.authorable, false, '自动总结不写');
  assert.equal(autoSummary.exportMode, 'readonly');
});

test('权威字段库：v1 定稿元数据与平台行为备注', () => {
  assert.equal(registry.status, 'authoritative-v1');
  assert.ok(registry.platformBehaviors, '要写平台行为备注');
  assert.match(registry.platformBehaviors.exportKeys, /随机/);
  assert.equal(registry.platformBehaviors.images.includes('catai.wiki'), true);
  const ps = registry.fields.find((f) => f.id === 'ps_chats');
  const tiny = registry.fields.find((f) => f.id === 'cover_tiny');
  assert.equal(ps.exportMayOmit, true, '预设对话可能被平台导出遗漏');
  assert.equal(tiny.exportMayOmit, true, '封面缩略可能被平台导出遗漏');
});

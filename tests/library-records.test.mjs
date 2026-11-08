import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSource } from '../lib/library/sources.js';
import {
  serializeRecord, parseRecord, writeRecord, readRecord, listRecords,
  rebuildIndex, verifyEvidence, recordPath,
} from '../lib/library/records.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-rec-'));
const text = ['第一章 相遇', '她推门进来，雨水顺着伞骨往下滴。'.repeat(30), '第二章 离别', '他站在门口没有回头。'.repeat(30)].join('\n');
const meta = registerSource(dir, { id: 'novel-a', kind: 'novel', title: '测试', realm: 'canon', text });
const unit0 = meta.units[0].id;
const quote = '她推门进来，雨水顺着伞骨往下滴。';

// 1. 序列化与解析往返
{
  const rec = { id: 'char-a', kind: 'character', name: '阿雨', aliases: ['雨'], realm: 'canon', status: 'confirmed', known_from: 0, body: '## 基本信息\n她是一名店主。', evidence: [{ source_id: 'novel-a', unit_id: unit0, quote }] };
  const md = serializeRecord(rec);
  const back = parseRecord(md);
  assert.equal(back.id, 'char-a');
  assert.equal(back.name, '阿雨');
  assert.deepEqual(back.aliases, ['雨']);
  assert.match(back.body, /店主/);
  assert.equal(back.known_from, 0);
}

// 2. 写入与读回
{
  const rec = { id: 'char-a', kind: 'character', name: '阿雨', realm: 'canon', status: 'confirmed', known_from: 0, body: '设定正文', evidence: [{ source_id: 'novel-a', unit_id: unit0, quote }] };
  const r = writeRecord(dir, rec);
  assert.ok(fs.existsSync(r.path));
  const back = readRecord(dir, 'char-a');
  assert.equal(back.body, '设定正文');
  assert.ok(back.base_sha256);
}

// 3. 修改必须带 base_sha256
{
  const cur = readRecord(dir, 'char-a');
  const { base_sha256: _omit, ...withoutHash } = cur;
  assert.throws(() => writeRecord(dir, { ...withoutHash, body: '改一下' }), /base_sha256/);
}

// 4. 带正确哈希可以修改
{
  const cur = readRecord(dir, 'char-a');
  writeRecord(dir, { ...cur, body: '改一下', base_sha256: cur.base_sha256 });
  assert.equal(readRecord(dir, 'char-a').body, '改一下');
}

// 5. 哈希不匹配时拒绝覆盖（模拟人工修改）
{
  const cur = readRecord(dir, 'char-a');
  const p = recordPath(dir, 'char-a');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('改一下', '人工改过'), 'utf8');
  assert.throws(() => writeRecord(dir, { ...cur, body: '又改' }), /已被修改|不匹配/);
  // 人工内容仍在
  assert.match(readRecord(dir, 'char-a').body, /人工改过/);
}

// 6. 非法 id / 类型被拒
{
  assert.throws(() => writeRecord(dir, { id: 'Bad Id', kind: 'character' }), /小写字母/);
  assert.throws(() => writeRecord(dir, { id: 'x1', kind: 'unknown-kind' }), /未知条目类型/);
}

// 7. 列表与索引
{
  writeRecord(dir, { id: 'place-a', kind: 'place', name: '咖啡馆', realm: 'canon', status: 'inference', body: '临街两层', evidence: [{ source_id: 'novel-a', unit_id: unit0, quote }] });
  const all = listRecords(dir);
  assert.deepEqual(all.map((r) => r.id), ['char-a', 'place-a']);
  const idx = rebuildIndex(dir);
  assert.equal(idx.count, 2);
  const lines = fs.readFileSync(idx.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).name, '咖啡馆');
}

// 8. 证据校验：正确引文通过
{
  const rec = readRecord(dir, 'place-a');
  assert.deepEqual(verifyEvidence(dir, rec), []);
}

// 9. 证据校验：错误引文被拒（LIB001）
{
  const rec = { id: 'x2', kind: 'place', evidence: [{ source_id: 'novel-a', unit_id: unit0, quote: '这句话原文里没有' }] };
  const problems = verifyEvidence(dir, rec);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'LIB001');
  assert.match(problems[0].message, /找不到/);
}

// 10. 证据校验：缺来源 / 缺单元
{
  const a = verifyEvidence(dir, { id: 'x3', kind: 'place', evidence: [{ source_id: 'nope', unit_id: unit0, quote }] });
  assert.equal(a[0].code, 'LIB001');
  const b = verifyEvidence(dir, { id: 'x4', kind: 'place', evidence: [{ source_id: 'novel-a', unit_id: 'u999999', quote }] });
  assert.equal(b[0].code, 'LIB001');
}

// 11. 无证据直接报 LIB001
{
  const p = verifyEvidence(dir, { id: 'x5', kind: 'place', evidence: [] });
  assert.equal(p[0].code, 'LIB001');
}

// 12. start 与引文位置不符时被拒
{
  const unit = meta.units[0];
  const rec = { id: 'x6', kind: 'place', evidence: [{ source_id: 'novel-a', unit_id: unit.id, quote, start: unit.start + 3 }] };
  const p = verifyEvidence(dir, rec);
  assert.ok(p.some((x) => /位置与 start 不符/.test(x.message)));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('library records tests passed');

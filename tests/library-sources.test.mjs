import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decodeText, splitText, normalizeText, registerSource, readSource, readUnitText, PRESETS } from '../lib/library/sources.js';

// 1. 编码：UTF-8 BOM / 纯文本
{
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一章 开端\n正文内容。', 'utf8')]);
  const r = decodeText(withBom);
  assert.equal(r.encoding, 'utf-8');
  assert.ok(!r.text.startsWith('\uFEFF'));
}

// 2. 编码：GB18030 中文
{
  // “第一章” 的 GBK 编码
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xc4, 0xda, 0xc8, 0xdd]);
  const r = decodeText(gbk);
  assert.ok(['gb18030', 'gbk'].includes(r.encoding), '应识别为 GB 系编码，实际 ' + r.encoding);
  assert.match(r.text, /第/);
}

// 3. 归一化：CRLF → LF
{
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc');
}

// 4. 小说切分：章标题
{
  const text = ['第一章 相遇', 'a'.repeat(600), '第二章 离别', 'b'.repeat(600), '第三章 重逢', 'c'.repeat(600)].join('\n');
  const { units, stats } = splitText(text, 'novel');
  assert.equal(units.length, 3, '应切出 3 章');
  assert.match(units[0].title, /第一章/);
  assert.equal(stats.kind, 'novel');
  // 偏移量可回取原文
  for (const u of units) {
    assert.equal(text.slice(u.start, u.end).length, u.chars);
  }
}

// 5. 小说：无章标题时整篇为一块
{
  const { units } = splitText('没有章节标题的一段文字。'.repeat(50), 'novel');
  assert.equal(units.length, 1);
}

// 6. 剧本：按集切
{
  const text = ['第1集 开端', '场景一'.repeat(50), '第2集 转折', '场景二'.repeat(50)].join('\n');
  const { units } = splitText(text, 'screenplay');
  assert.equal(units.length, 2);
  assert.match(units[0].title, /第1集/);
}

// 7. 剧本：单集超上限时按场切
{
  const ep = ['第1集 很长的一集', '第1场 客厅', 'x'.repeat(4000), '第2场 厨房', 'y'.repeat(4000)].join('\n');
  const { units } = splitText(ep, 'screenplay', { maxChars: 5000, minChars: 10 });
  assert.ok(units.length >= 2, '应按场再切，实际 ' + units.length);
  assert.ok(units.every((u) => u.chars <= 5000 + 2000));
}

// 8. 设定集：按条目标题切
{
  const text = ['# 世界规则', '规则内容。'.repeat(80), '# 主要势力', '势力内容。'.repeat(80)].join('\n');
  const { units } = splitText(text, 'setting-book');
  assert.equal(units.length, 2);
}

// 9. 过大块被切开
{
  const big = '第1章 巨章\n' + 'x'.repeat(20000);
  const { units } = splitText(big, 'novel', { maxChars: 8000, minChars: 100 });
  assert.ok(units.length >= 3, '应被切成多块，实际 ' + units.length);
  assert.ok(units.every((u) => u.chars <= 8000));
}

// 10. 有标题的小章节不合并（避免把第2章并进第1章）
{
  const text = ['第一章 短', '短'.repeat(80), '第二章 也短', '短'.repeat(80)].join('\n');
  const { units } = splitText(text, 'novel', { maxChars: 15000, minChars: 500 });
  assert.equal(units.length, 2, '带标题的单元不应合并，实际 ' + units.length);
}

// 10b. 无标题碎片并回上一块
{
  const text = ['第一章 长', '长'.repeat(600), '', '断开的碎片' + '碎'.repeat(60)].join('\n');
  const { units } = splitText(text, 'novel', { maxChars: 15000, minChars: 200 });
  assert.equal(units.length, 1, '无标题碎片应并入上一块，实际 ' + units.length);
}

// 11. 重号标题保留不合并编号
{
  const text = ['第一章 一', 'a'.repeat(500), '第一章 一', 'b'.repeat(500)].join('\n');
  const { units } = splitText(text, 'novel');
  assert.equal(units.length, 2);
}

// 12. 注册来源 + 读回单元文本
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-src-'));
  const text = ['第一章 相遇', '这是第一章的正文内容。'.repeat(60), '第二章 离别', '这是第二章的正文内容。'.repeat(60)].join('\n');
  const meta = registerSource(dir, { id: 'novel-a', kind: 'novel', title: '测试小说', realm: 'canon', text });
  assert.equal(meta.units.length, 2);
  assert.equal(meta.chars, text.length);
  assert.ok(meta.file_sha256.length === 64);
  const back = readSource(dir, 'novel-a');
  assert.equal(back.text.length, meta.chars);
  const unitText = readUnitText(dir, 'novel-a', meta.units[0].id);
  assert.match(unitText, /第一章/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 13. 未知类型报错
{
  assert.throws(() => registerSource(os.tmpdir(), { id: 'x', kind: 'comic', text: 'a' }), /未知材料类型/);
}

// 14. 预设齐全（四类材料 + 场次细分）
{
  assert.deepEqual(Object.keys(PRESETS).sort(), ['game-script', 'novel', 'scene', 'screenplay', 'setting-book']);
}

console.log('library sources tests passed');

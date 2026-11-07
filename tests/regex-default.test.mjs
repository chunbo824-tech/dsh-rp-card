import test from 'node:test';
import assert from 'node:assert/strict';

import { lintRegex, normalizeRegexRules, toPlatform, REGEX_SCOPE_DEFAULT } from '../lib/core.js';

test('scope 省略按 1 处理，不再报错', () => {
  const rules = [{ is_enable: true, match_regex: '\\[hp:(\\d+)\\]', replace_text: '<b>$1</b>' }];
  assert.deepEqual(lintRegex(rules), []);
  assert.equal(REGEX_SCOPE_DEFAULT, 1);
  assert.equal(normalizeRegexRules(rules)[0].scope, 1);
});

test('显式 scope 保留；非法 scope 报错', () => {
  const ok = [
    { scope: 2, is_enable: true, match_regex: 'a', replace_text: 'b' },
    { scope: 10, is_enable: false, match_regex: 'c', replace_text: '' },
  ];
  assert.deepEqual(lintRegex(ok), []);
  assert.deepEqual(normalizeRegexRules(ok).map((r) => r.scope), [2, 10]);

  const bad = lintRegex([{ scope: 3, is_enable: true, match_regex: 'a', replace_text: 'b' }]);
  assert.ok(bad.some((d) => d.id === 'RGX002'));
});

test('导出时补齐 scope=1，且不丢其它字段', () => {
  const platform = toPlatform({
    title: '测试卡',
    rgx_rep: [
      { is_enable: true, match_regex: 'x', replace_text: 'y', is_only_render: true },
      { scope: 10, is_enable: true, match_regex: 'z', replace_text: '' },
    ],
  }, 'v2');
  assert.equal(platform.rgx_rep.length, 2);
  assert.equal(platform.rgx_rep[0].scope, 1);
  assert.equal(platform.rgx_rep[0].is_only_render, true);
  assert.equal(platform.rgx_rep[1].scope, 10);
});

console.log('regex default test passed');

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAllowedModels, profileDir, resolveVisionDelegate, VISION_FALLBACK } from '../lib/vision.js';

const SAMPLE = `- id: subagent-model-selection-settings
  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
  config:
    enabled: true
    allowedModels:
      - provider: api
        model: gpt-6.1-sol
      - provider: deepseek-account
        model: deepseek-flash
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: other-provider
    model: other-model
`;

test('parseAllowedModels 能取出成对的 provider/model', () => {
  const pairs = parseAllowedModels(SAMPLE);
  assert.ok(pairs.length >= 2);
  assert.deepEqual(pairs.find((x) => x.provider === 'api'), { provider: 'api', model: 'gpt-6.1-sol' });
  assert.deepEqual(pairs.find((x) => x.provider === 'deepseek-account'), { provider: 'deepseek-account', model: 'deepseek-flash' });
});

test('parseAllowedModels 兼容单行写法', () => {
  const pairs = parseAllowedModels('allowedModels: [ { provider: deepseek-account, model: deepseek-chat } ]');
  assert.deepEqual(pairs[0], { provider: 'deepseek-account', model: 'deepseek-chat' });
});

test('环境变量优先于 profile', () => {
  const got = resolveVisionDelegate({ RP_CARD_VISION_PROVIDER: 'env-provider', RP_CARD_VISION_MODEL: 'env-model', DSH_PROFILE_DIR: 'Z:\\nope' });
  assert.deepEqual(got, { provider: 'env-provider', model: 'env-model', source: 'env' });
});

test('从 profile 的允许列表里挑第一个 DeepSeek 项', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-vision-'));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), SAMPLE, 'utf8');
  const got = resolveVisionDelegate({ DSH_PROFILE_DIR: dir });
  assert.equal(got.provider, 'deepseek-account');
  assert.equal(got.model, 'deepseek-flash');
  assert.equal(got.source, 'profile');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profile 目录缺失或旧格式时回退兜底', () => {
  const empty = resolveVisionDelegate({ DSH_PROFILE_DIR: path.join(os.tmpdir(), 'rp-vision-not-exist') });
  assert.deepEqual(empty, { ...VISION_FALLBACK, source: 'fallback' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-vision-'));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- id: image-gen\n  config:\n    providerId: recraft\n    modelId: recraftv4_1\n', 'utf8');
  const noDs = resolveVisionDelegate({ DSH_PROFILE_DIR: dir });
  assert.deepEqual(noDs, { ...VISION_FALLBACK, source: 'fallback' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profileDir 支持 DSH_HOME + DSH_PROFILE 组合', () => {
  assert.equal(profileDir({ DSH_HOME: 'C:\\x\\.dsh', DSH_PROFILE: 'desktop' }), path.join('C:\\x\\.dsh', 'profiles', 'desktop'));
  assert.equal(profileDir({}), '');
});

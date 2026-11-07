import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 图像能力设置：只管两件事——密钥存哪、用户是否选择不接入。
 * 供应商与模型参数一律内置（见 lib/assets.js 的 DEFAULT_PROVIDERS），不需要用户配置。
 */

export const PROVIDER_KEYS = {
  seedream: 'IMAGE_GEN_PROVIDER_API_KEY',
  recraft: 'RECRAFT_API_KEY',
};

export const PROVIDER_LABELS = {
  seedream: 'Seedream（火山方舟）· 位图：背景图 / 地图 / 场景插画 / 带环境的人物图',
  recraft: 'Recraft · 矢量：图标 / 装饰 / 需要透明背景的人物立绘',
};

export const KEY_LINKS = {
  seedream: 'https://console.volcengine.com/ark/region:cn-beijing/overview',
  recraft: 'https://www.recraft.ai/docs/api-reference/getting-started',
};

export const RPC_CHANNEL = '/rp-card-image';

/** 「是否接入图像」也走凭据存储，客户端可用同一套 remote.credentials 读写，不需要额外通道。 */
export const MODE_REF = 'RP_CARD_IMAGE_MODE';

function dshDir() {
  // 测试可用 RP_CARD_DSH_DIR 指到临时目录，不碰真实 ~/.dsh
  return process.env.RP_CARD_DSH_DIR || path.join(os.homedir(), '.dsh');
}

export function statePath() {
  return path.join(dshDir(), 'rp-card-image.json');
}

export function credentialsPath() {
  return path.join(dshDir(), '.credentials.yaml');
}

/** 读取密钥：环境变量优先，其次 ~/.dsh/.credentials.yaml 的 refs 段。 */
export function readKeyRef(name) {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const text = fs.readFileSync(credentialsPath(), 'utf8');
    const at = text.indexOf('\nrefs:');
    const section = at >= 0 ? text.slice(at) : text;
    const m = section.match(new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, 'm'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** 用户是否选择「不接入图像模型」。优先读凭据里的模式标记，其次读本地文件，默认接入。 */
export function readImageMode() {
  const viaRef = String(readKeyRef(MODE_REF) || '').trim().toLowerCase();
  if (viaRef === 'none') return 'none';
  if (viaRef === 'keys') return 'keys';
  try {
    const data = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return data && data.mode === 'none' ? 'none' : 'keys';
  } catch {
    return 'keys';
  }
}

export function writeImageMode(mode) {
  fs.mkdirSync(dshDir(), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify({
    mode: mode === 'none' ? 'none' : 'keys',
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

/** 当前密钥与接入状态。 */
export function keyStatus() {
  const seedream = Boolean(readKeyRef(PROVIDER_KEYS.seedream));
  const recraft = Boolean(readKeyRef(PROVIDER_KEYS.recraft));
  const mode = readImageMode();
  const anyKey = seedream || recraft;
  return {
    mode,
    seedream,
    recraft,
    anyKey,
    // 只有在「接入图像」模式下且一个密钥都没有时，才强制弹设置卡
    needSetup: mode !== 'none' && !anyKey,
    pureCode: mode === 'none',
  };
}

/** 设置卡数据：交给客户端渲染，也用于文本兜底。 */
export function setupPayload(extra = {}) {
  const st = keyStatus();
  return {
    ok: true,
    kind: 'image-setup',
    action: 'setup',
    ...st,
    links: KEY_LINKS,
    providers: {
      seedream: { env: PROVIDER_KEYS.seedream, label: PROVIDER_LABELS.seedream, link: KEY_LINKS.seedream, configured: st.seedream },
      recraft: { env: PROVIDER_KEYS.recraft, label: PROVIDER_LABELS.recraft, link: KEY_LINKS.recraft, configured: st.recraft },
    },
    note: st.pureCode
      ? '当前选择「不接入图像模型」：第二部分将使用纯代码前端，不生成任何图像资产。'
      : st.needSetup
        ? '还没有可用的图像密钥。填写下方任一密钥即可继续；也可以选择不接入图像模型，改用纯代码前端。'
        : '图像密钥已就绪。缺哪一个会影响对应类型：位图需要 Seedream，矢量需要 Recraft。',
    ...extra,
  };
}

/** 需要设置时的统一返回，工具与校验共用。 */
export function needSetupPayload(provider, reason) {
  const base = setupPayload();
  return {
    ...base,
    ok: false,
    needSetup: true,
    kind: 'image-setup',
    provider,
    reason,
    message: reason,
  };
}

function backupCredentials() {
  const file = credentialsPath();
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, `${file}.${stamp}.bak`);
}

/** 把密钥写入 ~/.dsh/.credentials.yaml 的 refs 段；保留其他内容。 */
export function saveKeys({ seedream, recraft } = {}) {
  const file = credentialsPath();
  const incoming = {};
  if (typeof seedream === 'string' && seedream.trim()) incoming[PROVIDER_KEYS.seedream] = seedream.trim();
  if (typeof recraft === 'string' && recraft.trim()) incoming[PROVIDER_KEYS.recraft] = recraft.trim();
  if (!Object.keys(incoming).length) {
    return { ok: false, saved: [], error: '没有收到密钥：至少填写一个（Seedream 或 Recraft）。' };
  }
  backupCredentials();
  fs.mkdirSync(dshDir(), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const refsAt = lines.findIndex((l) => /^refs:\s*$/.test(l));
  if (refsAt < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push('refs:');
  }
  const start = lines.findIndex((l) => /^refs:\s*$/.test(l)) + 1;
  let end = start;
  while (end < lines.length && (/^\s{2,}\S/.test(lines[end]) || lines[end] === '')) end += 1;
  for (const [name, value] of Object.entries(incoming)) {
    let replaced = false;
    for (let i = start; i < end; i += 1) {
      if (new RegExp(`^\\s*${name}:`).test(lines[i])) { lines[i] = `  ${name}: ${value}`; replaced = true; break; }
    }
    if (!replaced) {
      lines.splice(end, 0, `  ${name}: ${value}`);
      end += 1;
    }
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n{3,}/g, '\n\n'), { encoding: 'utf8', mode: 0o600 });
  if (readImageMode() === 'none') writeImageMode('keys');
  const st = keyStatus();
  return { ok: true, saved: Object.keys(incoming), status: st };
}

/** 用户选择不接入图像模型：此后不再弹设置卡。 */
export function skipImages() {
  writeImageMode('none');
  return setupPayload({ message: '已记录：不接入图像模型。第二部分将使用纯代码前端。' });
}

/** 回到接入模式（重新启用图像能力）。 */
export function resumeImages() {
  writeImageMode('keys');
  return setupPayload({ message: '已重新启用图像能力。' });
}

/** RPC 入口：客户端设置卡通过这些端点读写。 */
export async function handleRpc(endpoint, payload = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  if (endpoint === 'state') return setupPayload();
  if (endpoint === 'save') {
    const result = saveKeys({ seedream: body.seedream, recraft: body.recraft });
    return { ...setupPayload(), ...result };
  }
  if (endpoint === 'skip') return skipImages();
  if (endpoint === 'resume') return resumeImages();
  throw new Error(`未知端点：${endpoint}（可用 state / save / skip / resume）`);
}

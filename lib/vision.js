import fs from 'node:fs';
import path from 'node:path';

/* ============================================================
 * 视觉委托用的子智能体选择
 * 解析顺序：环境变量 > 当前 profile 的 subagent 允许列表里第一个 DeepSeek 项 > 兜底常量。
 * 只在插件加载时算一次，结果注入系统提示词。
 * ============================================================ */

export const VISION_FALLBACK = { provider: 'deepseek-account', model: 'deepseek-flash' };

const PAIR_LINE = /-\s*provider:\s*["']?([\w.\-:/]+)["']?\s*[\r\n]+\s*model:\s*["']?([\w.\-:/]+)["']?/g;
const PAIR_INLINE = /provider:\s*["']?([\w.\-:/]+)["']?\s*,\s*model:\s*["']?([\w.\-:/]+)["']?/g;

/** 从 cordis.patch.yml 文本里取所有 (provider, model) 组合。 */
export function parseAllowedModels(text) {
  const src = String(text || '');
  const found = [];
  for (const re of [PAIR_LINE, PAIR_INLINE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) found.push({ provider: m[1], model: m[2] });
  }
  return found;
}

/** 找到 profile 目录；拿不到就返回空串。 */
export function profileDir(env = process.env) {
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  if (env.DSH_HOME) {
    const name = env.DSH_PROFILE || 'desktop';
    return path.join(env.DSH_HOME, 'profiles', name);
  }
  return '';
}

/**
 * 解析视觉委托目标。
 * @returns {{provider: string, model: string, source: 'env'|'profile'|'fallback'}}
 */
export function resolveVisionDelegate(env = process.env) {
  const p = String(env.RP_CARD_VISION_PROVIDER || '').trim();
  const m = String(env.RP_CARD_VISION_MODEL || '').trim();
  if (p && m) return { provider: p, model: m, source: 'env' };

  const dir = profileDir(env);
  if (dir) {
    try {
      const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
      const pairs = parseAllowedModels(text);
      const ds = pairs.find((x) => /deepseek/i.test(x.provider) || /deepseek/i.test(x.model));
      if (ds) return { provider: ds.provider, model: ds.model, source: 'profile' };
    } catch {
      /* 读不到就走兜底 */
    }
  }
  return { ...VISION_FALLBACK, source: 'fallback' };
}

// 资料库校验：LIB001–LIB007，全部按「问题 → 原因 → 两条路」写。
import { verifyEvidence, listRecords } from './records.js';
import { recordChars, phaseAllowed } from './budget.js';

const three = (problem, reason, routes) => `${problem}。原因：${reason}。两条路：① ${routes[0]}；② ${routes[1]}`;

export const LIB_CODES = ['LIB001', 'LIB002', 'LIB003', 'LIB004', 'LIB005', 'LIB006', 'LIB007'];

/**
 * @param {object} ctx
 * @param {string} ctx.projectDir  资料库所在作品目录（证据校验需要读原文）
 * @param {Array}  ctx.records     资料条目
 * @param {object} ctx.plan        allocate() 的结果
 * @param {Array}  [ctx.visual]    visual.json 里的视觉参考
 * @param {number} [ctx.startPhase] 开局阶段
 */
export function lintLibrary({ projectDir, records = [], plan = null, visual = [], startPhase = 0 } = {}) {
  const d = [];
  const byId = new Map(records.map((r) => [r.id, r]));

  // LIB001 证据缺失或不匹配
  for (const rec of records) {
    if (rec.kind === 'visual' || rec.kind === 'question') continue;
    const problems = verifyEvidence(projectDir, rec);
    for (const p of problems) {
      d.push({
        id: 'LIB001',
        severity: 'error',
        message: three(
          p.message,
          '资料条目必须能回查原文，否则无法判断这条是原作事实还是模型归纳',
          ['补上原文摘句与单元 ID 后重写该条', '删掉这一条，等拿到原文再补'],
        ),
      });
    }
  }

  if (plan) {
    // LIB002 常驻里出现晚于开局的阶段
    for (const item of plan.resident || []) {
      const rec = byId.get(item.id);
      if (!rec) continue;
      if (!phaseAllowed(rec, startPhase)) {
        d.push({
          id: 'LIB002',
          severity: 'error',
          message: three(
            `条目 ${rec.id}（${rec.name || '未命名'}）标为常驻，但它的知识阶段晚于开局`,
            '常驻内容每轮都在，后期信息会直接剧透，破坏开局的悬念与节奏',
            ['降为条件触发，并保留「尚不可知」前缀', '把该条的知识阶段改到开局之前（仅当原文如此）'],
          ),
        });
      }
    }

    // LIB003 预算
    const residentChars = (plan.resident || []).reduce((a, it) => a + (it.chars ?? recordChars(byId.get(it.id) || {})), 0);
    const budget = plan.residentBudget;
    const cap = plan.entriesCap;
    if (typeof budget === 'number' && residentChars > budget) {
      d.push({
        id: 'LIB003',
        severity: 'error',
        message: three(
          `常驻合计 ${residentChars} 字，超过本方案预算 ${budget} 字`,
          '常驻每轮都会加载，超预算会持续挤压正文与剧情的空间',
          ['按「事件 → 物品 → 地点 → 关系 → 势力 → 人物 → 规则」把靠后的条目降为触发', '改用另一套取舍方案，或拆细超长条目'],
        ),
      });
    }
    for (const item of [...(plan.resident || []), ...(plan.conditional || [])]) {
      const rec = byId.get(item.id);
      if (!rec) continue;
      const chars = recordChars(rec);
      if (typeof cap === 'number' && chars > cap) {
        d.push({
          id: 'LIB003',
          severity: 'error',
          message: three(
            `条目 ${rec.id} 单条 ${chars} 字，超过上限 ${cap} 字`,
            '单条过长会让模型在长上下文里丢掉重点，也会挤占同批其他条目',
            ['按人物/阶段拆成两条', '删掉与卡无关的细节，只保留会被用到的部分'],
          ),
        });
      }
    }

    // LIB004 触发条目没有锚点
    for (const item of plan.conditional || []) {
      const rec = byId.get(item.id);
      if (!rec) continue;
      const anchors = [rec.name, ...(rec.aliases || [])].filter(Boolean);
      if (!anchors.length) {
        d.push({
          id: 'LIB004',
          severity: 'error',
          message: three(
            `条目 ${rec.id} 没有任何可用锚点（名称与别名都为空）`,
            '没有锚点的条件条目永远不会被触发，等于白占预算',
            ['补上名称或常用别名', '把它并入同类条目，避免碎片'],
          ),
        });
      }
    }

    // LIB006 未解决冲突
    const conflicts = (plan.background || []).filter((b) => b.reason === '未解决冲突');
    if (conflicts.length) {
      d.push({
        id: 'LIB006',
        severity: 'warning',
        message: three(
          `${conflicts.length} 条资料存在未解决矛盾（${conflicts.map((c) => c.id).join('、')}）`,
          '两处原文说法不一致时，随便选一边会把猜测写进设定',
          ['回到原文确认以哪一处为准，改掉另一处并留痕', '保留两条但不写进世界书，在开场与设定中回避这一点'],
        ),
      });
    }

    // LIB007 同人内容进常驻
    for (const item of plan.resident || []) {
      const rec = byId.get(item.id);
      if (rec && rec.realm === 'fanon') {
        d.push({
          id: 'LIB007',
          severity: 'warning',
          message: three(
            `条目 ${rec.id}（${rec.name || '未命名'}）来自同人材料，却被标为常驻`,
            '同人设定与官方设定混写会让玩家以为这是原作事实',
            ['降为条件触发，并在正文里注明「同人设定」', '改用原作材料替换该条'],
          ),
        });
      }
    }
  }

  // LIB005 视觉参考缺用途
  for (const v of visual || []) {
    if (!v.use || !['profile', 'chat', 'both'].includes(v.use)) {
      d.push({
        id: 'LIB005',
        severity: 'warning',
        message: three(
          `视觉参考 ${v.id || '(未命名)'} 没有标注用途`,
          '没标用途的参考会在第二部分与第三部分之间反复确认，实际用不上',
          ['补 use 字段：profile / chat / both', '删掉这条，只留确实会被用的参考'],
        ),
      });
    } else if (!v.note) {
      d.push({
        id: 'LIB005',
        severity: 'warning',
        message: three(
          `视觉参考 ${v.id} 缺少一句「借什么」`,
          '只有一句用途没有内容描述，后面画图时无从下手',
          ['补一句 note，写清借构图、配色还是质感', '删掉这条'],
        ),
      });
    }
  }

  return d;
}

/** 便捷入口：直接从作品目录读条目再校验 */
export function lintLibraryFromDisk(projectDir, { plan, visual = [], startPhase = 0 } = {}) {
  const records = listRecords(projectDir);
  return { records, diagnostics: lintLibrary({ projectDir, records, plan, visual, startPhase }) };
}

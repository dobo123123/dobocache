/**
 * DoboCache valueTier — 价值分级准入
 * 迁移自旧插件 FilterEngine 的设计理念：
 *   1) purifyMemoryText：记忆提纯（去客套、去免责声明、去引导语、压缩空白）
 *   2) 800 字预算：固定分区配额（前缀/约束/记忆），按价值从高到低填充，填满即停
 * 差异化补位：把"什么内容值得进缓存"显式做成 A/B/C 三级准入，
 * 这是主流被动保前缀方案没有做的主动价值分级层。
 */

import { timeDecay } from "./hitJudge.js";

export type ValueTier = "A" | "B" | "C";

export interface TieredFragment {
  id: string;
  content: string;      // 提纯后的正文
  rawChars: number;
  chars: number;
  score: number;        // 命中/相关评分
  tier: ValueTier;
}

export interface TierBudget {
  totalChars: number;          // 总预算（字符）
  reservedChars: number;       // 预留给前缀/约束指令的字符
  perTier: Record<ValueTier, number>; // 各档位上限（A 优先填满）
  minCharsPerFragment: number;
}

export interface AdmitResult {
  admitted: TieredFragment[];
  dropped: Array<{ id: string; tier: ValueTier; reason: string }>;
  usage: { A: number; B: number; C: number };
  budget: TierBudget;
}

export const DEFAULT_BUDGET: TierBudget = {
  totalChars: 800,
  reservedChars: 250,
  perTier: { A: 500, B: 300, C: 100 },
  minCharsPerFragment: 20,
};

/** 记忆提纯：去开头客套、去免责声明、去引导句式、压缩空白 */
export function purifyMemoryText(content: string): string {
  if (!content) return "";
  let text = content;

  // 去掉开头客套（含后续标点）
  text = text.replace(/^(好的|好|嗯|明白|了解|是的|对|没问题|行|可以)[，。!！：:\s]{0,10}/, "");

  // 去掉 AI 免责声明（任意位置整句剔除）
  text = text.replace(
    /(本回答由 AI 生成，内容仅供参考，请仔细甄别。|本回答由 AI 生成。|请注意甄别。|内容仅供参考，请仔细甄别。)/g,
    "",
  );

  // 去掉段落引导词（允许前导"是/的"）
  text = text.replace(
    /^(?:是|的)?(以下|下面是|这是|接下来|现在|首先|其次|最后|综上|综上所述|总的来说|简单来说|换言之|换句话说是|举个例子|例如|比如)[，,：:\s]*/g,
    "",
  );

  // 去掉"根据你提供的信息/整理的方案..."类引导（允许前导"是/的"，剥到标点）
  text = text.replace(/^(?:是|的)?(根据|基于|按照|依照)[^，。！!？?\n]{0,30}[，,：:]\s*/g, "");

  // 压缩多余换行与空白
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/\s{2,}/g, " ").trim();

  return text;
}

/**
 * 价值分级：综合相关分、信息密度、时效、长度给片段定档。
 * A：高分 + 紧凑（高密度稳定知识，必进缓存）
 * B：中分（可用但非核心）
 * C：低分或超长冗余（不进缓存，除非预算富余）
 */
export function gradeFragment(
  id: string,
  content: string,
  score: number,
  timestamp?: number,
  now = Date.now(),
  budget: TierBudget = DEFAULT_BUDGET,
): TieredFragment {
  const purified = purifyMemoryText(content);
  const chars = purified.length;
  const decay = timestamp ? timeDecay(timestamp, now) : 1;
  const density = chars > 0 ? Math.min(1, 160 / Math.max(chars, 40)) : 0; // 越短信息密度越高
  const combined = score * decay + density * 2;

  let tier: ValueTier;
  if (chars < budget.minCharsPerFragment || chars > 5000) {
    tier = "C";
  } else if (combined >= 8) {
    tier = "A";
  } else if (combined >= 3.5) {
    tier = "B";
  } else {
    tier = "C";
  }

  return {
    id,
    content: purified.substring(0, 800),
    rawChars: content.length,
    chars,
    score: Math.round(combined * 10) / 10,
    tier,
  };
}

/** 分级后的统计信息 */
export function summarizeTiers(fragments: TieredFragment[]): Record<string, number> {
  const out: Record<string, number> = { A: 0, B: 0, C: 0 };
  for (const f of fragments) out[f.tier] += 1;
  return out;
}

/**
 * 预算准入：按 A → B → C 档位顺序填充，每档有上限，全局有总预算，
 * 剩余空间不足 20 字符即停。返回准入列表与丢弃明细。
 */
export function admitByTier(
  fragments: TieredFragment[],
  budget: TierBudget = DEFAULT_BUDGET,
): AdmitResult {
  const usable = Math.max(0, budget.totalChars - budget.reservedChars);
  const admitted: TieredFragment[] = [];
  const dropped: AdmitResult["dropped"] = [];
  const usage: AdmitResult["usage"] = { A: 0, B: 0, C: 0 };
  let used = 0;

  const order: ValueTier[] = ["A", "B", "C"];
  const byTier: Record<ValueTier, TieredFragment[]> = { A: [], B: [], C: [] };
  for (const f of fragments) {
    byTier[f.tier].push(f);
  }
  for (const t of order) {
    byTier[t].sort((a, b) => b.score - a.score);
  }

  for (const tier of order) {
    for (const frag of byTier[tier]) {
      if (used >= usable) {
        dropped.push({ id: frag.id, tier: frag.tier, reason: "总预算耗尽" });
        continue;
      }
      const roomForTier = budget.perTier[tier] - usage[tier];
      if (roomForTier <= 0) {
        dropped.push({ id: frag.id, tier: frag.tier, reason: `档位${tier}预算用尽` });
        continue;
      }
      const take = Math.min(frag.chars, roomForTier, usable - used);
      if (take < budget.minCharsPerFragment) {
        dropped.push({ id: frag.id, tier: frag.tier, reason: "剩余空间不足" });
        continue;
      }
      admitted.push({ ...frag, content: frag.content.substring(0, take), chars: take });
      usage[tier] += take;
      used += take;
    }
  }

  return { admitted, dropped, usage, budget };
}

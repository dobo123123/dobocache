/**
 * DoboCache meter — 测量仪表
 * 记录每次请求的命中判定与注入结果，产出可对比的硬核数字：
 * 命中率、平均分、价值分级分布、token 节省、按计价系数折算的相对计费值。
 * v0.2.1 增强：按请求累计曲线（累计命中/未命中 tokens、累计节省估算，计价系数可配）。
 * 用途：在真实会话中对比"开 / 关"两种状态下的命中数据。
 */

import type { HitResult } from "./hitJudge.js";
import type { InjectResult } from "./memoryInject.js";
import type { ValueTier } from "./valueTier.js";

export interface MeterSample {
  type: "judge" | "inject";
  requestId: string;
  ts: number;
  query: string;
  hit: boolean;
  score: number;
  threshold: number;
  candidates: number;
  matched: number;
  injectedTokens: number;
  injectedChars: number;
  tierCounts: Record<ValueTier | "none", number>;
  /** v0.2.1：客户端回传的厂商 usage（prompt_cache_hit_tokens / miss_tokens），用于计费相对值曲线 */
  hitTokens?: number;
  missTokens?: number;
}

/** v0.2.1 计价系数常量：命中/未命中两个计价系数可配（由调用方注入；默认值仅为占位量级，不绑定任何厂商档位，非货币金额） */
export interface MeterPricing {
  hitPricePerM?: number;
  missPricePerM?: number;
}

export interface MeterSnapshot {
  samples: number;
  hits: number;
  hitRate: number | null;          // 判定命中率 %（cf_judge 判定样本口径）；无判定样本时 null=未判定，勿读作 0%
  avgScore: number;
  avgInjectedTokens: number;
  totalInjectedTokens: number;
  estTokensSaved: number;          // 命中时可省下的估算（按匹配条目正文字符估算）
  estCostSavedUsd: number;         // 按两个计价系数之差折算的相对值（保留兼容，非货币金额）
  tierDistribution: Record<string, number>;
  byHour: Array<{ hour: string; hits: number; total: number }>;
  // v0.2.1 计费相对值曲线
  cumHitTokens: number;            // 累计命中 tokens
  cumMissTokens: number;           // 累计未命中 tokens
  cumSavedUsd: number;             // 累计节省估算 = 累计命中 tokens ×（未命中系数 - 命中系数）/M
  cumulative: Array<{ seq: number; cumHitTokens: number; cumMissTokens: number; cumSavedUsd: number }>;
}

/** 采样器：内存态计数器，支持导出快照用于对照实验 */
export class Meter {
  private samples: MeterSample[] = [];
  private hitPricePerM: number;
  private missPricePerM: number;
  private cumHitTokens = 0;
  private cumMissTokens = 0;

  constructor(opts?: MeterPricing | number) {
    if (typeof opts === "number") {
      // 兼容旧构造：单数值视为未命中计价系数，命中计价系数取默认
      this.hitPricePerM = 0.014;
      this.missPricePerM = opts;
    } else {
      this.hitPricePerM = opts?.hitPricePerM ?? 0.014;
      this.missPricePerM = opts?.missPricePerM ?? 0.5;
    }
  }

  /** 每 M token 的计价系数差（未命中系数 - 命中系数） */
  private get priceGapPerM(): number {
    return Math.max(0, this.missPricePerM - this.hitPricePerM);
  }

  record(sample: MeterSample): void {
    this.samples.push(sample);
    this.cumHitTokens += sample.hitTokens ?? 0;
    this.cumMissTokens += sample.missTokens ?? 0;
  }

  reset(): void {
    this.samples = [];
    this.cumHitTokens = 0;
    this.cumMissTokens = 0;
  }

  /** 组装一条采样记录 */
  static sample(args: {
    type?: "judge" | "inject";
    requestId: string;
    query: string;
    hit: HitResult;
    inject?: InjectResult;
    now?: number;
    hitTokens?: number;
    missTokens?: number;
  }): MeterSample {
    const { type = "judge", requestId, query, hit, inject, now = Date.now(), hitTokens, missTokens } = args;
    const tierCounts: Record<ValueTier | "none", number> = { A: 0, B: 0, C: 0, none: 0 };
    if (inject) {
      for (const f of inject.fragments) tierCounts[f.tier] += 1;
    } else {
      tierCounts.none = 1;
    }
    return {
      type,
      requestId,
      ts: now,
      query,
      hit: hit.hit,
      score: hit.score,
      threshold: hit.threshold,
      candidates: hit.stats.candidates,
      matched: hit.matched.length,
      injectedTokens: inject?.tokens ?? 0,
      injectedChars: inject ? estimateChars(inject.prompt) : 0,
      tierCounts,
      hitTokens,
      missTokens,
    };
  }

  /** 记录一次注入动作样本（供分级分布与 token 节省统计，不参与命中率） */
  recordInject(
    requestId: string,
    query: string,
    inject: InjectResult,
    now = Date.now(),
    usage?: { hitTokens?: number; missTokens?: number },
  ): void {
    const emptyHit: HitResult = {
      hit: true,
      score: 0,
      threshold: 0,
      matched: [],
      evidence: [],
      stats: { candidates: 0, afterNegative: 0, primary: 0, cross: 0 },
    };
    this.record(
      Meter.sample({
        type: "inject",
        requestId,
        query,
        hit: emptyHit,
        inject,
        now,
        hitTokens: usage?.hitTokens,
        missTokens: usage?.missTokens,
      }),
    );
  }

  snapshot(): MeterSnapshot {
    const n = this.samples.length;
    const judgeSamples = this.samples.filter((s) => s.type === "judge");
    const judgeN = judgeSamples.length;
    if (judgeN === 0 && n === 0) {
      return {
        samples: 0, hits: 0, hitRate: null, avgScore: 0, avgInjectedTokens: 0,
        totalInjectedTokens: 0, estTokensSaved: 0, estCostSavedUsd: 0,
        tierDistribution: {}, byHour: [],
        cumHitTokens: 0, cumMissTokens: 0, cumSavedUsd: 0, cumulative: [],
      };
    }

    const hits = judgeSamples.filter((s) => s.hit).length;
    const avgScore = judgeSamples.reduce((a, s) => a + s.score, 0) / Math.max(judgeN, 1);
    const avgInjectedTokens = this.samples.reduce((a, s) => a + s.injectedTokens, 0) / Math.max(n, 1);
    const totalInjectedTokens = this.samples.reduce((a, s) => a + s.injectedTokens, 0);
    const estTokensSaved = hits * avgInjectedTokens;
    const estCostSavedUsd = (estTokensSaved / 1_000_000) * this.priceGapPerM;

    const tierDistribution: Record<string, number> = {};
    for (const s of this.samples) {
      for (const t of ["A", "B", "C", "none"] as const) {
        const key = `${t}级片段`;
        tierDistribution[key] = (tierDistribution[key] ?? 0) + s.tierCounts[t];
      }
    }

    // 按小时聚合（近 24h，仅 judge 样本计命中率）
    const byHourMap = new Map<string, { hits: number; total: number }>();
    const now = Date.now();
    for (const s of judgeSamples) {
      const ageHours = Math.floor((now - s.ts) / 3600_000);
      if (ageHours > 23) continue;
      const hourKey = new Date(s.ts).toISOString().slice(11, 13) + "时";
      const agg = byHourMap.get(hourKey) ?? { hits: 0, total: 0 };
      agg.total += 1;
      if (s.hit) agg.hits += 1;
      byHourMap.set(hourKey, agg);
    }
    const byHour = [...byHourMap.entries()]
      .map(([hour, v]) => ({ hour, hits: v.hits, total: v.total }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    // v0.2.1 计费相对值曲线：按样本序号累计
    let cHit = 0;
    let cMiss = 0;
    const cumulative: MeterSnapshot["cumulative"] = [];
    this.samples.forEach((s, idx) => {
      cHit += s.hitTokens ?? 0;
      cMiss += s.missTokens ?? 0;
      cumulative.push({
        seq: idx + 1,
        cumHitTokens: cHit,
        cumMissTokens: cMiss,
        cumSavedUsd: Math.round(((cHit / 1_000_000) * this.priceGapPerM) * 100_000) / 100_000,
      });
    });

    return {
      samples: judgeN,
      hits,
      hitRate: judgeN > 0 ? Math.round((hits / judgeN) * 1000) / 10 : null,
      avgScore: Math.round(avgScore * 10) / 10,
      avgInjectedTokens: Math.round(avgInjectedTokens),
      totalInjectedTokens,
      estTokensSaved,
      estCostSavedUsd: Math.round(estCostSavedUsd * 100_000) / 100_000,
      tierDistribution,
      byHour,
      cumHitTokens: this.cumHitTokens,
      cumMissTokens: this.cumMissTokens,
      cumSavedUsd: Math.round(((this.cumHitTokens / 1_000_000) * this.priceGapPerM) * 100_000) / 100_000,
      cumulative,
    };
  }
}

/** 按注入文本粗略估算字符数 */
function estimateChars(prompt: string): number {
  return prompt.length;
}

/** 工具输出修剪的对照指标：修剪前后体积比 */
export function pruneRatio(originalChars: number, prunedChars: number): number {
  if (originalChars <= 0) return 0;
  return Math.round((1 - prunedChars / originalChars) * 1000) / 10;
}

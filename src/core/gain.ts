/**
 * gain.ts —— v0.8.0 增益判定
 *
 * 目的：回答"接上之后到底有没有拿到缓存收益"，并且**只在数据撑得住的时候才给结论**。
 *
 * 数据来源只有一个：本地白盒日志（dobocache-YYYY-MM-DD.log.jsonl）里由厂商 usage
 * 回传的命中率。拿不到 usage 的请求一律是 hitRate=null（未判定），绝不当作 0% 记账。
 *
 * 判定口径（可测、可复现，不依赖任何金额换算）：
 *   1. 覆盖率 coveragePct = 判定样本 / 全部样本。覆盖率过低说明代理根本没看见 usage
 *      （客户端没走代理、厂商不回 usage、或流式没开 include_usage），此时任何对比都不可信。
 *   2. 前 20%（至少 5 条）判定样本视为冷启动段：前缀还没稳定下来，命中率天然偏低。
 *   3. 稳态段（剩下的判定样本）的中位命中率为结论主体，与冷启动段中位数比较：
 *        - 差 >= +10 个百分点 → gain（观察到增益）
 *        - 差 <  +10 个百分点 → flat（没观察到明显增益）
 *   4. 覆盖率 < 60% 或判定样本 < minSamples → insufficient（数据不足，不下结论）
 *
 * 红线：本模块只输出百分比与 token 数，不做任何金额折算，也不宣称"新版一定更好"。
 */

import fs from "node:fs";
import path from "node:path";

/** 单条可用于判定的样本（从日志行里抽出来的最小字段集） */
export interface GainSample {
  ts: number;
  /** 命中率 0-100；null = 未判定 */
  hitRate: number | null;
  hitTokens: number;
  missTokens: number;
}

export interface GainWindow {
  /** 该段内的全部请求数 */
  calls: number;
  /** 拿到厂商 usage、命中率可判定的请求数 */
  judgedCalls: number;
  /** 命中率中位数（0-100），无判定样本时为 null */
  medianHitRate: number | null;
  /** 命中率均值（0-100），无判定样本时为 null */
  meanHitRate: number | null;
  hitTokens: number;
  missTokens: number;
}

export type GainVerdict = "gain" | "flat" | "insufficient";

export interface GainReport {
  verdict: GainVerdict;
  /** 面向人的一句结论（不含金额、不含"新版更好"之类断言） */
  verdictText: string;
  /** 结论依据逐条列明，便于用户自己复核 */
  reasons: string[];
  /** 全部样本 */
  total: GainWindow & { coveragePct: number | null };
  /** 冷启动段 */
  warmup: GainWindow;
  /** 稳态段 */
  steady: GainWindow;
  /** 稳态 - 冷启动 的中位命中率差（百分点），任一段无数据时 null */
  deltaPct: number | null;
  minSamples: number;
  coverageFloor: number;
  /** 参与统计的日志文件数 */
  logFiles: number;
}

export interface GainOptions {
  /** 判定所需的最少判定样本数，默认 20 */
  minSamples?: number;
  /** 覆盖率门槛（0-100），默认 60 */
  coverageFloor?: number;
  /** 冷启动段比例，默认 0.2 */
  warmupRatio?: number;
  /** 冷启动段最少样本数，默认 5 */
  warmupMin?: number;
  /** 视为"增益"的最小中位差（百分点），默认 10 */
  gainDelta?: number;
}

export const DEFAULT_MIN_SAMPLES = 20;
export const DEFAULT_COVERAGE_FLOOR = 60;
export const DEFAULT_WARMUP_RATIO = 0.2;
export const DEFAULT_WARMUP_MIN = 5;
export const DEFAULT_GAIN_DELTA = 10;
/** 天花板判定：冷启动段中位命中率已达该值，视为高位区，两段差小属预期 */
export const CEILING_PCT = 90;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return round1(value);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((acc, item) => acc + item, 0) / values.length);
}

function isJudged(sample: GainSample): boolean {
  return typeof sample.hitRate === "number" && Number.isFinite(sample.hitRate);
}

/** 单段统计：命中率只统计判定样本，未判定样本只计 calls */
export function summarizeWindow(samples: GainSample[]): GainWindow {
  const judged = samples.filter(isJudged);
  const rates = judged.map((s) => s.hitRate as number);
  return {
    calls: samples.length,
    judgedCalls: judged.length,
    medianHitRate: median(rates),
    meanHitRate: mean(rates),
    hitTokens: judged.reduce((acc, s) => acc + (Number.isFinite(s.hitTokens) ? s.hitTokens : 0), 0),
    missTokens: judged.reduce((acc, s) => acc + (Number.isFinite(s.missTokens) ? s.missTokens : 0), 0),
  };
}

/**
 * 核心判定。纯函数：不吃磁盘、不看时钟，给定样本就能复现结论。
 * 样本先按 ts 升序排好（同一毫秒保持输入顺序），保证分段稳定。
 */
export function judgeGain(samples: GainSample[], options: GainOptions = {}): GainReport {
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? DEFAULT_MIN_SAMPLES));
  const coverageFloor = Math.min(100, Math.max(0, options.coverageFloor ?? DEFAULT_COVERAGE_FLOOR));
  const warmupRatio = Math.min(0.8, Math.max(0, options.warmupRatio ?? DEFAULT_WARMUP_RATIO));
  const warmupMin = Math.max(0, Math.floor(options.warmupMin ?? DEFAULT_WARMUP_MIN));
  const gainDelta = options.gainDelta ?? DEFAULT_GAIN_DELTA;

  const ordered = [...samples].sort((a, b) => a.ts - b.ts);
  const totalWindow = summarizeWindow(ordered);
  const coveragePct =
    totalWindow.calls === 0 ? null : round1((totalWindow.judgedCalls / totalWindow.calls) * 100);
  const total = { ...totalWindow, coveragePct };

  // 冷启动段按"判定样本"切：未判定样本没有命中率，掺进去会稀释分段
  const judgedOrdered = ordered.filter(isJudged);
  const warmupSize = Math.min(
    judgedOrdered.length,
    Math.max(warmupMin, Math.round(judgedOrdered.length * warmupRatio)),
  );
  const warmup = summarizeWindow(judgedOrdered.slice(0, warmupSize));
  const steady = summarizeWindow(judgedOrdered.slice(warmupSize));

  const base = { total, warmup, steady, minSamples, coverageFloor, logFiles: 0 };
  const reasons: string[] = [];

  if (totalWindow.calls === 0) {
    reasons.push("日志目录里没有可读的请求记录（可能还没走过代理，或日志已被清理）");
    return {
      ...base,
      verdict: "insufficient",
      verdictText: "还没有可判定的数据：先正常用几轮，再回来看。",
      reasons,
      deltaPct: null,
    };
  }

  reasons.push(
    `共 ${totalWindow.calls} 次请求，其中 ${totalWindow.judgedCalls} 次拿到厂商 usage（覆盖率 ${coveragePct}%）`,
  );

  if (totalWindow.judgedCalls < minSamples) {
    reasons.push(`判定样本不足：至少需要 ${minSamples} 次带 usage 的请求才给结论`);
    return {
      ...base,
      verdict: "insufficient",
      verdictText: `数据不足：目前只有 ${totalWindow.judgedCalls} 次可判定请求（门槛 ${minSamples} 次），先不下结论。`,
      reasons,
      deltaPct: null,
    };
  }

  if (coveragePct !== null && coveragePct < coverageFloor) {
    reasons.push(
      `覆盖率低于门槛 ${coverageFloor}%：说明多数请求没拿到厂商 usage（可能没走代理，或流式没回 usage 帧），此时对比不可信`,
    );
    return {
      ...base,
      verdict: "insufficient",
      verdictText: `数据不足：只有 ${coveragePct}% 的请求能拿到厂商 usage（门槛 ${coverageFloor}%），先不下结论。`,
      reasons,
      deltaPct: null,
    };
  }

  if (warmup.medianHitRate === null || steady.medianHitRate === null) {
    reasons.push("冷启动段或稳态段缺少命中率样本，无法比较");
    return {
      ...base,
      verdict: "insufficient",
      verdictText: "数据不足：冷启动段或稳态段没有命中率样本，先不下结论。",
      reasons,
      deltaPct: null,
    };
  }

  const deltaPct = round1(steady.medianHitRate - warmup.medianHitRate);
  reasons.push(`冷启动段 ${warmup.judgedCalls} 次，命中率中位数 ${warmup.medianHitRate}%`);
  reasons.push(`稳态段 ${steady.judgedCalls} 次，命中率中位数 ${steady.medianHitRate}%`);
  reasons.push(`两段中位数差 ${deltaPct >= 0 ? "+" : ""}${deltaPct} 个百分点（门槛 +${gainDelta}）`);

  // 天花板效应：冷启动段就已经在高位时，两段差小是预期结果，不能读成"接上没用"
  // 只有"没退化"时才算天花板；稳态明显更低说明前缀在变，那是退化，不能拿高位解释掉
  const nearCeiling = warmup.medianHitRate >= CEILING_PCT && deltaPct >= 0;
  if (nearCeiling) {
    reasons.push(
      `冷启动段命中率已在 ${warmup.medianHitRate}%（≥${CEILING_PCT}%），高位区没有多少上升空间，两段差小属预期`,
    );
  }

  if (deltaPct >= gainDelta) {
    return {
      ...base,
      verdict: "gain",
      verdictText: `观察到增益：稳态命中率中位数比冷启动高 ${deltaPct} 个百分点。`,
      reasons,
      deltaPct,
    };
  }

  if (nearCeiling) {
    return {
      ...base,
      verdict: "flat",
      verdictText: `命中率已经稳定在高位（${warmup.medianHitRate}% → ${steady.medianHitRate}%），没有可上升的余量。`,
      reasons,
      deltaPct,
    };
  }

  return {
    ...base,
    verdict: "flat",
    verdictText:
      deltaPct < 0
        ? `没观察到明显增益：稳态命中率中位数比冷启动低 ${Math.abs(deltaPct)} 个百分点，可能前缀一直在变。`
        : `没观察到明显增益：稳态与冷启动的命中率中位数只差 ${deltaPct} 个百分点。`,
    reasons,
    deltaPct,
  };
}

/** 从一行日志 JSON 里抽样本；字段不合规一律返回 null（绝不猜测、不补零） */
export function sampleFromLogLine(line: string): GainSample | null {
  const text = line.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  const ts = typeof row.ts === "number" && Number.isFinite(row.ts) ? row.ts : null;
  if (ts === null) return null;
  const hitRate =
    typeof row.hitRate === "number" && Number.isFinite(row.hitRate)
      ? Math.min(100, Math.max(0, row.hitRate))
      : null;
  const hitTokens = typeof row.hitTokens === "number" && Number.isFinite(row.hitTokens) ? row.hitTokens : 0;
  const missTokens = typeof row.missTokens === "number" && Number.isFinite(row.missTokens) ? row.missTokens : 0;
  return { ts, hitRate, hitTokens, missTokens };
}

export interface LoadResult {
  samples: GainSample[];
  logFiles: number;
  files: string[];
  /** 读取失败的文件（权限/占用等），只提示不中断 */
  warnings: string[];
}

/**
 * 读取日志目录下所有 DoboCache 自己命名的 JSONL 日志。
 * 只认 dobocache-YYYY-MM-DD.log.jsonl[.N]，目录里其它文件一律不碰（与 whitebox 一致）。
 */
export function loadSamples(logDir: string): LoadResult {
  const result: LoadResult = { samples: [], logFiles: 0, files: [], warnings: [] };
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch (err) {
    result.warnings.push(`日志目录读不了：${(err as Error)?.message ?? String(err)}`);
    return result;
  }
  const pattern = /^dobocache-\d{4}-\d{2}-\d{2}\.log\.jsonl(?:\.\d+)?$/;
  const matched = entries.filter((name) => pattern.test(name)).sort();
  for (const name of matched) {
    const file = path.join(logDir, name);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (err) {
      result.warnings.push(`${name} 读不了：${(err as Error)?.message ?? String(err)}`);
      continue;
    }
    result.logFiles += 1;
    result.files.push(file);
    for (const line of text.split(/\r?\n/)) {
      const sample = sampleFromLogLine(line);
      if (sample) result.samples.push(sample);
    }
  }
  return result;
}

/** 命令行输出：逐行白话，先结论后依据 */
export function formatGainReport(report: GainReport): string {
  const lines: string[] = [];
  lines.push(`增益判定：${report.verdictText}`);
  lines.push("");
  lines.push(`依据（${report.logFiles} 个日志文件）：`);
  for (const reason of report.reasons) lines.push(`  - ${reason}`);
  lines.push("");
  if (report.total.calls > 0) {
    lines.push(
      `请求数 ${report.total.calls}｜命中 tokens ${report.total.hitTokens}｜未命中 tokens ${report.total.missTokens}`,
    );
  }
  lines.push("口径：只看厂商 usage 回传的真实命中率；拿不到 usage 的请求算未判定，不当 0% 记账；不折算金额。");
  return lines.join("\n");
}

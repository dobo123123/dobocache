import { describe, expect, it } from "vitest";
import {
  DEFAULT_COVERAGE_FLOOR,
  DEFAULT_MIN_SAMPLES,
  formatGainReport,
  judgeGain,
  loadSamples,
  sampleFromLogLine,
  summarizeWindow,
  type GainSample,
} from "../src/core/gain.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 造样本：ts 递增，hitRate 为 null 表示未判定 */
function samples(rates: Array<number | null>): GainSample[] {
  return rates.map((rate, index) => ({
    ts: 1_700_000_000_000 + index * 1000,
    hitRate: rate,
    hitTokens: rate === null ? 0 : Math.round(rate * 10),
    missTokens: rate === null ? 0 : Math.round((100 - rate) * 10),
  }));
}

/** 前段低命中、后段高命中：应判为 gain */
const improving: Array<number | null> = [
  ...Array.from({ length: 10 }, () => 10),
  ...Array.from({ length: 30 }, () => 80),
];

describe("增益判定 · 分段统计", () => {
  it("只统计命中率样本，未判定样本只计 calls", () => {
    const window = summarizeWindow(samples([50, null, 70, null]));
    expect(window.calls).toBe(4);
    expect(window.judgedCalls).toBe(2);
    expect(window.medianHitRate).toBe(60);
    expect(window.hitTokens).toBe(500 + 700);
    expect(window.missTokens).toBe(500 + 300);
  });

  it("没有判定样本时中位数为 null，不是 0", () => {
    const window = summarizeWindow(samples([null, null]));
    expect(window.judgedCalls).toBe(0);
    expect(window.medianHitRate).toBeNull();
    expect(window.meanHitRate).toBeNull();
  });
});

describe("增益判定 · 结论三态", () => {
  it("冷启动低、稳态高，差值超过门槛判为 gain", () => {
    const report = judgeGain(samples(improving));
    expect(report.verdict).toBe("gain");
    expect(report.deltaPct).toBeGreaterThanOrEqual(10);
    expect(report.steady.judgedCalls).toBeGreaterThan(0);
    expect(report.total.coveragePct).toBe(100);
  });

  it("前后命中率差不多判为 flat，不硬说成增益", () => {
    const flatRates = Array.from({ length: 40 }, () => 55);
    const report = judgeGain(samples(flatRates));
    expect(report.verdict).toBe("flat");
    expect(report.deltaPct).toBe(0);
    expect(report.verdictText).toContain("没观察到明显增益");
  });

  it("稳态比冷启动更差时也是 flat，并说明可能前缀一直在变", () => {
    const worseRates = [...Array.from({ length: 10 }, () => 90), ...Array.from({ length: 30 }, () => 20)];
    const report = judgeGain(samples(worseRates));
    expect(report.verdict).toBe("flat");
    expect(report.deltaPct).toBeLessThan(0);
    expect(report.verdictText).toContain("低");
  });

  it("样本不足门槛时判为 insufficient，不给结论", () => {
    const report = judgeGain(samples([10, 20, 30]));
    expect(report.verdict).toBe("insufficient");
    expect(report.deltaPct).toBeNull();
    expect(report.verdictText).toContain(String(DEFAULT_MIN_SAMPLES));
  });

  it("覆盖率低于门槛判为 insufficient（拿不到 usage 时不可比）", () => {
    const mostlyUnjudged: Array<number | null> = [];
    for (let i = 0; i < 40; i += 1) mostlyUnjudged.push(70);
    for (let i = 0; i < 60; i += 1) mostlyUnjudged.push(null);
    const report = judgeGain(samples(mostlyUnjudged));
    expect(report.verdict).toBe("insufficient");
    expect(report.total.coveragePct).toBe(40);
    expect(String(report.verdictText)).toContain(String(DEFAULT_COVERAGE_FLOOR));
  });

  it("完全没有日志时判为 insufficient，并说明原因", () => {
    const report = judgeGain([]);
    expect(report.verdict).toBe("insufficient");
    expect(report.total.calls).toBe(0);
    expect(report.total.coveragePct).toBeNull();
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("乱序输入按 ts 重排后再分段，结论与升序一致", () => {
    const ordered = samples(improving);
    const shuffled = [...ordered].reverse();
    const a = judgeGain(ordered);
    const b = judgeGain(shuffled);
    expect(b.verdict).toBe(a.verdict);
    expect(b.deltaPct).toBe(a.deltaPct);
  });

  it("冷启动就已在高位时，两段差小要说明是天花板效应而不是没接上", () => {
    const rates = Array.from({ length: 40 }, (_, i) => (i < 10 ? 95 : 99));
    const report = judgeGain(samples(rates));
    expect(report.verdict).toBe("flat");
    expect(report.reasons.some((r) => r.includes("高位区"))).toBe(true);
    expect(report.verdictText).toContain("高位");
  });

  it("输出文本里不出现金额字样", () => {
    const text = formatGainReport(judgeGain(samples(improving)));
    expect(text).not.toMatch(/美元|USD|人民币|节省了多少钱/);
    expect(text).toContain("增益判定");
  });
});

describe("增益判定 · 日志读取", () => {
  it("日志行解析只认合法字段，坏行返回 null", () => {
    expect(sampleFromLogLine("")).toBeNull();
    expect(sampleFromLogLine("{not json")).toBeNull();
    expect(sampleFromLogLine(JSON.stringify({ hitRate: 50 }))).toBeNull();
    const sample = sampleFromLogLine(JSON.stringify({ ts: 1, hitRate: 42.5, hitTokens: 8, missTokens: 2 }));
    expect(sample).toEqual({ ts: 1, hitRate: 42.5, hitTokens: 8, missTokens: 2 });
    const unjudged = sampleFromLogLine(JSON.stringify({ ts: 2, hitRate: null }));
    expect(unjudged).toEqual({ ts: 2, hitRate: null, hitTokens: 0, missTokens: 0 });
  });

  it("只读自己命名的日志文件，其它文件不碰", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-gain-"));
    fs.writeFileSync(path.join(dir, "dobocache-2026-11-16.log.jsonl"), `${JSON.stringify({ ts: 1, hitRate: 30 })}\n`);
    fs.writeFileSync(path.join(dir, "dobocache-2026-11-15.log.jsonl.1"), `${JSON.stringify({ ts: 0, hitRate: null })}\n`);
    fs.writeFileSync(path.join(dir, "other.jsonl"), `${JSON.stringify({ ts: 9, hitRate: 99 })}\n`);
    const loaded = loadSamples(dir);
    expect(loaded.logFiles).toBe(2);
    expect(loaded.samples.length).toBe(2);
    expect(loaded.samples.every((s) => s.ts < 9)).toBe(true);
    expect(loaded.warnings).toEqual([]);
  });

  it("日志目录不存在时返回告警而不是抛错", () => {
    const loaded = loadSamples(path.join(os.tmpdir(), "dobocache-gain-not-exist-xyz"));
    expect(loaded.samples).toEqual([]);
    expect(loaded.warnings.length).toBe(1);
  });
});

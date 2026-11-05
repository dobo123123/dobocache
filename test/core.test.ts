/**
 * DoboCache 核心算法单元测试
 * 覆盖：命中判定（评分/负向/时效/交叉关联）、价值分级准入、
 *       稳定注入（确定性）、确定性序列化、工具输出修剪、
 *       白盒日志（累计/落盘）、v0.4.1 白盒报告即时摘要卡片。
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeHit, classifyTokens, timeDecay, extractNegativeTerms, type CacheEntry } from "../src/core/hitJudge.js";
import { purifyMemoryText, gradeFragment, admitByTier, DEFAULT_BUDGET } from "../src/core/valueTier.js";
import {
  injectMemory,
  injectIncremental,
  buildStablePrefix,
  distillRules,
  extractVolatileParts,
  resolveRulesForScenario,
  topUpPrefixToMin,
  FIRST_TURN_RULES,
  FULL_RULES,
  BALANCED_RULES,
  rulesForStrictness,
  DEFAULT_MIN_PREFIX_SAFETY_FACTOR,
  SessionInjectStore,
  DEFAULT_MIN_PREFIX_TOKENS,
} from "../src/core/memoryInject.js";
import { Meter } from "../src/core/meter.js";
import { parseNodeMajor, checkNodeVersion, MIN_NODE_MAJOR } from "../src/utils/runtime.js";
import { platformLogDir, resolveLogDir } from "../src/utils/logDir.js";
import { WhiteboxLogger, detectDuplicateLines, formatReportCard, sanitizeForLog, resolveCardMode, CARD_MODE_ENV } from "../src/core/whitebox.js";
import { stableKey, stableStringify, estimateTokens, hashString } from "../src/utils/serialize.js";
import { pruneToolOutput } from "../src/utils/prune.js";
import { fingerprintPrompt, fingerprintSession, ensureRequestId, ensureSessionId } from "../src/utils/privacy.js";

const now = 1_750_000_000_000;

function entry(partial: Partial<CacheEntry> & { query: string }): CacheEntry {
  return {
    id: partial.id ?? `e${Math.random().toString(36).slice(2, 8)}`,
    query: partial.query,
    response: partial.response,
    content: partial.content ?? `${partial.query}\n${partial.response ?? ""}`,
    category: partial.category,
    timestamp: partial.timestamp ?? now,
    hitCount: partial.hitCount,
  };
}

describe("hitJudge 命中判定", () => {
  it("关键词分层分类：实体锚词与意图词分离，虚词剔除", () => {
    const c = classifyTokens("帮我优化 DoboCache 的缓存命中率 计算 token 节省");
    expect(c.entities.length).toBeGreaterThanOrEqual(1);
    expect(c.entities).toContain("DoboCache");
    expect(c.intents.length).toBeGreaterThanOrEqual(1);
    expect(c.all).not.toContain("帮我");
  });

  it("时效衰减：1 天内 1.0，1~7 天 0.7，7 天以上 0.4", () => {
    const day = 24 * 3600 * 1000;
    expect(timeDecay(now - day * 0.5, now)).toBe(1.0);
    expect(timeDecay(now - day * 3, now)).toBe(0.7);
    expect(timeDecay(now - day * 30, now)).toBe(0.4);
  });

  it("否定排除词提取", () => {
    expect(extractNegativeTerms("不要提及采购流程")).toContain("采购流程");
    expect(extractNegativeTerms("正常问题")).toHaveLength(0);
  });

  it("实体锚词命中高分条目可判定命中", () => {
    const entries = [
      entry({ query: "DoboCache 缓存命中优化方案", response: "稳定前缀+价值分级准入", category: "开发" }),
      entry({ query: "今天天气怎么样", response: "晴", category: "日常" }),
    ];
    const r = judgeHit("DoboCache 缓存命中优化方案 怎么做", entries, { now, threshold: 5 });
    expect(r.hit).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(5);
    expect(r.matched[0].entry.id).toBe(entries[0].id);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("无关请求不命中", () => {
    const entries = [entry({ query: "季度销售报表汇总", response: "按区域分组", category: "办公" })];
    const r = judgeHit("帮我写一首关于秋天的诗", entries, { now, threshold: 5 });
    expect(r.hit).toBe(false);
  });

  it("负向过滤：黑名单命中条目不参与评分", () => {
    const entries = [
      entry({ query: "供应商对账流程", response: "按月核对", category: "财务" }),
      entry({ query: "DoboCache 开发", response: "TS 重写", category: "开发" }),
    ];
    const r = judgeHit("DoboCache 开发", entries, { now, blacklist: ["供应商"] });
    expect(r.matched.some((m) => m.entry.id === entries[1].id)).toBe(true);
    expect(r.matched.some((m) => m.entry.id === entries[0].id)).toBe(false);
  });

  it("交叉关联：首轮高分条目实体可召回关联条目", () => {
    const entries = [
      entry({ query: "DoboCache 命中判定阈值", response: "默认阈值 5，可调", category: "开发" }),
      entry({ query: "阈值设置建议", response: "通过配置项调整", category: "开发" }),
      entry({ query: "今天晚饭吃什么", response: "火锅", category: "日常" }),
    ];
    const r = judgeHit("DoboCache 命中判定", entries, { now, threshold: 5 });
    expect(r.matched.length).toBeGreaterThanOrEqual(2);
    expect(r.matched.map((m) => m.entry.id)).toContain(entries[1].id);
  });
});

describe("valueTier 价值分级准入", () => {
  it("记忆提纯：去客套与免责声明", () => {
    const raw = "好的，以下是根据您提供的信息整理的方案：\n本回答由 AI 生成，内容仅供参考，请仔细甄别。";
    const purified = purifyMemoryText(raw);
    expect(purified).not.toContain("好的");
    expect(purified).not.toContain("本回答由 AI 生成");
  });

  it("高相关短片段评为 A 档，弱相关长片段评为 C 档", () => {
    const a = gradeFragment("1", "稳定前缀工程：字节级固定前缀保证厂商缓存命中，只追加不修改。", 6, now, now);
    const c = gradeFragment("2", "随便一句话。", 0, now, now);
    expect(a.tier).toBe("A");
    expect(c.tier).toBe("C");
  });

  it("预算准入按档位顺序填充且不超总预算", () => {
    const frags = [
      gradeFragment("a", "A 档高价值内容：缓存命中核心算法与测量仪表设计要点。", 8, now, now),
      gradeFragment("b", "B 档内容：一些补充说明和实现细节。", 4, now, now),
      gradeFragment("c", "C 档低价值内容。", 1, now, now),
    ];
    const result = admitByTier(frags, DEFAULT_BUDGET);
    const total = result.usage.A + result.usage.B + result.usage.C;
    expect(total).toBeLessThanOrEqual(DEFAULT_BUDGET.totalChars - DEFAULT_BUDGET.reservedChars);
    expect(result.admitted.length).toBeGreaterThanOrEqual(1);
  });

  it("超长冗余片段被降级为 C", () => {
    const long = "x".repeat(6000);
    const f = gradeFragment("long", long, 10, now, now);
    expect(f.tier).toBe("C");
  });
});

describe("memoryInject 稳定注入", () => {
  it("稳定前缀：版本化且字节固定", () => {
    const p1 = buildStablePrefix({ version: "v1", constraints: ["约束A"] });
    const p2 = buildStablePrefix({ version: "v1", constraints: ["约束A"] });
    expect(p1).toBe(p2);
    expect(p1).toContain("v1");
  });

  it("注入结果确定性：同输入两次输出完全一致", () => {
    const frags = [
      { id: "a", content: "稳定前缀工程要点", rawChars: 8, chars: 8, score: 9, tier: "A" as const },
      { id: "b", content: "测量仪表快照", rawChars: 6, chars: 6, score: 4, tier: "B" as const },
    ];
    const r1 = injectMemory("当前请求文本", frags);
    const r2 = injectMemory("当前请求文本", frags);
    expect(r1.prompt).toBe(r2.prompt);
    expect(r1.prefix).toBe(r2.prefix);
    expect(r1.tail).toBe("当前请求文本");
  });

  it("A 档片段排在 B 档之前", () => {
    const frags = [
      { id: "b", content: "B 档内容片段", rawChars: 6, chars: 6, score: 3, tier: "B" as const },
      { id: "a", content: "A 档内容片段", rawChars: 6, chars: 6, score: 9, tier: "A" as const },
    ];
    const r = injectMemory("q", frags);
    const idxA = r.body.indexOf("A 档内容片段");
    const idxB = r.body.indexOf("B 档内容片段");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it("规则提炼：从 A 档片段提取首行约束", () => {
    const frags = [
      { id: "a", content: "必须使用稳定前缀工程保证缓存命中。", rawChars: 20, chars: 20, score: 10, tier: "A" as const },
    ];
    const rules = distillRules(frags);
    expect(rules.constraints.length).toBeGreaterThanOrEqual(4);
  });
});

describe("utils 确定性工具", () => {
  it("stableKey 忽略空白差异", () => {
    expect(stableKey(["a  b", "c"])).toBe(stableKey(["a b", "c"]));
  });

  it("stableStringify 键排序", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("estimateTokens 中英文估算", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("缓存")).toBe(2);
  });
});

describe("prune 工具输出修剪", () => {
  it("去重行并压缩体积", () => {
    const raw = ["行1", "行1", "行2  重复空白", "", "行3"].join("\n");
    const r = pruneToolOutput(raw, { maxChars: 500, maxLines: 100 });
    expect(r.text).not.toContain("行1\n行1");
    expect(r.prunedChars).toBeLessThanOrEqual(r.originalChars);
    expect(r.ratio).toBeGreaterThanOrEqual(0);
  });

  it("确定性：同一输入同一输出", () => {
    const raw = "alpha\nbeta\ngamma";
    expect(pruneToolOutput(raw).text).toBe(pruneToolOutput(raw).text);
  });

  it("超长截断到 maxChars", () => {
    const r = pruneToolOutput("x".repeat(3000), { maxChars: 500 });
    expect(r.text.length).toBeLessThanOrEqual(500);
  });
});

describe("v0.2 会话增量注入", () => {
  const frags = (): Array<{
    id: string; content: string; rawChars: number; chars: number; score: number; tier: "A" | "B";
  }> => [
    { id: "a", content: "稳定前缀工程：字节级固定前缀保证厂商缓存命中。", rawChars: 24, chars: 24, score: 9, tier: "A" },
    { id: "b", content: "测量仪表快照与成本估算。", rawChars: 14, chars: 14, score: 4, tier: "B" },
  ];

  it("跨轮前缀复用：同 session 同片段，前缀与 hash 不变，tail 只含本轮新请求", () => {
    const r1 = injectIncremental("问题1", frags(), { sessionId: "s1" });
    const r2 = injectIncremental("问题2", frags(), {
      sessionId: "s1",
      previousPrefixHash: r1.prefixHash,
    });
    expect(r2.prefix).toBe(r1.prefix);
    expect(r2.prefixHash).toBe(r1.prefixHash);
    expect(r2.reusedPrefix).toBe(true);
    expect(r2.tail).toBe("问题2");
    expect(r2.prompt).toBe(r1.prefix + "问题2");
    expect(r2.prompt).not.toContain("问题1");
  });

  it("片段变化时前缀重建，reusedPrefix=false 且 hash 更新", () => {
    const r1 = injectIncremental("问题1", frags(), { sessionId: "s2" });
    const changed = [...frags(), { id: "c", content: "新增高价值片段内容。", rawChars: 10, chars: 10, score: 7, tier: "A" as const }];
    const r2 = injectIncremental("问题2", changed, {
      sessionId: "s2",
      previousPrefixHash: r1.prefixHash,
    });
    expect(r2.reusedPrefix).toBe(false);
    expect(r2.prefixHash).not.toBe(r1.prefixHash);
  });

  it("无 session 单发：同输入确定性且 hash 一致", () => {
    const r1 = injectIncremental("问题1", frags());
    const r2 = injectIncremental("问题1", frags());
    expect(r1.prompt).toBe(r2.prompt);
    expect(r1.prefixHash).toBe(r2.prefixHash);
    expect(r1.reusedPrefix).toBe(false);
  });

  it("SessionInjectStore：冻结片段复用与重置", () => {
    const store = new SessionInjectStore();
    const frozen = { sessionId: "s", prefixHash: "h", prefix: "p", body: "b", fragments: frags(), scenario: "full" as const, createdAt: now };
    store.set("s", frozen);
    expect(store.has("s")).toBe(true);
    expect(store.get("s")?.prefixHash).toBe("h");
    store.remove("s");
    expect(store.has("s")).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe("v0.2 最小有效前缀长度策略", () => {
  it("门槛默认 256 tokens（v0.4.2：200→256，依据实测门槛盲区）", () => {
    expect(DEFAULT_MIN_PREFIX_TOKENS).toBe(256);
  });

  it("前缀不足门槛时先补高价值片段再补固定文档块", () => {
    const prefix = "【DoboCache 缓存上下文】 v1\n- 测试约束\n\n";
    const pool = [
      { id: "p1", content: "补充片段一：高价值记忆内容。", rawChars: 16, chars: 16, score: 8, tier: "A" as const },
    ];
    const docs = ["x".repeat(300)];
    const r = topUpPrefixToMin(prefix, pool, docs, 200);
    expect(r.addedFragments + r.addedDocs).toBeGreaterThan(0);
    expect(r.prefix.length).toBeGreaterThan(prefix.length);
  });

  it("injectIncremental 自动过门槛：prefixReady=true 且 prefixTokens 达标", () => {
    const r = injectIncremental("q", [], {
      minPrefixDocBlocks: ["y".repeat(800)],
      scenario: "first",
    });
    expect(r.prefixReady).toBe(true);
    expect(r.prefixTokens).toBeGreaterThanOrEqual(256);
    expect(r.poolUsed).toBeGreaterThan(0);
  });

  it("门槛不可达时如实返回 prefixReady=false", () => {
    const r = injectIncremental("q", [], {
      minPrefixTokens: 10_000,
      minPrefixDocBlocks: ["短"],
      scenario: "first",
    });
    expect(r.prefixReady).toBe(false);
  });
});

describe("v0.2 约束指令场景化", () => {
  it("FIRST_TURN_RULES 不含禁止编造类硬约束，FULL_RULES 含", () => {
    expect(FULL_RULES.constraints.some((c) => c.includes("禁止编造"))).toBe(true);
    expect(FIRST_TURN_RULES.constraints.some((c) => c.includes("禁止编造"))).toBe(false);
  });

  it("缓存为空（无片段）时放行自由回答：scenario=first", () => {
    const r = injectIncremental("q", [], { minPrefixTokens: 5, scenario: undefined });
    expect(r.scenario).toBe("first");
    expect(r.prefix).not.toContain("禁止编造");
  });

  it("缓存充足（有片段且前缀达标）时启用完整约束：scenario=full", () => {
    const frags = [{ id: "a", content: "稳定前缀工程要点内容。", rawChars: 12, chars: 12, score: 9, tier: "A" as const }];
    const r = injectIncremental("q", frags, { minPrefixTokens: 5 });
    expect(r.scenario).toBe("full");
    expect(r.prefix).toContain("禁止编造");
  });

  it("resolveRulesForScenario 显式场景优先", () => {
    expect(resolveRulesForScenario({ scenario: "first" }).scenario).toBe("first");
    expect(resolveRulesForScenario({ scenario: "full" }).rules).toBe(FULL_RULES);
    expect(resolveRulesForScenario({ hasAdmitted: true, prefixTokens: 300, minPrefixTokens: 200 }).scenario).toBe("full");
    expect(resolveRulesForScenario({ hasAdmitted: true, prefixTokens: 50, minPrefixTokens: 200 }).scenario).toBe("first");
  });
});

describe("v0.4.2 strictness 与安全余量", () => {
  it("rulesForStrictness 映射：strict/balanced/loose", () => {
    expect(rulesForStrictness("strict")).toBe(FULL_RULES);
    expect(rulesForStrictness("balanced")).toBe(BALANCED_RULES);
    expect(rulesForStrictness("loose")).toBe(FIRST_TURN_RULES);
  });

  it("balanced 约束：full 场景允许标注推测，不含禁止编造硬约束", () => {
    const frags = [{ id: "a", content: "稳定前缀工程要点内容。", rawChars: 12, chars: 12, score: 9, tier: "A" as const }];
    const r = injectIncremental("q", frags, { minPrefixTokens: 5, strictness: "balanced" });
    expect(r.scenario).toBe("full");
    expect(r.strictness).toBe("balanced");
    expect(r.prefix).toContain("标注为推测");
    expect(r.prefix).not.toContain("禁止编造");
  });

  it("loose 约束：full 场景自由放行", () => {
    const frags = [{ id: "a", content: "稳定前缀工程要点内容。", rawChars: 12, chars: 12, score: 9, tier: "A" as const }];
    const r = injectIncremental("q", frags, { minPrefixTokens: 5, strictness: "loose" });
    expect(r.prefix).not.toContain("禁止编造");
    expect(r.strictness).toBe("loose");
  });

  it("默认门槛 256 × 安全余量 1.15 → effectiveMinPrefixTokens=295", () => {
    const r = injectIncremental("q", [], { minPrefixDocBlocks: ["y".repeat(800)], scenario: "first" });
    expect(DEFAULT_MIN_PREFIX_SAFETY_FACTOR).toBe(1.15);
    expect(r.effectiveMinPrefixTokens).toBe(Math.ceil(256 * 1.15)); // 295
    expect(r.prefixReady).toBe(true);
  });

  it("自定义 safetyFactor=1 时有效门槛等于 minPrefixTokens", () => {
    const r = injectIncremental("q", [], {
      minPrefixTokens: 50,
      minPrefixSafetyFactor: 1,
      minPrefixDocBlocks: ["y".repeat(800)],
      scenario: "first",
    });
    expect(r.effectiveMinPrefixTokens).toBe(50);
  });

  it("frozenFragmentsTokens：有冻结片段时输出其 tokens", () => {
    const frags = [{ id: "a", content: "稳定知识片段：缓存命中算法要点。", rawChars: 20, chars: 20, score: 9, tier: "A" as const }];
    const r1 = injectIncremental("问题1", frags, { sessionId: "v42", minPrefixTokens: 5, align128: false });
    const r2 = injectIncremental("问题2", frags, {
      sessionId: "v42",
      minPrefixTokens: 5,
      align128: false,
      previousFrozenFragments: frags,
    });
    expect(r1.frozenFragmentsTokens).toBeUndefined();
    expect(r2.frozenFragmentsTokens).toBeGreaterThan(0);
    expect(r2.frozenHitRatio).toBe(100);
  });
});

describe("v0.2 易变内容强制 tail", () => {
  it("extractVolatileParts：剥离时间戳与会话标记", () => {
    const raw = "当前时间：2026-11-02 10:00:00\n会话ID: abc12345\n请总结缓存设计";
    const parts = extractVolatileParts(raw);
    expect(parts.hasVolatile).toBe(true);
    expect(parts.volatile.length).toBeGreaterThanOrEqual(2);
    expect(parts.stable).toContain("请总结缓存设计");
    expect(parts.stable).not.toContain("2026-11-02");
    expect(parts.stable).not.toContain("abc12345");
  });

  it("injectIncremental：易变内容只进 tail，前缀不含易变片段", () => {
    const frags = [
      { id: "a", content: "稳定知识片段：缓存命中算法要点。", rawChars: 18, chars: 18, score: 9, tier: "A" as const },
      { id: "v", content: "时间戳 2026-11-02 更新说明内容。", rawChars: 20, chars: 20, score: 5, tier: "B" as const },
    ];
    const r = injectIncremental("当前时间：2026-11-02 09:30:00\n最新消息 完成测试\n总结", frags, {
      minPrefixTokens: 5,
    });
    expect(r.volatile.length).toBeGreaterThan(0);
    expect(r.prefix).not.toContain("2026-11-02");
    expect(r.prefix).not.toContain("最新消息");
    expect(r.tail).toContain("2026-11-02");
  });

  it("显式 volatile 参数强制进 tail", () => {
    const r = injectIncremental("普通请求", [], {
      volatile: ["会话标记: sess_abcdefgh"],
      scenario: "first",
    });
    expect(r.tail).toContain("sess_abcdefgh");
    expect(r.prefix).not.toContain("sess_abcdefgh");
  });
});

describe("v0.2 前缀指纹", () => {
  it("hashString 确定性且敏感", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    expect(hashString("")).toBe("0000000000000000");
  });
});

describe("v0.2.1 prefixHash 冻结语义修复", () => {
  const f = (): Array<{ id: string; content: string; rawChars: number; chars: number; score: number; tier: "A" | "B" }> => [
    { id: "a", content: "稳定前缀工程：字节级固定前缀保证厂商缓存命中。", rawChars: 24, chars: 24, score: 9, tier: "A" },
    { id: "b", content: "测量仪表快照与成本估算。", rawChars: 14, chars: 14, score: 4, tier: "B" },
  ];

  it("reusedPrefix 与冻结前缀逐字节比对：一致 true 且 frozenHitRatio=100", () => {
    const r1 = injectIncremental("问题1", f(), { sessionId: "fz1", minPrefixTokens: 200, align128: false });
    const r2 = injectIncremental("问题2", f(), {
      sessionId: "fz1",
      previousFrozenPrefix: r1.prefix,
      previousFrozenFragments: f(),
      minPrefixTokens: 200,
      align128: false,
    });
    expect(r2.reusedPrefix).toBe(true);
    expect(r2.frozenHitRatio).toBe(100);
    expect(r2.frozenReused.reused).toEqual(["a", "b"]);
    expect(r2.frozenReused.replaced).toHaveLength(0);
  });

  it("片段被替换时 frozenReused 明细与比例正确，reusedPrefix=false", () => {
    const r1 = injectIncremental("问题1", f(), { sessionId: "fz2", minPrefixTokens: 5, align128: false });
    const changed = [
      { id: "a", content: "稳定前缀工程：字节级固定前缀保证厂商缓存命中。", rawChars: 24, chars: 24, score: 9, tier: "A" as const },
      { id: "c", content: "新增高价值片段替换旧 B 档。", rawChars: 16, chars: 16, score: 7, tier: "A" as const },
    ];
    const r2 = injectIncremental("问题2", changed, {
      sessionId: "fz2",
      previousFrozenPrefix: r1.prefix,
      previousFrozenFragments: f(),
      minPrefixTokens: 5,
      align128: false,
    });
    expect(r2.reusedPrefix).toBe(false);
    expect(r2.frozenReused.reused).toEqual(["a"]);
    expect(r2.frozenReused.replaced).toEqual(["b"]);
    expect(r2.frozenHitRatio).toBe(50);
  });

  it("无冻结信息时回落 previousPrefixHash 语义", () => {
    const r1 = injectIncremental("问题1", f(), { sessionId: "fz3", minPrefixTokens: 200, align128: false });
    const r2 = injectIncremental("问题2", f(), {
      sessionId: "fz3",
      previousPrefixHash: r1.prefixHash,
      minPrefixTokens: 200,
      align128: false,
    });
    expect(r2.reusedPrefix).toBe(true);
  });
});

describe("v0.2.1 128-token 对齐", () => {
  it("默认开启：prefixTokens 为 128 的倍数且追加对齐块", () => {
    const r = injectIncremental("q", [], { minPrefixDocBlocks: ["y".repeat(800)], scenario: "first" });
    expect(r.prefixTokens % 128).toBe(0);
    expect(r.alignBlocks).toBeGreaterThanOrEqual(0);
  });

  it("align128=false 恢复原行为：不追加对齐块", () => {
    const r = injectIncremental("q", [], { minPrefixDocBlocks: ["y".repeat(800)], scenario: "first", align128: false });
    expect(r.alignBlocks).toBe(0);
    expect(r.prefixTokens % 128).not.toBe(0);
  });
});

describe("v0.2.1 首轮空窗修复", () => {
  it("前缀不足门槛时循环补文档块必然达标", () => {
    const r = topUpPrefixToMin("短前缀", [], ["短块"], 200);
    expect(estimateTokens(r.prefix)).toBeGreaterThanOrEqual(200);
  });

  it("maxTokens 收缩后返回 prefixReady / prefixTokens / prefixHash 与最终前缀一致", () => {
    const r = injectIncremental("q", [
      { id: "a", content: "A".repeat(400), rawChars: 400, chars: 400, score: 9, tier: "A" as const },
      { id: "b", content: "B".repeat(300), rawChars: 300, chars: 300, score: 6, tier: "A" as const },
    ], { minPrefixTokens: 200, maxTokens: 300, align128: false });
    expect(estimateTokens(r.prefix)).toBe(r.prefixTokens);
    expect(r.prefixReady).toBe(r.prefixTokens >= (r.effectiveMinPrefixTokens ?? 200));
    expect(r.prefixHash).toBe(hashString(r.prefix));
  });

  it("maxTokens 提高时首轮多并入高价值片段（软上限随之放宽）", () => {
    const pool = [
      { id: "p1", content: "高价值片段 A：首轮应并入。", rawChars: 14, chars: 14, score: 9, tier: "A" as const },
      { id: "p2", content: "高价值片段 B：次选。", rawChars: 10, chars: 10, score: 7, tier: "A" as const },
    ];
    const rSmall = injectIncremental("q", [], {
      minPrefixDocBlocks: [],
      poolFragments: pool,
      maxTokens: 100,
      align128: false,
    });
    const rBig = injectIncremental("q", [], {
      minPrefixDocBlocks: [],
      poolFragments: pool,
      maxTokens: 500,
      align128: false,
    });
    // maxTokens 提高 → 前缀软上限 max*0.8 提高，能并入更多池片段
    expect(rBig.fragments.length).toBeGreaterThanOrEqual(rSmall.fragments.length);
  });
});

describe("v0.2.1 meter 成本曲线", () => {
  const judgeSample = (over: {
    requestId: string; hit: boolean; hitTokens?: number; missTokens?: number;
  }) => ({
    type: "judge" as const,
    requestId: over.requestId,
    ts: 1,
    query: "q",
    hit: over.hit,
    score: 6,
    threshold: 5,
    candidates: 2,
    matched: 1,
    injectedTokens: 100,
    injectedChars: 300,
    tierCounts: { A: 1, B: 0, C: 0, none: 0 },
    hitTokens: over.hitTokens,
    missTokens: over.missTokens,
  });

  it("累计命中/未命中 tokens 与逐样本累计曲线", () => {
    const m = new Meter({ hitPricePerM: 0.014, missPricePerM: 0.5 });
    m.record(judgeSample({ requestId: "r1", hit: true, hitTokens: 128, missTokens: 50 }));
    m.record(judgeSample({ requestId: "r2", hit: true, hitTokens: 256, missTokens: 60 }));
    const s = m.snapshot();
    expect(s.cumHitTokens).toBe(384);
    expect(s.cumMissTokens).toBe(110);
    expect(s.cumulative).toHaveLength(2);
    expect(s.cumulative[0]).toMatchObject({ seq: 1, cumHitTokens: 128, cumMissTokens: 50 });
    expect(s.cumulative[1].cumHitTokens).toBe(384);
    expect(s.cumSavedUsd).toBeCloseTo(Math.round((384 * 0.486 / 1_000_000) * 100_000) / 100_000, 5);
    expect(s.hits).toBe(2);
    expect(s.hitRate).toBe(100);
  });

  it("v0.4.6 语义：无判定样本时 meter 快照 hitRate 为 null，不写 0", () => {
    const empty = new Meter();
    expect(empty.snapshot().samples).toBe(0);
    expect(empty.snapshot().hitRate).toBeNull(); // 未判定 ≠ 0% 命中
    empty.reset();
    expect(empty.snapshot().hitRate).toBeNull(); // reset 后同样为 null
    empty.record(judgeSample({ requestId: "r1", hit: false }));
    expect(empty.snapshot().hitRate).toBe(0);    // 有样本后恢复数值口径
  });

  it("默认价差常量可配，支持构造参数覆盖", () => {
    const d = new Meter();
    const custom = new Meter({ hitPricePerM: 0.1, missPricePerM: 1.0 });
    const base = judgeSample({ requestId: "c1", hit: true, hitTokens: 128, missTokens: 0 });
    d.record(base);
    custom.record(base);
    expect(d.snapshot().cumSavedUsd).toBeCloseTo(Math.round((128 * 0.486 / 1_000_000) * 100_000) / 100_000, 5);
    expect(custom.snapshot().cumSavedUsd).toBeCloseTo(Math.round((128 * 0.9 / 1_000_000) * 100_000) / 100_000, 5);
  });

  it("recordInject 注入样本也计入成本曲线", () => {
    const m = new Meter();
    m.recordInject("rid", "q", {
      prompt: "p", prefix: "pre", body: "", tail: "q", tokens: 10,
      prefixHash: "h", prefixTokens: 5, prefixReady: true, reusedPrefix: false,
      scenario: "first", volatile: [], fragments: [], poolUsed: 0,
      frozenHitRatio: 0, frozenReused: { reused: [], replaced: [] }, alignBlocks: 0,
    }, 1, { hitTokens: 128, missTokens: 20 });
    const s = m.snapshot();
    expect(s.cumHitTokens).toBe(128);
    expect(s.cumMissTokens).toBe(20);
    expect(s.cumulative).toHaveLength(1);
  });
});


describe("v0.4.0 白盒日志模块", () => {
  function makeReport(over: Record<string, unknown> = {}) {
    return {
      requestId: "req-1",
      ts: now,
      rawTokens: 1200,
      optimizedTokens: 892,
      hitRate: 93,
      savedTokens: 308,
      savedPct: 25.67,
      savedUsd: 0.0002,
      changes: [{ kind: "prefix-stabilize", label: "前缀稳定化" }],
      ...over,
    };
  }

  it("buildReport 口径：raw - optimized = savedTokens，savedPct 与 hitRate 正确", () => {
    const w = new WhiteboxLogger({ fileWrite: false });
    const r = w.buildReport({
      requestId: "r1",
      rawTokens: 1200,
      optimizedTokens: 892,
      hitRate: 93,
      changes: [{ kind: "dedup", label: "去重" }],
    });
    expect(r.savedTokens).toBe(308);
    expect(r.savedPct).toBeCloseTo(25.67, 1);
    expect(r.hitRate).toBe(93);
    // 有厂商 hitTokens 时按价差估算节省量
    const r2 = w.buildReport({
      requestId: "r2",
      rawTokens: 1000,
      optimizedTokens: 1000,
      hitTokens: 500_000,
      missTokens: 20_000,
      changes: [],
    });
    expect(r2.hitRate).toBe(96.2);
    expect(r2.savedUsd).toBeGreaterThan(0);
  });

  it("record 累计：today/total 统计正确（calls/rawTokens/savedUsd/hitRate 均值）", () => {
    const w = new WhiteboxLogger({ fileWrite: false });
    w.record(makeReport({ hitRate: 90, rawTokens: 1000, optimizedTokens: 700, savedTokens: 300, savedUsd: 0.0003 }));
    w.record(makeReport({ requestId: "req-2", hitRate: 50, rawTokens: 1000, optimizedTokens: 800, savedTokens: 200, savedUsd: 0.0002 }));
    const rep = w.report();
    expect(rep.today.calls).toBe(2);
    expect(rep.total.calls).toBe(2);
    expect(rep.today.rawTokens).toBe(2000);
    expect(rep.today.savedTokens).toBe(500);
    expect(rep.today.savedUsd).toBeCloseTo(0.0005, 6);
    expect(rep.today.hitRate).toBe(70); // (90+50)/2
    expect(rep.today.savedPct).toBe(25); // 500/2000
  });

  it("跨自然日滚动：新的一天 today 重置，total 保留", () => {
    const w = new WhiteboxLogger({ fileWrite: false });
    w.record(makeReport({ ts: new Date(2026, 10, 2, 10).getTime(), rawTokens: 1000 }));
    expect(w.report().today.calls).toBe(1);
    w.record(makeReport({ requestId: "req-3", ts: new Date(2026, 10, 3, 10).getTime(), rawTokens: 500 }));
    const rep = w.report();
    expect(rep.today.calls).toBe(1);
    expect(rep.today.rawTokens).toBe(500);
    expect(rep.total.calls).toBe(2);
  });

  it("JSONL 落盘：fileWrite=true 追加到日志目录，内容可读回", () => {
    const dir = path.join(os.tmpdir(), `cf-whitebox-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true });
    w.record(makeReport({ rawTokens: 1000, optimizedTokens: 800, savedTokens: 200 }));
    w.record(makeReport({ requestId: "req-2", rawTokens: 2000, optimizedTokens: 1000, savedTokens: 1000 }));
    const logFile = w.logFileFor(now);
    expect(fs.existsSync(logFile)).toBe(true);
    const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as { rawTokens: number };
    expect(first.rawTokens).toBe(1000);
  });

  it("detectDuplicateLines 检测重复行", () => {
    const d = detectDuplicateLines("请用 JSON 输出\n请用 JSON 输出\n别啰嗦\n请用 JSON 输出");
    expect(d.count).toBe(1);
    expect(d.lines[0]).toBe("请用 JSON 输出");
  });

  it("reset 清空今日与累计", () => {
    const w = new WhiteboxLogger({ fileWrite: false });
    w.record(makeReport());
    w.reset();
    const rep = w.report();
    expect(rep.today.calls).toBe(0);
    expect(rep.total.calls).toBe(0);
    // v0.4.6：没有样本时命中率是"未判定"（null），不再是 0%，避免把"没测到"读成"0% 命中"
    expect(rep.today.hitRate).toBeNull();
    expect(rep.today.judgedCalls).toBe(0);
  });

  it("v0.4.2 per_session 聚合：按 sessionId 分组累计，默认 total 不输出 perSession", () => {
    const w = new WhiteboxLogger({ fileWrite: false, aggregateBy: "per_session" });
    w.record(makeReport({ sessionId: "s1", hitRate: 100, rawTokens: 1000, optimizedTokens: 500, savedTokens: 500, savedUsd: 0.0004 }));
    w.record(makeReport({ requestId: "req-2", sessionId: "s1", hitRate: 80, rawTokens: 500, optimizedTokens: 300, savedTokens: 200, savedUsd: 0.0001 }));
    w.record(makeReport({ requestId: "req-3", sessionId: "s2", hitRate: 60, rawTokens: 400, optimizedTokens: 300, savedTokens: 100, savedUsd: 0.00005 }));
    const rep = w.report();
    expect(rep.perSession).toBeDefined();
    const s1 = rep.perSession!.find((p) => p.sessionId === "s1");
    expect(s1).toBeDefined();
    expect(s1!.stats.calls).toBe(2);
    expect(s1!.stats.rawTokens).toBe(1500);
    expect(s1!.stats.hitRate).toBe(90); // (100+80)/2
    // 默认 total 维度不输出 perSession
    const w2 = new WhiteboxLogger({ fileWrite: false });
    w2.record(makeReport({ sessionId: "s1" }));
    expect(w2.report().perSession).toBeUndefined();
    // setAggregateBy 运行时切换
    w2.setAggregateBy("per_session");
    expect(w2.report().perSession).toBeDefined();
  });
});

describe("v0.4.1 白盒报告即时摘要卡片", () => {
  function makeCard(over: Record<string, unknown> = {}) {
    return {
      requestId: "r1",
      ts: now,
      rawTokens: 1240,
      optimizedTokens: 892,
      hitRate: 93,
      savedTokens: 348,
      savedPct: 28.06,
      savedUsd: 0.000174,
      changes: [
        { kind: "prefix-stabilize", label: "前缀稳定化：冻结前缀逐字节复用", detail: "复用 2 个冻结片段" },
        { kind: "dedup", label: "去重：折叠重复指令/重复内容", detail: "发现 2 处重复行" },
        { kind: "volatile-tail", label: "动态内容移至末尾：保障缓存前缀稳定", detail: "剥离 3 处" },
      ],
      ...over,
    };
  }

  it("formatReportCard 固定格式：标题/原始与优化 token/预计命中/变更明细", () => {
    const card = formatReportCard(makeCard());
    expect(card).toContain("DoboCache 白盒报告");
    expect(card).toContain("原始 token");
    expect(card).toContain("优化后 token");
    expect(card).toContain("预计命中");
    expect(card).toContain("本次做了什么");
    expect(card).toContain("1,240"); // 千分位
    expect(card).toContain("93.0%");
    expect(card).toContain("复用 2 个冻结片段");
  });

  it("formatReportCard 无变更明细时省略本次做了什么", () => {
    const card = formatReportCard(makeCard({ changes: [], savedTokens: 0, savedPct: 0, savedUsd: 0 }));
    expect(card).toContain("DoboCache 白盒报告");
    expect(card).toContain("预计命中");
    expect(card).not.toContain("本次做了什么");
    expect(card).toContain("1,240");
  });

  it("formatReportCard 千分位与备注格式", () => {
    const card = formatReportCard(
      makeCard({ requestId: "r3", rawTokens: 10000, optimizedTokens: 10000, hitRate: 0, savedTokens: 0, savedPct: 0, savedUsd: 0.000005, changes: [], note: "cf_judge 只做判定不改写输入" }),
    );
    expect(card).toContain("10,000");
    expect(card).toContain("备注");
  });
});

describe("v0.4.4 日志隐私脱敏", () => {
  const PROMPT = "请综述 2026 年 10 月 AI 领域的主要动态，按厂商和方向分类。";

  it("fingerprintPrompt：无内容语义、同文同指纹、异文异指纹、幂等", () => {
    const fp = fingerprintPrompt(PROMPT);
    expect(fp).toMatch(/^req-[0-9a-f]{8}$/);
    expect(fp).not.toContain("AI");
    expect(fp).not.toContain("厂商");
    expect(fingerprintPrompt(PROMPT)).toBe(fp); // 同文同指纹（可做轮次对照）
    expect(fingerprintPrompt(`${PROMPT}（改写）`)).not.toBe(fp);
    expect(ensureRequestId(fp)).toBe(fp); // 幂等，避免二次哈希
    expect(ensureRequestId(PROMPT)).toBe(fp);
  });

  it("fingerprintSession：会话标识脱敏且幂等", () => {
    const sid = fingerprintSession("sample-2026Q4-alpha");
    expect(sid).toMatch(/^sid-[0-9a-f]{8}$/);
    expect(sid).not.toContain("sample-2026Q4-alpha");
    expect(ensureSessionId(sid)).toBe(sid);
    expect(ensureSessionId("sample-2026Q4-alpha")).toBe(sid);
  });

  it("sanitizeForLog：白名单构造，requestId/sessionId 脱敏且不含原文", () => {
    const safe = sanitizeForLog(
      {
        requestId: PROMPT,
        ts: now,
        rawTokens: 100,
        optimizedTokens: 80,
        hitRate: 90,
        savedTokens: 20,
        savedPct: 20,
        savedUsd: 0.0001,
        changes: [{ kind: "dedup", label: "去重", detail: "发现 2 处重复行" }],
        note: "cf_inject：原始 100 tokens → 优化后 80 tokens",
        sessionId: "sample-2026Q4",
      },
      7,
    );
    expect(safe.requestId).toMatch(/^req-[0-9a-f]{8}$/);
    expect(safe.sessionId).toMatch(/^sid-[0-9a-f]{8}$/);
    expect(safe.reqIndex).toBe(7);
    const json = JSON.stringify(safe);
    expect(json).not.toContain("请综述");
    expect(json).not.toContain("sample-2026Q4");
    expect(json).not.toContain("厂商");
  });

  it("日志落盘：JSONL 不含 prompt 原文，reqIndex 递增，同文 requestId 可对照", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-privacy-"));
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true });
    const mk = (text: string, sid?: string) =>
      w.buildReport({
        requestId: fingerprintPrompt(text),
        promptChars: text.length,
        rawTokens: 100,
        optimizedTokens: 90,
        changes: [],
        sessionId: sid,
      });
    w.record(mk(PROMPT, "sample-2026Q4"));
    w.record(mk(PROMPT, "sample-2026Q4"));
    w.record(mk("另一轮完全不同的提问内容", "sample-2026Q4"));
    const file = w.report().logFile;
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.reqIndex)).toEqual([1, 2, 3]);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain("请综述");
    expect(raw).not.toContain("厂商");
    expect(raw).not.toContain("另一轮完全不同");
    expect(raw).not.toContain("sample-2026Q4");
    expect(lines[0].requestId).toBe(lines[1].requestId); // 同文可对照
    expect(lines[0].requestId).not.toBe(lines[2].requestId);
    expect(lines[0].promptChars).toBe(PROMPT.length); // 只保留长度
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─────────────────────────── 跨机器可跑：启动自检 + 日志目录 ───────────────────────────
describe("启动自检：Node 版本", () => {
  it("版本号解析（含 v 前缀 / 异常串）", () => {
    expect(parseNodeMajor("v18.19.0")).toBe(18);
    expect(parseNodeMajor("20.11.1")).toBe(20);
    expect(parseNodeMajor("24.0.0-nightly")).toBe(24);
    expect(parseNodeMajor("")).toBe(0);
    expect(parseNodeMajor("abc")).toBe(0);
  });

  it("达标版本不产生提示", () => {
    const r = checkNodeVersion(`v${MIN_NODE_MAJOR}.0.0`);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("");
  });

  it("老版本给出人话提示（含低版本与升级地址，中英各一句）", () => {
    const r = checkNodeVersion("v16.20.2");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("16.20.2");
    expect(r.message).toContain(`Node.js ${MIN_NODE_MAJOR}`);
    expect(r.message).toContain("nodejs.org");
    expect(r.message).toContain("Startup aborted");
  });
});

describe("日志目录：平台标准可写目录", () => {
  it("Windows 取 %LOCALAPPDATA%\\DoboCache\\logs", () => {
    const got = platformLogDir(
      { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } as NodeJS.ProcessEnv,
      "win32" as NodeJS.Platform,
      "C:\\Users\\u",
    );
    expect(got).toBe(path.join("C:\\Users\\u\\AppData\\Local", "DoboCache", "logs"));
  });

  it("Windows 缺少 LOCALAPPDATA 时退回家目录 AppData\\Local", () => {
    const got = platformLogDir({} as NodeJS.ProcessEnv, "win32" as NodeJS.Platform, "C:\\Users\\u");
    expect(got).toBe(path.join("C:\\Users\\u", "AppData", "Local", "DoboCache", "logs"));
  });

  it("macOS 取 ~/Library/Logs/DoboCache", () => {
    const got = platformLogDir({} as NodeJS.ProcessEnv, "darwin" as NodeJS.Platform, "/Users/u");
    // 用 path.join 拼期望值，避免在 Windows 宿主上因分隔符差异误判
    expect(got).toBe(path.join("/Users/u", "Library", "Logs", "DoboCache"));
  });

  it("Linux 优先 XDG_STATE_HOME（仅绝对路径），否则 ~/.local/state", () => {
    const withXdg = platformLogDir(
      { XDG_STATE_HOME: "/var/state" } as NodeJS.ProcessEnv,
      "linux" as NodeJS.Platform,
      "/home/u",
    );
    expect(withXdg).toBe(path.join("/var/state", "dobocache"));
    const relativeXdg = platformLogDir(
      { XDG_STATE_HOME: "relative/path" } as NodeJS.ProcessEnv,
      "linux" as NodeJS.Platform,
      "/home/u",
    );
    expect(relativeXdg).toBe(path.join("/home/u", ".local", "state", "dobocache"));
  });

  it("三个平台的路径都由 path.join 拼装（分隔符随宿主，不硬编码）", () => {
    const win = platformLogDir(
      { LOCALAPPDATA: path.join("C:", "Users", "u", "AppData", "Local") } as NodeJS.ProcessEnv,
      "win32" as NodeJS.Platform,
      path.join("C:", "Users", "u"),
    );
    const mac = platformLogDir({} as NodeJS.ProcessEnv, "darwin" as NodeJS.Platform, path.join("/Users", "u"));
    const linux = platformLogDir({} as NodeJS.ProcessEnv, "linux" as NodeJS.Platform, path.join("/home", "u"));
    expect(win).toBe(path.join("C:", "Users", "u", "AppData", "Local", "DoboCache", "logs"));
    expect(mac).toBe(path.join("/Users", "u", "Library", "Logs", "DoboCache"));
    expect(linux).toBe(path.join("/home", "u", ".local", "state", "dobocache"));
    // 三段路径都由同一分隔符连接，不含另一种分隔符混用
    for (const candidate of [win, mac, linux]) {
      expect(candidate).not.toContain(path.sep === "/" ? "\\\\" : "/");
    }
  });
});

describe("日志目录：优先级与降级", () => {
  it("DOBOCACHE_LOG_DIR（显式传入）优先于平台目录，并真能建目录", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-logdir-"));
    const custom = path.join(base, "custom-logs");
    const r = resolveLogDir({ explicitDir: custom });
    expect(r.source).toBe("env");
    expect(r.dir).toBe(custom);
    expect(r.disabled).toBe(false);
    expect(fs.existsSync(custom)).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("enabled=false 时零副作用（不建目录）", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-logdir-"));
    const custom = path.join(base, "should-not-exist");
    const r = resolveLogDir({ explicitDir: custom, enabled: false });
    expect(r.source).toBe("env");
    expect(fs.existsSync(custom)).toBe(false);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("显式目录不可写（指向文件）时降级到平台目录，不抛错", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-logdir-"));
    const filePath = path.join(base, "occupied");
    fs.writeFileSync(filePath, "x", "utf-8");
    const r = resolveLogDir({ explicitDir: filePath });
    expect(r.source).not.toBe("env");
    expect(r.disabled).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("v0.4.6 口径修正：卡片默认关 / 命中率未判定 / 请求序号", () => {
  const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-v046-"));

  it("resolveCardMode：缺省与关闭值一律 quiet，once/always 可识别，拼错回退 quiet 并给提示", () => {
    expect(resolveCardMode(undefined).mode).toBe("quiet");
    expect(resolveCardMode("").mode).toBe("quiet");
    expect(resolveCardMode("  QUIET ").mode).toBe("quiet");
    expect(resolveCardMode("off").mode).toBe("quiet");
    expect(resolveCardMode("0").mode).toBe("quiet");
    expect(resolveCardMode("once").mode).toBe("once");
    expect(resolveCardMode("1").mode).toBe("once");
    expect(resolveCardMode("always").mode).toBe("always");
    expect(resolveCardMode("on").mode).toBe("always");
    const bad = resolveCardMode("alway");
    expect(bad.mode).toBe("quiet");
    expect(bad.warning).toContain(CARD_MODE_ENV[0]);
  });

  it("卡片默认不出：quiet 档位且已提示过的情况下 shouldEmitCard 恒为 false", () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, ".welcomed"), "x", "utf-8"); // 模拟已过首次引入
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, cardMode: "quiet" });
    expect(w.shouldEmitCard().emit).toBe(false);
    expect(w.shouldEmitCard().emit).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("once 档位：只出一次卡，之后自动回落到 quiet", () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, ".welcomed"), "x", "utf-8");
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, cardMode: "once" });
    expect(w.shouldEmitCard()).toEqual({ emit: true, welcome: false });
    expect(w.shouldEmitCard().emit).toBe(false);
    expect(w.cardModeValue).toBe("quiet");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("always 档位：每次都出卡", () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, ".welcomed"), "x", "utf-8");
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, cardMode: "always" });
    expect(w.shouldEmitCard()).toEqual({ emit: true, welcome: false });
    expect(w.shouldEmitCard()).toEqual({ emit: true, welcome: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("首次运行：出一次引入卡并落 .welcomed 标记，重启后不再出", () => {
    const dir = mkDir();
    const w1 = new WhiteboxLogger({ logDir: dir, fileWrite: true, cardMode: "quiet" });
    expect(w1.shouldEmitCard()).toEqual({ emit: true, welcome: true });
    expect(w1.shouldEmitCard().emit).toBe(false);
    expect(fs.existsSync(path.join(dir, ".welcomed"))).toBe(true);
    const w2 = new WhiteboxLogger({ logDir: dir, fileWrite: true, cardMode: "quiet" });
    expect(w2.shouldEmitCard().emit).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("命中率未判定：无厂商 usage 时 hitRate 为 null，不写 0", () => {
    const w = new WhiteboxLogger({ fileWrite: false });
    const r = w.buildReport({ requestId: "r1", rawTokens: 1000, optimizedTokens: 900, changes: [] });
    expect(r.hitRate).toBeNull();
    const card = formatReportCard(r);
    expect(card).toContain("未判定");
    expect(card).not.toContain("命中率：0%");
  });

  it("命中率均值只算已判定请求：judgedCalls 与 hitRate 同步", () => {
    const w = new WhiteboxLogger({ fileWrite: false });
    w.record(w.buildReport({ requestId: "a", rawTokens: 100, optimizedTokens: 100, changes: [] })); // 未判定
    w.record(w.buildReport({ requestId: "b", rawTokens: 100, optimizedTokens: 100, hitTokens: 900, missTokens: 100, changes: [] })); // 90%
    const rep = w.report();
    expect(rep.today.calls).toBe(2);
    expect(rep.today.judgedCalls).toBe(1);
    expect(rep.today.hitRate).toBe(90);
    expect(rep.total.hitRate).toBe(90);
  });

  it("cf_report 暴露 cardMode，便于用户自查为什么看不到卡片", () => {
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, ".welcomed"), "x", "utf-8");
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, cardMode: "always" });
    const rep = w.report();
    expect(rep.cardMode).toBe("always");
    expect(rep.welcomeShown).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("日志字段名 reqIndex：落盘不含 round 字段", () => {
    const dir = mkDir();
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true });
    w.record(w.buildReport({ requestId: "r1", rawTokens: 100, optimizedTokens: 90, changes: [] }));
    const line = JSON.parse(fs.readFileSync(w.report().logFile, "utf-8").trim());
    expect(line.reqIndex).toBe(1);
    expect("round" in line).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ===== v0.4.7 缺口2 / 缺口3：日志轮转、保留期清理、读盘聚合 =====
  const dayStr = (ts: number) => {
    const d = new Date(ts);
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  };

  it("v0.4.7 轮转：主文件超过上限后滚动为 .1，副本不超过 3 份", () => {
    const dir = mkDir();
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, logMaxMb: 0.001 }); // 约 1KB
    for (let i = 0; i < 40; i += 1) {
      w.record(w.buildReport({ requestId: `r${i}`, rawTokens: 100 + i, optimizedTokens: 50, changes: [] }));
    }
    const main = w.report().logFile;
    expect(fs.existsSync(main)).toBe(true);
    expect(fs.existsSync(`${main}.1`)).toBe(true);
    expect(fs.existsSync(`${main}.4`)).toBe(false); // 只保留 LOG_ROLL_KEEP 份
    const m = w.lastMaintenanceInfo;
    expect(m).not.toBeNull();
    expect(m!.rolled.length).toBeGreaterThan(0);
    expect(m!.rolled[0]).toBe(path.basename(main));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("v0.4.7 保留期清理：超过 keepDays 的日志删除，非本模块命名的文件绝不动", () => {
    const dir = mkDir();
    const now = Date.now();
    const oldFile = path.join(dir, `dobocache-${dayStr(now - 9 * 86400000)}.log.jsonl`);
    const keepFile = path.join(dir, `dobocache-${dayStr(now - 86400000)}.log.jsonl`);
    const userFile = path.join(dir, "my-notes.log.jsonl");
    fs.writeFileSync(oldFile, "{}\n", "utf-8");
    fs.writeFileSync(keepFile, "{}\n", "utf-8");
    fs.writeFileSync(userFile, "keep me\n", "utf-8");

    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, logKeepDays: 7 });
    const res = w.runLogMaintenance(now, true);
    expect(res.pruned).toContain(path.basename(oldFile));
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(keepFile)).toBe(true);
    expect(fs.existsSync(userFile)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("v0.4.7 清理门闩：同一天不重复扫目录，force 可强制", () => {
    const dir = mkDir();
    const now = Date.now();
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: true, logKeepDays: 7 });
    expect(w.runLogMaintenance(now).pruned).toHaveLength(0);
    const stale = path.join(dir, `dobocache-${dayStr(now - 30 * 86400000)}.log.jsonl`);
    fs.writeFileSync(stale, "{}\n", "utf-8");
    expect(w.runLogMaintenance(now).pruned).toHaveLength(0); // 同一天：门闩挡住
    expect(fs.existsSync(stale)).toBe(true);
    expect(w.runLogMaintenance(now, true).pruned).toHaveLength(1); // 强制：扫到并删除
    expect(fs.existsSync(stale)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("v0.4.7 读盘聚合：跨文件累计，hitRate 只算已判定行，坏行计入 skippedLines", () => {
    const dir = mkDir();
    const now = Date.now();
    const y = dayStr(now - 86400000);
    const t = dayStr(now);
    fs.writeFileSync(
      path.join(dir, `dobocache-${y}.log.jsonl`),
      `${JSON.stringify({ requestId: "req-aaaa", rawTokens: 1000, optimizedTokens: 500, savedTokens: 500, savedUsd: 0.0004, hitRate: 80, reqIndex: 1 })}\n`,
      "utf-8",
    );
    fs.appendFileSync(
      path.join(dir, `dobocache-${t}.log.jsonl`),
      `${JSON.stringify({ requestId: "req-bbbb", rawTokens: 2000, optimizedTokens: 1000, savedTokens: 1000, savedUsd: 0.0008, hitRate: null, reqIndex: 2 })}\n` +
        "not-a-json-line\n",
      "utf-8",
    );
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: false, logKeepDays: 7 });
    const agg = w.aggregateFromDisk({ days: 2 });
    expect(agg.source).toBe("disk");
    expect(agg.files).toBe(2);
    expect(agg.lines).toBe(3);
    expect(agg.skippedLines).toBe(1);
    expect(agg.stats.calls).toBe(2);
    expect(agg.stats.rawTokens).toBe(3000);
    expect(agg.stats.savedTokens).toBe(1500);
    expect(agg.stats.judgedCalls).toBe(1);
    expect(agg.stats.hitRate).toBe(80);
    expect(agg.logPolicy.keepDays).toBe(7);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("v0.4.7 读盘聚合：目录为空时 0 次、hitRate 为 null（不伪造 0%）", () => {
    const dir = mkDir();
    const w = new WhiteboxLogger({ logDir: dir, fileWrite: false });
    const agg = w.aggregateFromDisk();
    expect(agg.files).toBe(0);
    expect(agg.stats.calls).toBe(0);
    expect(agg.stats.hitRate).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

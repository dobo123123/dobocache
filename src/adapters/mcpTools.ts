/**
 * DoboCache MCP 工具适配层
 * 把 DoboCache 四个核心模块暴露为 MCP Server 工具：
 *   cf_judge   命中判定（三层缩圈 + 锚词评分×时效衰减 + 负向过滤）
 *   cf_tier    价值分级准入（提纯 + A/B/C 预算填充）
 *   cf_inject  记忆提纯注入（稳定前缀 + 分级片段 + 动态尾部）
 *   cf_meter   测量快照（命中率 / 分级分布 / token 节省估算）
 * 供任意 MCP 客户端（stdio 挂载）调用。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { judgeHit, type CacheEntry, type HitContext } from "../core/hitJudge.js";
import {
  admitByTier,
  gradeFragment,
  DEFAULT_BUDGET,
  type TieredFragment,
} from "../core/valueTier.js";
import {
  injectIncremental,
  distillRules,
  SessionInjectStore,
  type Strictness,
  type FrozenSession,
} from "../core/memoryInject.js";
import { Meter } from "../core/meter.js";
import { WhiteboxLogger, detectDuplicateLines, formatReportCard, type SavingsReport, type WhiteboxChange } from "../core/whitebox.js";
import { pruneToolOutput, normalizeStructured } from "../utils/prune.js";
import { stableStringify, estimateTokens, hashString } from "../utils/serialize.js";
import { fingerprintPrompt } from "../utils/privacy.js";

const EntrySchema = z.object({
  id: z.string().optional(),
  query: z.string(),
  response: z.string().optional(),
  content: z.string().optional(),
  category: z.string().optional(),
  timestamp: z.number().int().min(0).optional(),
  hitCount: z.number().int().min(0).optional(),
});

const FragmentSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  score: z.number().optional(),
  timestamp: z.number().int().min(0).optional(),
  tier: z.enum(["A", "B", "C"]).optional().describe("价值分级（cf_tier 输出保留）"),
});

/**
 * v0.4.4 r3 工具注解（MCP 规范 ToolAnnotations）：声明副作用与幂等性，
 * 让客户端能在调用前区分"只读计算"与"会写本地日志 / 冻结会话状态"。
 * 全部工具均为本地 stdio 计算，openWorldHint 统一 false。
 */
const LOCAL_ONLY = { openWorldHint: false } as const;
const READONLY_IDEMPOTENT = { ...LOCAL_ONLY, readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const WRITES_LOG_ONLY = { ...LOCAL_ONLY, readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;

/**
 * v0.4.6：白盒卡片装配。
 * 默认不出卡（cardMode=quiet），只在①本机首次运行的引入提示、或②用户显式把
 * DOBOCACHE_WHITEBOX 设为 once/always 时附带，避免每次工具返回都往上下文里塞约 300 tokens 的报告。
 * 返回 null 表示本次不附带卡片（日志照常落盘，cf_report 随时可查累计）。
 */
function buildWhiteboxCard(whitebox: WhiteboxLogger, report: SavingsReport): string | null {
  const { emit, welcome } = whitebox.shouldEmitCard();
  if (!emit) return null;
  const body = formatReportCard(report);
  return welcome ? `${body}\n${WhiteboxLogger.WELCOME_HINT}` : body;
}

/** 注册全部工具到 MCP Server（v0.4.1：核心四模块 + 白盒报告 cf_report；跨对话能力已剥离；形态 A 即时摘要随 cf_judge/cf_inject 返回直接可见） */
export function registerCacheTools(server: McpServer, meter: Meter, whitebox: WhiteboxLogger): void {
  // 命中判定
  server.tool(
    "cf_judge",
    "判定当前请求能否命中既有缓存上下文：关键词分层（实体锚词/意图修饰词）、三层匹配、时效衰减、负向过滤，输出可解释证据。",
    {
      query: z.string().min(1).describe("当前请求文本（不能为空：空文本无实体锚词，判定结果恒为未命中）"),
      entries: z.array(EntrySchema).describe("缓存条目列表（记忆/历史对话）"),
      blacklist: z.array(z.string()).optional().describe("黑名单词，支持 /regex/ 形式"),
      threshold: z.number().min(0).optional().describe("命中阈值，默认 5；必须 ≥ 0"),
      topK: z.number().int().min(1).optional().describe("返回候选数，默认 5；必须为 ≥ 1 的整数"),
      now: z.number().int().min(0).optional().describe("用于测试的当前时间戳（毫秒），必须 ≥ 0"),
      hitTokens: z.number().int().min(0).optional().describe("本次请求厂商 usage 命中 tokens（prompt_cache_hit_tokens），供 cf_meter 计费相对值曲线累计；必须 ≥ 0"),
      missTokens: z.number().int().min(0).optional().describe("本次请求厂商 usage 未命中 tokens（prompt_cache_miss_tokens），供 cf_meter 计费相对值曲线累计；必须 ≥ 0"),
    },
    {
      title: "命中判定（cf_judge）",
      ...WRITES_LOG_ONLY,
    },
    async (args) => {
      const ctx: HitContext = {
        blacklist: args.blacklist,
        threshold: args.threshold,
        topK: args.topK,
        now: args.now,
      };
      const entries: CacheEntry[] = (args.entries ?? []).map((e, i) => ({
        id: e.id ?? `e${i}`,
        query: e.query,
        response: e.response,
        content: e.content ?? `${e.query}\n${e.response ?? ""}`,
        category: e.category,
        timestamp: e.timestamp ?? Date.now(),
        hitCount: e.hitCount,
      }));
      const result = judgeHit(args.query, entries, ctx);
      // v0.4.4 隐私脱敏：requestId 只存无内容语义的短指纹（同文同指纹），不再拼 prompt 原文
      const judgeRequestId = fingerprintPrompt(args.query);
      meter.record(
        Meter.sample({
          requestId: judgeRequestId,
          query: args.query,
          hit: result,
          hitTokens: args.hitTokens,
          missTokens: args.missTokens,
        }),
      );
      // 白盒：judge 场景记录白盒报告（输入未改写，优化后=原始）
      const judgeRaw = estimateTokens(args.query);
      const judgeChanges: WhiteboxChange[] = result.hit
        ? [{ kind: "judge-hit", label: "命中判定：复用缓存上下文", detail: `命中 ${result.matched.length} 条候选，证据 ${result.evidence.length} 条` }]
        : [{ kind: "judge-miss", label: "未命中：本次请求进入新缓存候选" }];
      const judgeReport = whitebox.buildReport({
        requestId: judgeRequestId,
        promptChars: args.query.length,
        rawTokens: judgeRaw,
        optimizedTokens: judgeRaw,
        // v0.4.6：不再用"命中判定 true/false"冒充命中率。只有调用方回传厂商 usage 时才有命中率，
        // 否则记为未判定（null）——判定结果本身已写在 changes 的 judge-hit / judge-miss 里。
        hitTokens: args.hitTokens,
        missTokens: args.missTokens,
        changes: judgeChanges,
        note: "cf_judge 只做判定不改写输入，token 节省主要体现在后续 cf_inject 注入；未回传厂商 usage 时命中率记为未判定。",
      });
      whitebox.record(judgeReport);
      const judgeContent: Array<{ type: "text"; text: string }> = [
        {
          type: "text",
          text: stableStringify({
            hit: result.hit,
            score: result.score,
            threshold: result.threshold,
            evidence: result.evidence,
            stats: result.stats,
            matched: result.matched.map((m) => ({
              id: m.entry.id,
              score: m.score,
              round: m.round,
              category: m.entry.category,
            })),
          }),
        },
      ];
      // 形态 A 即时摘要：仅在用户打开白盒卡片（once/always）或本机首次运行时附带，默认不占 token
      const judgeCard = buildWhiteboxCard(whitebox, judgeReport);
      if (judgeCard) judgeContent.push({ type: "text", text: judgeCard });
      return { content: judgeContent };
    },
  );

  // 价值分级准入
  server.tool(
    "cf_tier",
    "对候选记忆/上下文片段做价值分级准入：提纯去噪 → A/B/C 分级 → 按预算从高到低填充，输出准入列表与丢弃明细。",
    {
      fragments: z.array(FragmentSchema).describe("候选片段列表"),
      query: z.string().optional().describe("用于评分的当前请求"),
      totalChars: z.number().int().min(0).optional().describe("总预算（字符），默认 800；必须 ≥ 0（填 0 表示不赋予预算，全部片段都会被丢弃）"),
      reservedChars: z.number().int().min(0).optional().describe("预留前缀字符数，默认 250；必须 ≥ 0，且不应大于 totalChars（否则预算被预留吃光，什么都不会被准入）"),
      now: z.number().int().min(0).optional().describe("用于测试的当前时间戳（毫秒），必须 ≥ 0"),
    },
    {
      title: "价值分级准入（cf_tier）",
      ...READONLY_IDEMPOTENT,
    },
    async (args) => {
      const budget = {
        ...DEFAULT_BUDGET,
        totalChars: args.totalChars ?? DEFAULT_BUDGET.totalChars,
        reservedChars: args.reservedChars ?? DEFAULT_BUDGET.reservedChars,
      };
      const graded: TieredFragment[] = (args.fragments ?? []).map((f, i) =>
        gradeFragment(
          f.id ?? `f${i}`,
          f.content,
          f.score ?? 0,
          f.timestamp,
          args.now ?? Date.now(),
          budget,
        ),
      );
      const result = admitByTier(graded, budget);
      return {
        content: [
          {
            type: "text",
            text: stableStringify({
              usage: result.usage,
              admitted: result.admitted.map((f) => ({
                id: f.id,
                tier: f.tier,
                score: f.score,
                chars: f.chars,
                content: f.content,
              })),
              dropped: result.dropped,
            }),
          },
        ],
      };
    },
  );

  // 记忆提纯注入（会话增量模式）
  server.tool(
    "cf_inject",
    "会话增量注入：固定版本化前缀（规则块+分级片段+固定补充块）逐字节不变，新内容（本次请求+易变内容）只追加到尾部 tail；同一 sessionId 自动冻结前缀支持跨请求复用；前缀不足最小有效长度时自动补高价值片段/固定文档块过门槛。",
    {
      request: z.string().describe("当前请求文本（动态增量 tail）"),
      fragments: z.array(FragmentSchema).describe("已分级准入片段（首次请求时冻结，后续请求复用）"),
      maxTokens: z.number().int().min(1).optional().describe("注入后 token 上限；必须为 ≥ 1 的整数（不传则用内置默认值）"),
      sessionId: z.string().optional().describe("会话标识；同一会话冻结前缀，跨请求复用"),
      previousPrefixHash: z.string().optional().describe("上一次请求返回的 prefixHash；一致则标记前缀复用（兼容无冻结信息场景）"),
      minPrefixTokens: z.number().int().min(0).optional().describe("最小有效前缀长度门槛（token），默认 200；必须 ≥ 0"),
      minPrefixDocBlocks: z.array(z.string()).optional().describe("过门槛用的固定版本文档块"),
      volatile: z.array(z.string()).optional().describe("显式易变内容（时间戳/会话标记等），强制进 tail"),
      reset: z.boolean().optional().describe("重置该会话冻结前缀，重新冻结"),
      scenario: z.enum(["first", "full"]).optional().describe("显式指定约束场景（默认按缓存充足度自动选择）"),
      align128: z.boolean().optional().describe("128-token 对齐开关（默认开启；false 恢复原行为）"),
      alignFillText: z.string().optional().describe("128 对齐填充块（默认固定 ASCII 注释块）"),
      strictness: z.enum(["strict", "balanced", "loose"]).optional().describe("约束强度（v0.4.2）：strict 完整硬约束（默认）/ balanced 平衡（允许自身知识补充并标注）/ loose 自由放行；仅影响 full 场景；同一会话冻结后以冻结值为准"),
      minPrefixSafetyFactor: z.number().min(1).optional().describe("最小前缀门槛安全余量（v0.4.2，默认 1.15）：实际门槛 = ceil(minPrefixTokens × factor)；必须 ≥ 1（< 1 会让门槛低于厂商最小值，缓存必然不生效）"),
      freezeFragments: z.boolean().optional().describe("是否冻结片段用于跨请求前缀复用（v0.4.2，默认 true；false 时冷启动不锁死占位片段，允许随请求重建前缀）"),
      hitTokens: z.number().int().min(0).optional().describe("本次请求的厂商 usage 命中 tokens（prompt_cache_hit_tokens），供 cf_meter 计费相对值曲线累计；必须 ≥ 0"),
      missTokens: z.number().int().min(0).optional().describe("本次请求的厂商 usage 未命中 tokens（prompt_cache_miss_tokens），供 cf_meter 计费相对值曲线累计；必须 ≥ 0"),
    },
    {
      title: "会话增量注入（cf_inject）",
      ...LOCAL_ONLY,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async (args) => {
      const fragments: TieredFragment[] = (args.fragments ?? []).map((f, i) => ({
        id: f.id ?? `f${i}`,
        content: f.content,
        rawChars: f.content.length,
        chars: f.content.length,
        score: f.score ?? 0,
        tier: f.tier ?? "B",
      }));
      const store = SessionInjectStore.getDefault();
      let injectFragments = fragments;
      let frozenReused = false;
      let previousFrozenPrefix: string | undefined;
      let previousFrozenFragments: TieredFragment[] | undefined;
      let frozen: FrozenSession | undefined;
      const freezeFragments = args.freezeFragments !== false;
      if (args.sessionId && freezeFragments) {
        if (args.reset) store.remove(args.sessionId);
        frozen = store.get(args.sessionId);
        if (frozen) {
          // 冻结前缀优先：后续请求片段变化也复用已冻结片段，保证前缀逐字节不变；strictness 以冻结值为准
          injectFragments = frozen.fragments;
          previousFrozenPrefix = frozen.prefix;
          previousFrozenFragments = frozen.fragments;
          frozenReused = true;
        }
      }
      const result = injectIncremental(args.request, injectFragments, {
        sessionId: args.sessionId,
        previousPrefixHash: args.previousPrefixHash,
        previousFrozenPrefix,
        previousFrozenFragments,
        minPrefixTokens: args.minPrefixTokens,
        minPrefixSafetyFactor: args.minPrefixSafetyFactor,
        minPrefixDocBlocks: args.minPrefixDocBlocks,
        volatile: args.volatile,
        poolFragments: fragments, // 未冻结时可用本次候选片段补充过门槛
        scenario: args.scenario,
        strictness: (frozen && frozen.strictness) ?? args.strictness ?? "strict", // 冻结会话强制沿用冻结时强度，避免前缀字节漂移
        maxTokens: args.maxTokens,
        align128: args.align128,
        alignFillText: args.alignFillText,
      });
      if (args.sessionId && !args.reset && !frozenReused && freezeFragments) {
        store.set(args.sessionId, {
          sessionId: args.sessionId,
          prefixHash: result.prefixHash,
          prefix: result.prefix,
          body: result.body,
          fragments: injectFragments,
          scenario: result.scenario,
          strictness: result.strictness ?? "strict",
          createdAt: Date.now(),
        });
      }
      const rules = distillRules(fragments);
      // v0.4.4 隐私脱敏：注入请求标识同样只存短指纹，不落 request 原文
      const injectRequestId = fingerprintPrompt(args.request);
      meter.recordInject(injectRequestId, args.request, result, Date.now(), {
        hitTokens: args.hitTokens,
        missTokens: args.missTokens,
      });
      // 白盒：单次白盒报告（原始 token / 优化后 token / 命中率 / 节省比例 / 变更明细）
      const injectRaw = estimateTokens([args.request, ...fragments.map((f) => f.content)].join("\n"));
      const injectChanges: WhiteboxChange[] = [];
      const frozenDetail =
        result.frozenReused.reused.length > 0
          ? `复用 ${result.frozenReused.reused.length} 个冻结片段`
          : undefined;
      if (frozenReused && frozenDetail) {
        injectChanges.push({ kind: "prefix-stabilize", label: "前缀稳定化：冻结前缀逐字节复用", detail: frozenDetail });
      }
      if (result.reusedPrefix) {
        injectChanges.push({ kind: "prefix-stabilize", label: "前缀稳定化：跨请求前缀哈希一致，逐字节复用" });
      }
      const dup = detectDuplicateLines([args.request, ...fragments.map((f) => f.content)].join("\n"));
      if (dup.count > 0) {
        injectChanges.push({ kind: "dedup", label: "去重：折叠重复指令/重复内容", detail: `发现 ${dup.count} 处重复行` });
      }
      if (result.volatile.length > 0) {
        injectChanges.push({ kind: "volatile-tail", label: "动态内容移至末尾：保障缓存前缀稳定", detail: `剥离 ${result.volatile.length} 处（时间戳/会话标记等）` });
      }
      if (result.alignBlocks > 0) {
        injectChanges.push({ kind: "align128", label: "前缀 128-token 对齐：减少尾部部分命中", detail: `追加 ${result.alignBlocks} 个对齐块` });
      }
      if (result.poolUsed > 0) {
        injectChanges.push({ kind: "topup", label: "前缀过门槛补充：达到最小有效缓存长度", detail: `补充 ${result.poolUsed} 块（高价值片段/文档块）` });
      }
      // v0.4.6：把"前缀复用比例"作为本地口径明细写清楚，避免被当成厂商缓存命中率
      if (result.reusedPrefix || result.frozenHitRatio > 0) {
        injectChanges.push({
          kind: "prefix-reuse",
          label: "前缀复用（本地口径，不等同厂商缓存命中率）",
          detail: `复用比例 ${result.frozenHitRatio}%${result.reusedPrefix ? "，跨请求前缀哈希一致" : ""}`,
        });
      }
      const strictLabel: Record<Strictness, string> = {
        strict: "完整硬约束（禁止编造）",
        balanced: "平衡约束（缓存优先，可标注推测补充）",
        loose: "自由放行",
      };
      injectChanges.push({
        kind: "scenario",
        label:
          result.scenario === "first"
            ? "首条请求或缓存为空：轻量约束放行自由回答"
            : `完整约束注入（${strictLabel[result.strictness ?? "strict"]}）`,
      });
      const injectReport = whitebox.buildReport({
        requestId: injectRequestId,
        promptChars: args.request.length,
        rawTokens: injectRaw,
        optimizedTokens: result.tokens,
        // v0.4.6：前缀复用比例是本地口径，不等同厂商缓存命中率，改由 changes 明细说明；命中率只认厂商 usage
        hitTokens: args.hitTokens,
        missTokens: args.missTokens,
        changes: injectChanges,
        note: `cf_inject：原始 ${injectRaw} tokens → 优化后 ${result.tokens} tokens（前缀 ${result.prefixTokens} + tail）；实际门槛 ${result.effectiveMinPrefixTokens ?? "?"} tokens。`,
        sessionId: args.sessionId,
        scenario: result.scenario,
        mode: frozenReused ? "frozen" : "rebuild",
        alignBlocks: result.alignBlocks,
        prefixTokens: result.prefixTokens,
      });
      whitebox.record(injectReport);
      const injectContent: Array<{ type: "text"; text: string }> = [
        {
          type: "text",
          text: stableStringify({
            version: rules.version,
            prefix: result.prefix,
            body: result.body,
            tail: result.tail,
            tokens: result.tokens,
            prompt: result.prompt,
            // 增量接口
            sessionId: args.sessionId,
            prefixHash: result.prefixHash,
            prefixTokens: result.prefixTokens,
            prefixReady: result.prefixReady,
            reusedPrefix: result.reusedPrefix,
            frozenReused,
            scenario: result.scenario,
            volatile: result.volatile,
            poolUsed: result.poolUsed,
            // v0.2.1 冻结语义与对齐明细
            frozenHitRatio: result.frozenHitRatio,
            frozenReusedDetail: result.frozenReused,
            alignBlocks: result.alignBlocks,
            // v0.4.2
            strictness: result.strictness,
            effectiveMinPrefixTokens: result.effectiveMinPrefixTokens,
            frozenFragmentsTokens: result.frozenFragmentsTokens,
            freezeFragments,
          }),
        },
      ];
      // 形态 A 即时摘要：仅在用户打开白盒卡片（once/always）或本机首次运行时附带，默认不占 token
      const injectCard = buildWhiteboxCard(whitebox, injectReport);
      if (injectCard) injectContent.push({ type: "text", text: injectCard });
      return { content: injectContent };
    },
  );

  // 测量快照
  server.tool(
    "cf_meter",
    "输出测量仪表快照：判定命中率、平均分、价值分级分布、预计命中 token/比例；v0.2.1 新增按请求累计计费相对值曲线（累计命中/未命中 tokens）。注意：此处的 hitRate 是「cf_judge 判定命中率」（DoboCache 内部召回判定口径），且无判定样本时为 null（未判定，勿读作 0%）；厂商 usage 回传的真实缓存命中率请看 cf_report 的 hitRate / judgedCalls。",
    {
      reset: z.boolean().optional().describe("是否清空计数器后输出空快照"),
    },
    {
      title: "测量快照（cf_meter）",
      ...LOCAL_ONLY,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async (args) => {
      if (args.reset) meter.reset();
      return {
        content: [{ type: "text", text: stableStringify(meter.snapshot()) }],
      };
    },
  );

  // v0.2.1 预热工具：显式建立厂商前缀缓存
  server.tool(
    "cf_warmup",
    "预热工具（v0.2.1）：在正式请求前显式调用一次，用当前冻结前缀（sessionId）或传入片段构造最小占位请求；客户端需将返回的 prompt 发一次 LLM 请求以触发厂商前缀缓存建立。注意：必须显式调用、默认不自动触发；该占位请求本身会产生少量计费（按未命中计价系数）；命中率无法由 server 侧确认，请以下一次请求的 usage 为准。",
    {
      sessionId: z.string().optional().describe("会话标识；存在冻结前缀时基于冻结前缀构造占位请求"),
      request: z.string().optional().describe("占位请求文本（默认固定占位符）"),
      fragments: z.array(FragmentSchema).optional().describe("无冻结前缀时用于构造候选前缀的分级片段"),
      minPrefixTokens: z.number().int().min(0).optional().describe("最小有效前缀长度门槛（token），默认 200；必须 ≥ 0"),
      align128: z.boolean().optional().describe("128-token 对齐开关（默认开启）"),
    },
    {
      title: "预热（cf_warmup）",
      ...READONLY_IDEMPOTENT,
    },
    async (args) => {
      const store = SessionInjectStore.getDefault();
      const frozen = args.sessionId ? store.get(args.sessionId) : undefined;
      const placeholder = args.request ?? "__dobocache_warmup_placeholder__";
      const warmFragments: TieredFragment[] = (args.fragments ?? []).map((f, i) => ({
        id: f.id ?? `w${i}`,
        content: f.content,
        rawChars: f.content.length,
        chars: f.content.length,
        score: f.score ?? 0,
        tier: f.tier ?? "B",
      }));
      const result = injectIncremental(placeholder, frozen ? frozen.fragments : warmFragments, {
        sessionId: args.sessionId,
        minPrefixTokens: args.minPrefixTokens,
        align128: args.align128,
        scenario: frozen ? frozen.scenario : undefined,
        strictness: frozen ? (frozen.strictness ?? "strict") : undefined, // v0.4.2：沿用冻结时的约束强度
      });
      return {
        content: [
          {
            type: "text",
            text: stableStringify({
              sessionId: args.sessionId,
              frozenUsed: !!frozen,
              prefixHash: result.prefixHash,
              prefixTokens: result.prefixTokens,
              prefixReady: result.prefixReady,
              prompt: result.prompt,
              request: placeholder,
              note: "预热请求仅用于建立厂商前缀缓存；命中率无法由 server 侧确认，请以下一次请求的 usage 为准。",
              costHint: "该占位请求会向 LLM 发送一次完整前缀，产生少量计费（按未命中计价系数）；预热完成后自下一次请求起按命中计价系数计费。",
            }),
          },
        ],
      };
    },
  );

  // 白盒累计统计（v0.4.1）
  server.tool(
    "cf_report",
    "历史报表：从本地白盒日志汇总请求次数、厂商 usage 真实缓存命中率、原始/优化 token、预计命中 token 与命中比例，支持 total / per_session 聚合，附带 cardMode（白盒卡片档位，默认 quiet）。与 cf_meter 的分工：cf_report 读落盘日志，可跨进程、跨天累计（source=disk，进程重启不丢）；cf_meter 只报当前进程内即时快照。命中率为 null 表示本期没有可判定的厂商 usage 数据（未判定），不是 0%。日志默认写平台标准可写目录（`DOBOCACHE_LOG_DIR` 可覆盖），只在本机、不含提问原文、不占对话 token；按「单文件 10MB 轮转 + 默认保留 7 天」自动维护（`DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS` 可调），返回中的 logPolicy 即当前生效值。",
    {
      reset: z.boolean().optional().describe("是否清空累计计数后输出空统计"),
      aggregateBy: z.enum(["total", "per_session"]).optional().describe("聚合维度（v0.4.2，默认 total）：total=进程内累计；per_session=按会话分组）"),
      source: z
        .enum(["memory", "disk"])
        .optional()
        .describe(
          "统计来源（v0.4.7，默认 memory）：memory=当前进程内累计，进程重启即从 0 开始；disk=读取本地白盒日志重新聚合，跨进程/跨天累计，适合回答「累计到底省了多少」。disk 为纯本地只读，不联网、不上报。",
        ),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe("source=disk 时回溯的自然日数（v0.4.7，默认等于日志保留天数，通常 7 天）"),
    },
    {
      title: "白盒累计统计（cf_report）",
      ...LOCAL_ONLY,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async (args) => {
      if (args.reset) whitebox.reset();
      if (args.aggregateBy) whitebox.setAggregateBy(args.aggregateBy);
      // v0.4.7 缺口3：source=disk 走磁盘日志聚合，口径与内存态一致（hitRate 只算已判定行）
      if (args.source === "disk") {
        const agg = whitebox.aggregateFromDisk({
          days: args.days,
          perSession: whitebox.aggregateByValue === "per_session",
        });
        return {
          content: [
            {
              type: "text",
              text: stableStringify({
                ...agg,
                cardMode: whitebox.cardModeValue,
                logDirSource: whitebox.logDirSource,
                logWarnings: whitebox.logWarnings,
              }),
            },
          ],
        };
      }
      const rep = whitebox.report();
      return {
        content: [
          {
            type: "text",
            text: stableStringify({
              ...rep,
              // v0.4.4 r2：把"日志到底落在哪"直接告诉调用方，省去猜目录
              logDirSource: whitebox.logDirSource,
              logWarnings: whitebox.logWarnings,
            }),
          },
        ],
      };
    },
  );

  // 工具输出修剪
  server.tool(
    "cf_prune",
    "压缩你传入的文本，为稳定前缀腾出空间：去重行、压缩空白，按 maxChars / maxLines 双上限截断（默认保留头部），返回修剪前后体积比与丢弃行数。输入只认参数里的 text 字符串，输出是可直接拼进上下文的短文本；要处理结构化行数据用 cf_normalize。白盒日志由服务端自维护（单文件 10MB 轮转、默认保留 7 天，`DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS` 可调），体积无需人工干预。",
    {
      text: z.string().describe("原始工具输出"),
      maxChars: z.number().int().min(1).optional().describe("最大字符数，默认 2000；必须为 ≥ 1 的整数"),
      maxLines: z.number().int().min(1).optional().describe("最大行数，默认 200；必须为 ≥ 1 的整数"),
      keepHead: z.boolean().optional().describe("保留头部（默认 true）"),
    },
    {
      title: "工具输出修剪（cf_prune）",
      ...READONLY_IDEMPOTENT,
    },
    async (args) => {
      const result = pruneToolOutput(args.text, {
        maxChars: args.maxChars,
        maxLines: args.maxLines,
        keepHead: args.keepHead,
      });
      return {
        content: [
          {
            type: "text",
            text: stableStringify({
              text: result.text,
              originalChars: result.originalChars,
              prunedChars: result.prunedChars,
              reductionPct: result.ratio,
              droppedLines: result.droppedLines,
            }),
          },
        ],
      };
    },
  );

  // 结构化结果确定性归一
  server.tool(
    "cf_normalize",
    "归一化结构化行数据（对象数组）：按字段白名单裁剪 + 稳定排序，让内容相同但顺序抖动的返回归为同一个缓存键，输出归一后的 rows 与 `nk-` 前缀键指纹。与 cf_prune 的分工：cf_normalize 吃 rows 数组、产出稳定键；cf_prune 吃纯文本、产出短文本。",
    {
      rows: z.array(z.record(z.string(), z.unknown())).describe("结构化行数据（对象数组），排序依据字段名而非原始行序"),
      fields: z.array(z.string()).optional().describe("保留字段白名单；不传则保留全部字段"),
    },
    {
      title: "结构化归一（cf_normalize）",
      ...READONLY_IDEMPOTENT,
    },
    async (args) => {
      const normalized = normalizeStructured(args.rows ?? [], args.fields);
      return {
        content: [
          {
            type: "text",
            // v0.4.4 隐私脱敏：缓存键只返回内容指纹，不再把归一化内容原文回显一遍
            text: stableStringify({ rows: normalized, key: `nk-${hashString(JSON.stringify(normalized))}` }),
          },
        ],
      };
    },
  );
}

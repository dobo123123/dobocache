/**
 * DoboCache memoryInject — 记忆提纯注入
 * 在稳定前缀工程思路下做三件事：
 *   1) 版本化规则前缀：固定字节不变的约束指令块（保证厂商前缀缓存逐字节命中）
 *   2) 价值分级片段注入：A→B 按价值排序填入，同一 query 下注入结果逐字节稳定
 *   3) 尾部动态区：只放当前请求本身，是整条上下文中唯一变化的区域
 */

import type { TieredFragment } from "./valueTier.js";
import { estimateTokens, hashString } from "../utils/serialize.js";

export interface InjectRules {
  version: string;
  constraints: string[];
}

export interface InjectOptions {
  prefixHeader?: string;   // 前缀标题，默认 "【DoboCache 缓存上下文】"
  separator?: string;      // 片段分隔符
  maxTokens?: number;      // 注入后整体 token 上限（粗略估算）
}

export interface InjectResult {
  prompt: string;
  prefix: string;          // 稳定前缀（含规则块）
  body: string;            // 分级片段区
  tail: string;            // 尾部动态区（当前请求）
  tokens: number;
  fragments: TieredFragment[];
}

export const DEFAULT_RULES: InjectRules = {
  version: "dobocache-v1",
  constraints: [
    "严格基于以下缓存上下文作答，禁止编造缺失信息。",
    "缓存上下文按 A/B 价值分级排列，高价值在前。",
    "若缓存上下文与当前请求冲突，以当前请求为准。",
  ],
};

/** 构建版本化稳定前缀：规则块字节级固定，升级规则时仅递增 version */
export function buildStablePrefix(rules: InjectRules = DEFAULT_RULES, header?: string): string {
  const h = header ?? "【DoboCache 缓存上下文】";
  const constraints = rules.constraints.map((c) => `- ${c}`).join("\n");
  return `${h} v${rules.version}\n${constraints}\n\n`;
}

/** 把准入片段按 A→B 价值排序并格式化为正文区（确定性：同输入同输出） */
export function buildBody(fragments: TieredFragment[], separator = "\n\n"): string {
  const tierRank: Record<string, number> = { A: 0, B: 1, C: 2 };
  const sorted = [...fragments].sort((a, b) => {
    const d = tierRank[a.tier] - tierRank[b.tier];
    return d !== 0 ? d : b.score - a.score;
  });

  return sorted
    .map((f) => `[${f.id}|${f.tier}] ${f.content}`)
    .join(separator);
}

/**
 * 记忆提纯注入：稳定前缀 + 分级片段 + 当前请求尾部。
 * 注入结果只依赖 (规则版本, 准入片段列表, 当前请求)，三者相同时逐字节一致。
 */
export function injectMemory(
  currentRequest: string,
  fragments: TieredFragment[],
  opts: InjectOptions = {},
): InjectResult {
  const prefix = buildStablePrefix(undefined, opts.prefixHeader);
  const body = buildBody(fragments, opts.separator);
  const tail = currentRequest;

  let prompt = prefix;
  if (body.length > 0) prompt += `${body}\n\n`;
  prompt += tail;

  const tokens = estimateTokens(prompt);

  // 超出 token 上限时按确定性规则收缩：先裁 C 档，再裁 B 档，再截尾部
  if (opts.maxTokens && tokens > opts.maxTokens) {
    let remaining = fragments.filter((f) => f.tier !== "C");
    if (remaining.length === 0) remaining = fragments;
    const shrunkBody = buildBody(remaining, opts.separator);
    prompt = prefix;
    if (shrunkBody.length > 0) prompt += `${shrunkBody}\n\n`;
    prompt += tail;
  }

  return {
    prompt,
    prefix,
    body,
    tail,
    tokens: estimateTokens(prompt),
    fragments,
  };
}

/** 规则提炼：从历史高价值片段中提炼可作为前缀的稳定约束（版本化增量） */
export function distillRules(
  fragments: TieredFragment[],
  prevVersion = "dobocache-v1",
): InjectRules {
  const aFrags = fragments.filter((f) => f.tier === "A").slice(0, 3);
  const constraints = [...DEFAULT_RULES.constraints];

  for (const f of aFrags) {
    const firstLine = f.content.split(/\r?\n/)[0]?.trim();
    if (firstLine && firstLine.length >= 8 && !constraints.includes(firstLine)) {
      constraints.push(firstLine);
    }
  }

  return { version: prevVersion, constraints };
}

/* ==========================================================================
 * 会话增量注入 / 最小有效前缀 / 约束场景化 / 易变内容强制 tail
 * ========================================================================== */

/** 场景化规则：完整约束（缓存充足时启用） */
export const FULL_RULES: InjectRules = DEFAULT_RULES;

/** 场景化规则：首条请求 / 缓存为空时放行自由回答（不注入"禁止编造"类硬约束） */
export const FIRST_TURN_RULES: InjectRules = {
  version: "dobocache-v1-first",
  constraints: [
    "当前缓存上下文可能为空，请基于自身知识自由回答。",
    "若存在缓存上下文，可参考其中高价值信息，缺失部分不强行补全。",
  ],
};

export type RuleScenario = "first" | "full";

/** 场景化规则：平衡约束（缓存上下文优先，允许基于自身知识补充缺失并标注；v0.4.2 新增，回应「禁止编造硬约束导致多次拒绝作答」） */
export const BALANCED_RULES: InjectRules = {
  version: "dobocache-v1-balanced",
  constraints: [
    "优先基于以下缓存上下文作答；缓存未覆盖的部分可结合自身知识补充，并标注为推测。",
    "缓存上下文按 A/B 价值分级排列，高价值在前。",
    "若缓存上下文与当前请求冲突，以当前请求为准。",
  ],
};

export type Strictness = "strict" | "balanced" | "loose";

/** strictness → 规则集（v0.4.2）：strict=完整硬约束；balanced=平衡；loose=自由放行 */
export function rulesForStrictness(strictness: Strictness): InjectRules {
  switch (strictness) {
    case "balanced":
      return BALANCED_RULES;
    case "loose":
      return FIRST_TURN_RULES;
    case "strict":
    default:
      return FULL_RULES;
  }
}

/** 最小有效前缀长度门槛（v0.4.2 由 200 提到 256：实测 200~256 估算区间仍低于厂商真实门槛，会导致首次请求空窗） */
export const DEFAULT_MIN_PREFIX_TOKENS = 256;

/** 最小前缀门槛安全余量（v0.4.2 新增，默认 1.15）：实际门槛 = ceil(minPrefixTokens × safetyFactor)，补偿估算 token 与厂商真实 tokenizer 的偏差 */
export const DEFAULT_MIN_PREFIX_SAFETY_FACTOR = 1.15;

/** 固定版本文档块：前缀不足门槛时附加，字节级固定，仅随版本升级变化 */
export const MIN_PREFIX_FILL_DOC_BLOCKS: string[] = [
  "DoboCache 稳定前缀工程：固定版本化前缀 + 分级片段分块 + 增量 tail；同会话内已注入前缀逐字节不变，新内容只追加到尾部，以命中厂商前缀缓存。",
  "接入约定：cf_judge 判定命中 → cf_tier 价值分级准入 → cf_inject 会话增量注入 → cf_meter 观测命中率与 token 节省。",
];

/** 易变内容识别模式：时间戳 / 会话标记 / 最新消息等一律剥离到 tail */
export const VOLATILE_PATTERNS: RegExp[] = [
  /(?:当前时间|现在时间|时间戳|更新时间|创建时间|最后更新)[:：]?\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?/g,
  /\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /(?:会话ID|会话标记|会话标识|sessionId|session_id|sid)[:：= ]+\s*[A-Za-z0-9_-]{6,}/gi,
  /(?:最新消息|最近消息)[:：]?[^\n]{0,40}/g,
];

export interface VolatileExtraction {
  stable: string;
  volatile: string[];
  hasVolatile: boolean;
}

/** 从文本中剥离易变内容（时间戳/会话标记/最新消息），返回稳定正文与易变片段 */
export function extractVolatileParts(text: string): VolatileExtraction {
  if (!text) return { stable: "", volatile: [], hasVolatile: false };
  let stable = text;
  const found: string[] = [];
  for (const re of VOLATILE_PATTERNS) {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    stable = stable.replace(rx, (matched) => {
      found.push(matched.trim());
      return "";
    });
  }
  stable = stable.replace(/\n{3,}/g, "\n\n").trim();
  const volatile = [...new Set(found.map((v) => v.trim()).filter(Boolean))];
  return { stable, volatile, hasVolatile: volatile.length > 0 };
}

/**
 * 按场景选择约束规则：
 * - 缓存充足（有准入片段且前缀达最小门槛）→ 完整约束（含"禁止编造"）
 * - 首条请求 / 缓存为空 → 放行自由回答（轻量提示，无硬约束）
 */
export function resolveRulesForScenario(opts: {
  hasAdmitted?: boolean;
  prefixTokens?: number;
  minPrefixTokens?: number;
  scenario?: RuleScenario;
}): { scenario: RuleScenario; rules: InjectRules } {
  if (opts.scenario === "full") return { scenario: "full", rules: FULL_RULES };
  if (opts.scenario === "first") return { scenario: "first", rules: FIRST_TURN_RULES };
  const min = opts.minPrefixTokens ?? DEFAULT_MIN_PREFIX_TOKENS;
  const tokens = opts.prefixTokens ?? 0;
  if (opts.hasAdmitted && tokens >= min) return { scenario: "full", rules: FULL_RULES };
  return { scenario: "first", rules: FIRST_TURN_RULES };
}

/**
 * 前缀过门槛补充：先并池中高价值片段，再循环附加固定版本文档块，直至达到最小有效长度。
 * v0.2.1 修复：docBlocks 循环追加（此前只遍历一次，前缀过短时补不达门槛 → 首次请求空窗）；
 * 支持 maxPrefixTokens 软上限，maxTokens 提高时首次请求可并入更多高价值片段。
 */
export function topUpPrefixToMin(
  prefix: string,
  poolFragments: TieredFragment[],
  docBlocks: string[],
  minTokens = DEFAULT_MIN_PREFIX_TOKENS,
  separator = "\n\n",
  maxPrefixTokens?: number,
): { prefix: string; addedFragments: number; addedDocs: number } {
  let p = prefix;
  let cur = estimateTokens(p);
  let addedFragments = 0;
  let addedDocs = 0;
  const maxPrefix = maxPrefixTokens !== undefined ? maxPrefixTokens : Number.MAX_SAFE_INTEGER;
  const sortedPool = [...poolFragments].sort((a, b) => b.score - a.score);
  for (const f of sortedPool) {
    if (cur >= minTokens || cur >= maxPrefix) break;
    p += `${separator}[${f.id}|${f.tier}] ${f.content}`;
    cur = estimateTokens(p);
    addedFragments += 1;
  }
  // 循环追加固定版本文档块直至达标；guard 防死循环（无 docBlocks 时如实保留未达标状态）
  let guard = 0;
  while (cur < minTokens && docBlocks.length > 0 && guard < 128) {
    for (const d of docBlocks) {
      if (cur >= minTokens || cur >= maxPrefix) break;
      p += `${separator}${d}`;
      cur = estimateTokens(p);
      addedDocs += 1;
    }
    guard += 1;
  }
  return { prefix: p, addedFragments, addedDocs };
}

export interface IncrementalOptions extends InjectOptions {
  sessionId?: string;
  /** 上一次请求返回的 prefixHash；与当前候选前缀一致时标记 reusedPrefix=true（跨请求前缀复用，兼容无冻结信息场景） */
  previousPrefixHash?: string;
  /** 上一次请求的冻结前缀（SessionInjectStore 提供）；与当前前缀逐字节一致时 reusedPrefix=true（v0.2.1 语义修复） */
  previousFrozenPrefix?: string;
  /** 上一次请求的冻结片段集合（SessionInjectStore 提供）；用于计算 frozenHitRatio / frozenReused 明细 */
  previousFrozenFragments?: TieredFragment[];
  /** 最小有效前缀长度门槛（token），默认 DEFAULT_MIN_PREFIX_TOKENS */
  minPrefixTokens?: number;
  /** 固定版本文档块（过门槛用），默认 MIN_PREFIX_FILL_DOC_BLOCKS */
  minPrefixDocBlocks?: string[];
  /** 可补充的高价值记忆片段池（过门槛用；已入前缀的片段按 id 自动去重） */
  poolFragments?: TieredFragment[];
  /** 显式易变内容，强制进 tail */
  volatile?: string[];
  /** 是否自动剥离片段中的易变内容（默认 true） */
  stripVolatileFromFragments?: boolean;
  /** 显式指定场景（测试 / 外部覆盖用） */
  scenario?: RuleScenario;
  /** 128-token 对齐开关（v0.2.1 新增，默认开启；false 恢复原行为） */
  align128?: boolean;
  /** 128 对齐填充块（默认 DEFAULT_ALIGN_FILL_BLOCK；长度需让 estimateTokens 精确，否则为启发式近似） */
  alignFillText?: string;
  /** 约束强度（v0.4.2）：strict（完整硬约束，默认）/ balanced（平衡，允许自身知识补充并标注）/ loose（自由放行）；仅影响 full 场景规则集；同一会话冻结后以冻结值为准 */
  strictness?: Strictness;
  /** 最小前缀门槛安全余量（v0.4.2 新增，默认 1.15）：实际门槛 = ceil(minPrefixTokens × safetyFactor) */
  minPrefixSafetyFactor?: number;
}

/** 厂商前缀缓存块粒度启发值（实测命中呈 128-token 块步进，复跑方法见 release/testdata/） */
export const ALIGN_BLOCK_TOKENS = 128;

/** 128 对齐默认填充块：纯 ASCII 注释，28 字符 ≈ 7 tokens，与 128 互质，可近似补齐任意余数 */
export const DEFAULT_ALIGN_FILL_BLOCK = "/* dobocache-align-128 */\n";

/**
 * 128-token 对齐（启发式）：无 tokenizer 条件下按字符估算 token，
 * 稳定前缀尾部按 128 倍数补齐（追加固定对齐块，保持前缀字节稳定），
 * 减少厂商缓存尾部部分命中。返回对齐后的前缀与追加块数。
 */
export function alignPrefixTo128(
  prefix: string,
  fillText = DEFAULT_ALIGN_FILL_BLOCK,
  blockTokens = ALIGN_BLOCK_TOKENS,
): { prefix: string; addedBlocks: number } {
  let p = prefix;
  let cur = estimateTokens(p);
  const fillTokens = Math.max(1, estimateTokens(fillText));
  let added = 0;
  let guard = 0;
  while (cur % blockTokens !== 0 && guard < 512) {
    p += fillText;
    cur = estimateTokens(p);
    added += 1;
    guard += 1;
  }
  void fillTokens;
  return { prefix: p, addedBlocks: added };
}

export interface IncrementalInjectResult {
  prompt: string;
  prefix: string;              // 稳定前缀（规则块 + 分级片段分块 + 过门槛补充 + 128 对齐块）
  body: string;                // 分级片段区（不含补充块）
  tail: string;                // 增量尾部（易变内容 + 本次请求）
  tokens: number;
  prefixHash: string;          // 前缀指纹（跨请求复用判定依据）
  prefixTokens: number;
  prefixReady: boolean;        // 是否达到最小有效前缀长度
  reusedPrefix: boolean;       // 本次是否复用上一次请求的冻结前缀（v0.2.1：与冻结前缀逐字节比对）
  scenario: RuleScenario;
  volatile: string[];
  fragments: TieredFragment[]; // 实际进入前缀的片段
  poolUsed: number;            // 过门槛补充使用的片段/文档块总数
  /** v0.2.1 新增：上一次请求的冻结片段在本次原样复用的比例（0-100；无上一次请求冻结时为 0） */
  frozenHitRatio: number;
  /** v0.2.1 新增：冻结片段复用/替换明细 */
  frozenReused: { reused: string[]; replaced: string[] };
  /** v0.2.1 新增：128 对齐追加的填充块数 */
  alignBlocks: number;
  /** v0.4.2 新增：实际生效的最小前缀门槛（ceil(minPrefixTokens × safetyFactor)） */
  effectiveMinPrefixTokens?: number;
  /** v0.4.2 新增：实际生效的约束强度（strict/balanced/loose） */
  strictness?: Strictness;
  /** v0.4.2 新增：上一次请求的冻结片段自身 tokens（便于客户端判断冻结是否值得） */
  frozenFragmentsTokens?: number;
}

/**
 * 会话增量注入：固定版本化前缀 + 分块正文 + 增量 tail。
 * - 同一会话内前缀（规则块 + 已注入分级片段 + 固定补充块）逐字节不变；
 * - 新内容（本次请求 + 易变内容）只追加到尾部 tail；
 * - 传入 previousPrefixHash 且与当前候选前缀一致时标记复用，支持跨请求前缀复用。
 */
export function injectIncremental(
  currentRequest: string,
  fragments: TieredFragment[],
  opts: IncrementalOptions = {},
): IncrementalInjectResult {
  const minTokens = opts.minPrefixTokens ?? DEFAULT_MIN_PREFIX_TOKENS;
  const safetyFactor = opts.minPrefixSafetyFactor ?? DEFAULT_MIN_PREFIX_SAFETY_FACTOR;
  const effectiveMin = Math.max(1, Math.ceil(minTokens * safetyFactor));
  const separator = opts.separator ?? "\n\n";
  const header = opts.prefixHeader;

  // 1) 易变内容剥离：请求 + 片段中的时间戳/会话标记/最新消息一律进 tail
  const reqParts = extractVolatileParts(currentRequest);
  const volatileFromReq = reqParts.volatile;
  let cleanFragments = fragments;
  const volatileFromFrags: string[] = [];
  if (opts.stripVolatileFromFragments !== false) {
    const cleaned: TieredFragment[] = [];
    for (const f of fragments) {
      const parts = extractVolatileParts(f.content);
      volatileFromFrags.push(...parts.volatile);
      if (parts.stable.length > 0) {
        cleaned.push({ ...f, content: parts.stable, chars: parts.stable.length });
      }
    }
    cleanFragments = cleaned;
  }
  const volatile = [...new Set([...(opts.volatile ?? []), ...volatileFromFrags, ...volatileFromReq])];

  // 2) 场景化约束选择：先按完整约束估算前缀长度，判断缓存是否充足
  const body = buildBody(cleanFragments, separator);
  const fullPrefix = buildStablePrefix(FULL_RULES, header);
  const fullBodyPrefix = fullPrefix + (body.length > 0 ? `${body}\n\n` : "");
  const fullTokens = estimateTokens(fullBodyPrefix);
  const hasAdmitted = cleanFragments.length > 0;
  const resolved = resolveRulesForScenario({
    hasAdmitted,
    prefixTokens: fullTokens,
    minPrefixTokens: effectiveMin,
    scenario: opts.scenario,
  });

  // 3) 构建稳定前缀（规则块 + 分级片段分块）；v0.4.2：full 场景按 strictness 选择规则集，first 场景一律放行
  const requestedStrictness = opts.strictness ?? "strict";
  const rules =
    resolved.scenario === "first"
      ? FIRST_TURN_RULES
      : rulesForStrictness(requestedStrictness);
  let prefix = buildStablePrefix(rules, header);
  if (body.length > 0) prefix += `${body}\n\n`;

  // 4) 最小有效前缀长度过门槛：补高价值片段 → 循环补固定版本文档块（必然达标）
  const usedIds = new Set(cleanFragments.map((f) => f.id));
  const pool = (opts.poolFragments ?? []).filter((f) => !usedIds.has(f.id));
  const docBlocks = opts.minPrefixDocBlocks ?? MIN_PREFIX_FILL_DOC_BLOCKS;
  let topUp = topUpPrefixToMin(prefix, pool, docBlocks, effectiveMin, separator);
  prefix = topUp.prefix; // v0.4.3：minPrefixTokens 失效修复——补充结果必须赋回 prefix，否则 prefixReady 恒 false

  // 5) 增量 tail：易变内容块 + 本次稳定请求（只含本次新增，绝不重放历史）
  const volatileBlock =
    volatile.length > 0 ? volatile.map((v) => `[动态] ${v}`).join("\n") : "";
  let tail = volatileBlock ? `${volatileBlock}\n${stableRequestOf(reqParts, currentRequest)}` : stableRequestOf(reqParts, currentRequest);

  // 6) 组装 prompt = 前缀 + tail
  let prompt = prefix + tail;
  let finalFragments =
    topUp.addedFragments > 0 ? [...cleanFragments, ...pool.slice(0, topUp.addedFragments)] : cleanFragments;

  // 7) maxTokens 收缩：前缀超限时确定性裁档重建（v0.2.1：同步更新 prefix 变量，避免返回旧值误导），tail 超限时裁剪 tail
  if (opts.maxTokens) {
    const max = opts.maxTokens;
    const maxPrefixTokens = Math.max(effectiveMin, Math.floor(max * 0.8)); // 前缀软上限，保留 20% 给 tail
    if (estimateTokens(prefix) > max) {
      const tierDropOrder: Array<Array<"A" | "B" | "C">> = [["C"], ["C", "B"], ["C", "B", "A"]];
      for (const drop of tierDropOrder) {
        const cand = cleanFragments.filter((f) => !drop.includes(f.tier));
        const candBody = buildBody(cand, separator);
        let p = buildStablePrefix(rules, header);
        if (candBody.length > 0) p += `${candBody}\n\n`;
        const t = topUpPrefixToMin(p, pool, docBlocks, effectiveMin, separator, maxPrefixTokens);
        const tTokens = estimateTokens(t.prefix);
        if (tTokens <= max || tTokens < estimateTokens(prefix)) {
          topUp = t;
          prefix = t.prefix;
          finalFragments = t.addedFragments > 0 ? [...cand, ...pool.slice(0, t.addedFragments)] : cand;
          break;
        }
      }
    }
    // tail 收缩（前缀优先稳定）
    while (estimateTokens(prefix + tail) > max && tail.length > 0) {
      tail = tail.slice(0, Math.max(0, tail.length - 20));
    }
    prompt = prefix + tail;
  }

  // 8) 128-token 对齐（v0.2.1，默认开启）：在最终前缀尾部补齐固定对齐块，减少尾部部分命中
  let alignBlocks = 0;
  if (opts.align128 !== false) {
    const aligned = alignPrefixTo128(prefix, opts.alignFillText);
    prefix = aligned.prefix;
    alignBlocks = aligned.addedBlocks;
    prompt = prefix + tail;
  }

  // 9) 最终前缀指纹与冻结语义（v0.2.1：基于最终 prefix 计算，不再使用收缩前旧值）
  const prefixHash = hashString(prefix);
  const prefixTokens = estimateTokens(prefix);
  const prefixReady = prefixTokens >= effectiveMin;
  const reusedPrefix =
    opts.previousFrozenPrefix !== undefined
      ? opts.previousFrozenPrefix === prefix
      : opts.previousPrefixHash !== undefined && opts.previousPrefixHash === prefixHash;

  // 上一次请求的冻结片段在本次的复用比例与明细（比较前做同样的易变剥离，保证口径一致）
  const frozenReused: { reused: string[]; replaced: string[] } = { reused: [], replaced: [] };
  let frozenHitRatio = 0;
  if (opts.previousFrozenFragments && opts.previousFrozenFragments.length > 0) {
    const cleanPrev =
      opts.stripVolatileFromFragments === false
        ? opts.previousFrozenFragments
        : opts.previousFrozenFragments.map((f) => {
            const parts = extractVolatileParts(f.content);
            return parts.stable.length > 0 ? { ...f, content: parts.stable } : f;
          });
    const prevMap = new Map(cleanPrev.map((f) => [f.id, f.content]));
    const finalMap = new Map(finalFragments.map((f) => [f.id, f.content]));
    for (const [id, content] of prevMap) {
      if (finalMap.get(id) === content) frozenReused.reused.push(id);
      else frozenReused.replaced.push(id);
    }
    frozenHitRatio = Math.round((frozenReused.reused.length / prevMap.size) * 1000) / 10;
  }

  // v0.4.2：上一次请求的冻结片段自身 tokens（输出冻结成本，便于客户端判断冻结是否值得）
  let frozenFragmentsTokens: number | undefined;
  if (opts.previousFrozenFragments && opts.previousFrozenFragments.length > 0) {
    frozenFragmentsTokens = estimateTokens(
      opts.previousFrozenFragments.map((f) => f.content).join("\n"),
    );
  }

  return {
    prompt,
    prefix,
    body,
    tail,
    tokens: estimateTokens(prompt),
    prefixHash,
    prefixTokens,
    prefixReady,
    reusedPrefix,
    scenario: resolved.scenario,
    volatile,
    fragments: finalFragments,
    poolUsed: topUp.addedFragments + topUp.addedDocs,
    frozenHitRatio,
    frozenReused,
    alignBlocks,
    effectiveMinPrefixTokens: effectiveMin,
    strictness: resolved.scenario === "first" ? "loose" : requestedStrictness,
    frozenFragmentsTokens,
  };
}

function stableRequestOf(parts: VolatileExtraction, original: string): string {
  return parts.stable.length > 0 ? parts.stable : original;
}

/** 会话冻结前缀注册表：按 sessionId 保存已冻结前缀，保证同会话前缀逐字节不变（纯内存） */
export interface FrozenSession {
  sessionId: string;
  prefixHash: string;
  prefix: string;
  body: string;
  fragments: TieredFragment[];
  scenario: RuleScenario;
  /** v0.4.2：冻结时的约束强度，后续请求强制沿用，避免前缀字节漂移 */
  strictness: Strictness;
  createdAt: number;
}

/**
 * 会话冻结前缀注册表（纯内存，v0.4.0）。
 * 同会话跨请求冻结前缀复用（memoryInject 核心能力）保留；
 * v0.3.0 的磁盘持久化 / list / getDetail / isExpired / resume 能力已剥离，
 * 完整实现不随本包分发，留作后续独立方向复用。
 */
export class SessionInjectStore {
  private static _default: SessionInjectStore | null = null;
  static getDefault(): SessionInjectStore {
    if (!SessionInjectStore._default) SessionInjectStore._default = new SessionInjectStore();
    return SessionInjectStore._default;
  }

  private map = new Map<string, FrozenSession>();

  get(sessionId: string): FrozenSession | undefined {
    return this.map.get(sessionId);
  }

  set(sessionId: string, frozen: FrozenSession): void {
    this.map.set(sessionId, frozen);
  }

  remove(sessionId: string): void {
    this.map.delete(sessionId);
  }

  clear(): void {
    this.map.clear();
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  size(): number {
    return this.map.size;
  }
}

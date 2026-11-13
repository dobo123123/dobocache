/**
 * usage.ts —— 从上游响应体提取缓存命中数据
 *
 * 支持两种主流 wire 方言：
 *  - OpenAI 兼容（含 DeepSeek）：usage.prompt_tokens / prompt_tokens_details.cached_tokens
 *    （DeepSeek 另暴露 prompt_cache_hit_tokens，一并兼容）
 *  - Anthropic：usage.input_tokens / cache_read_input_tokens / cache_creation_input_tokens
 *
 * 拿不到厂商 usage 时一律返回 judged=false、hitRatio=null，
 * 严禁把"没数据"当成 0% 记账。
 */

import type { UsageSample, Vendor } from "./types.js";

/** 对象守卫：只认普通对象，避免拿到数组/字符串后误判 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 数字守卫：只认 ≥0 的有限数字 */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 未判定样本：忠实记录"没有厂商 usage"这一事实 */
function unknownSample(vendor: Vendor): UsageSample {
  return { inputTokens: 0, cachedTokens: 0, hitRatio: null, vendor, judged: false };
}

/** 从响应体里抠出 usage 对象；payload 本身是 usage 时也接受 */
function pickUsage(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) return null;
  if (isObject(payload.usage)) return payload.usage;
  if ("prompt_tokens" in payload || "input_tokens" in payload || "cache_read_input_tokens" in payload) {
    return payload;
  }
  return null;
}

/** OpenAI 兼容格式：prompt_tokens + cached_tokens（含 DeepSeek 别名） */
function fromOpenAI(usage: Record<string, unknown>): UsageSample | null {
  const prompt = num(usage.prompt_tokens);
  if (prompt === null) return null;
  const details = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cached =
    num(details.cached_tokens) ??
    num(usage.prompt_cache_hit_tokens) ?? // DeepSeek
    0;
  const hitRatio = prompt > 0 ? Math.round((cached / prompt) * 10000) / 10000 : null;
  return {
    inputTokens: prompt,
    cachedTokens: cached,
    hitRatio,
    vendor: "openai",
    judged: true,
  };
}

/** Anthropic 格式：input_tokens + cache_read / cache_creation */
function fromAnthropic(usage: Record<string, unknown>): UsageSample | null {
  // OpenAI Responses 也用 input_tokens，但必定带 input_tokens_details；
  // 见到它就说明不是 Anthropic，交给 fromResponses 处理，避免把命中量误判成 0
  if (isObject(usage.input_tokens_details)) return null;
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens) ?? 0;
  const cacheCreation = num(usage.cache_creation_input_tokens) ?? 0;
  // 两者都拿不到时不算 Anthropic（可能只是巧合字段名）
  if (input === null && cacheRead === 0 && cacheCreation === 0) return null;
  const total = (input ?? 0) + cacheRead + cacheCreation;
  const hitRatio = total > 0 ? Math.round((cacheRead / total) * 10000) / 10000 : null;
  return {
    inputTokens: total,
    cachedTokens: cacheRead,
    hitRatio,
    vendor: "anthropic",
    judged: true,
  };
}

/**
 * 从上游响应体提取缓存命中样本。
 * vendorHint 是路由表声明的方言（如 /deepseek 声明为 openai），只用于未知时兜底标记。
 */
export function extractUsage(payload: unknown, vendorHint: Vendor = "unknown"): UsageSample {
  const usage = pickUsage(payload);
  if (!usage) return unknownSample(vendorHint);

  const fromOai = fromOpenAI(usage);
  if (fromOai) return fromOai;

  const fromAnt = fromAnthropic(usage);
  if (fromAnt) return fromAnt;

  const fromResp = fromResponses(usage);
  if (fromResp) return fromResp;

  return unknownSample(vendorHint);
}

/** OpenAI Responses 方言：input_tokens + input_tokens_details.cached_tokens */
function fromResponses(usage: Record<string, unknown>): UsageSample | null {
  const input = num(usage.input_tokens);
  if (input === null) return null;
  // 只认带 input_tokens_details 的形态，避免把 Anthropic 的 input_tokens 误当 Responses
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : null;
  if (!details) return null;
  const cached = num(details.cached_tokens) ?? 0;
  const hitRatio = input > 0 ? Math.round((cached / input) * 10000) / 10000 : null;
  return {
    inputTokens: input,
    cachedTokens: cached,
    hitRatio,
    vendor: "openai",
    judged: true,
  };
}

/**
 * 找出帧里真正承载 usage 的对象。
 * 不同方言的挂载位置不同，实测形态：
 *  - OpenAI chat：顶层 usage
 *  - OpenAI Responses：response.completed 帧的 response.usage（Codex CLI 走这条）
 *  - Anthropic：message_start 帧的 message.usage / message_delta 帧的顶层 usage
 */
function pickUsageFromFrame(frame: Record<string, unknown>): Record<string, unknown> | null {
  if (isObject(frame.usage)) return frame.usage;
  if (isObject(frame.response) && isObject(frame.response.usage)) return frame.response.usage;
  if (isObject(frame.message) && isObject(frame.message.usage)) return frame.message.usage;
  return null;
}

/** 从 SSE 文本里解析最后一个携带 usage 的数据帧 */
export function extractUsageFromSse(sseText: string, vendorHint: Vendor = "unknown"): UsageSample | null {
  let last: UsageSample | null = null;
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "" || data === "[DONE]") continue;
    try {
      const frame = JSON.parse(data) as unknown;
      if (!isObject(frame)) continue;
      const usage = pickUsageFromFrame(frame);
      if (!usage) continue;
      const sample = extractUsage({ usage }, vendorHint);
      if (sample.judged) last = sample;
    } catch {
      // 单个数据帧解析失败不影响其余帧
    }
  }
  return last;
}

/**
 * 粗估一段文本的 token 数（用于厂商没回传 usage 时的兜底估算）：
 *  - 中文字符 1 字 ≈ 1.5 token
 *  - 其余字符（含英文/数字/符号）按 4 字符 ≈ 1 token
 * 仅用于交接单记录与展示提示，绝不冒充厂商官方计量。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const restCount = Math.max(0, text.length - cjkCount);
  return Math.max(0, Math.ceil(cjkCount * 1.5 + restCount / 4));
}

/**
 * inject.ts —— 流式 usage 注入（只针对 OpenAI 方言）
 *
 * 为什么需要这一层：
 *   OpenAI 兼容接口在 stream=true 时，默认**不回传 usage**（只在每个 delta 里给内容），
 *   于是代理拿不到 prompt_tokens / cached_tokens，体检卡只能写"未判定"。
 *   厂商的规范做法是客户端显式带上：
 *       "stream_options": { "include_usage": true }
 *   之后流的最后一帧会带 usage（DeepSeek / OpenAI / 多数兼容网关都支持）。
 *
 * 四条自我约束：
 *  - 只补字段，不改语义：客户端自己写了 include_usage（哪怕是 false）就一律不动；
 *  - 只在"真的需要"时动手：非 OpenAI 方言、非流式、非对象请求体，一律原样返回同一个 Buffer 引用；
 *  - 一定要可回退：注入前的 body / parsed 原样保留在 previous 里，
 *    上游不认这个字段时能按原字节重发，不改第二次；
 *  - 不猜厂商：不认识的 stream_options 形态（不是对象）直接不碰，宁可不注入也不破坏客户端参数。
 *
 * 只使用 Node 内置模块，不引入任何第三方依赖。
 */

import { Buffer } from "node:buffer";

import type { InjectUsageStatus, Vendor } from "./types.js";

/** 注入结果 */
export interface InjectUsageResult {
  /** 实际应发往上游的 body；未注入时与入参是同一个 Buffer 引用 */
  body: Buffer;
  /** 与 body 对应的解析结果；未注入时与入参是同一个引用 */
  parsed: unknown;
  /** 本次生效状态 */
  status: InjectUsageStatus;
  /** 是否真的往请求体里加了字段 */
  injected: boolean;
  /** 注入前的快照（重试时按字节原样重发）；未注入时为 null */
  previous: { body: Buffer; parsed: unknown } | null;
  /** 未注入的原因（排障用） */
  reason?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 路由没声明方言时的兜底判断：有 messages 数组且没有 anthropic 独有的 system 字段 */
function looksLikeOpenAi(parsed: unknown): boolean {
  return isObject(parsed) && Array.isArray(parsed.messages) && !("system" in parsed);
}

/** 当前请求是不是"流式"（只认严格的 true，字符串 "true" 不认） */
export function isStreamRequest(parsed: unknown): boolean {
  return isObject(parsed) && parsed.stream === true;
}

/**
 * 给 OpenAI 方言的流式请求补 stream_options.include_usage。
 * 幂等：同一份 body 反复调用，第二次起就是 already-set（因为第一次已经写进去了）。
 */
export function injectStreamUsage(params: {
  body: Buffer;
  parsed: unknown;
  vendor: Vendor;
  enabled: boolean;
}): InjectUsageResult {
  const { body, parsed, vendor, enabled } = params;
  const untouched = (status: InjectUsageStatus, reason?: string): InjectUsageResult => ({
    body,
    parsed,
    status,
    injected: false,
    previous: null,
    ...(reason === undefined ? {} : { reason }),
  });

  if (!enabled) return untouched("disabled", "开关关闭（--inject-usage off）");
  if (parsed === undefined) return untouched("not-applicable", "非 JSON 请求体");
  if (!isObject(parsed)) return untouched("not-applicable", "请求体不是对象");

  // 路由未声明方言时按请求体形状兜底，避免自建网关（vendor 未写）被漏掉
  const dialect: Vendor = vendor === "unknown" ? (looksLikeOpenAi(parsed) ? "openai" : "unknown") : vendor;
  if (dialect !== "openai") return untouched("not-applicable", "非 OpenAI 方言");
  if (!isStreamRequest(parsed)) return untouched("not-applicable", "非流式请求（stream 不为 true）");

  const existing = parsed.stream_options;
  if (isObject(existing) && "include_usage" in existing) {
    return untouched("already-set", "客户端已显式设置 stream_options.include_usage");
  }
  // 不认识的形态（字符串/数字/null）：不合并、不覆盖，宁可不注入
  if (existing !== undefined && !isObject(existing)) {
    return untouched("not-applicable", "stream_options 形态不认识，未改动");
  }

  try {
    const nextParsed: Record<string, unknown> = { ...parsed };
    // 保留客户端已有的 stream_options 子字段，只补 include_usage
    nextParsed.stream_options = isObject(existing) ? { ...existing, include_usage: true } : { include_usage: true };
    const nextBody = Buffer.from(JSON.stringify(nextParsed), "utf-8");
    return {
      body: nextBody,
      parsed: nextParsed,
      status: "injected",
      injected: true,
      previous: { body, parsed },
    };
  } catch (err) {
    // 序列化失败（极端循环引用等）：回退为原样转发，绝不阻断请求
    return untouched("not-applicable", `注入序列化失败：${(err as Error)?.message ?? err}`);
  }
}

/**
 * 上游报错文本里是否在说"不认识这个字段/参数"。
 * 只认明确的未知字段措辞，避免把 429 限流、401 鉴权失败也当成可重试原因。
 */
const UNKNOWN_FIELD_PATTERNS: RegExp[] = [
  /unrecognized\s+(?:request\s+)?(?:argument|parameter|field)/i,
  /unknown\s+(?:request\s+)?(?:argument|parameter|field)/i,
  /unsupported\s+(?:request\s+)?(?:argument|parameter|field)/i,
  /(?:argument|parameter|field)\s+[^\n]{0,60}?\b(?:not\s+(?:supported|recognized|allowed|permitted)|unknown)\b/i,
  /(?:extra|unexpected)\s+(?:field|parameter|argument)/i,
  /(?:未知|不支持|无法识别|多余的)\s*(?:字段|参数)/,
];

/** 上游错误文本是否属于"未知字段"类（用于决定要不要去掉注入字段重试） */
export function isUnknownFieldError(responseText: string): boolean {
  if (!responseText) return false;
  // 只看前 8 KB，错误体再长也不至于把原因写在第 10 KB 之后
  const head = responseText.slice(0, 8192);
  return UNKNOWN_FIELD_PATTERNS.some((pattern) => pattern.test(head));
}

/**
 * 是否应当"去掉注入字段重试一次"。
 * 三个条件同时成立才重试：本次确实注入过、上游回的是 4xx、错误文本明确说字段不认识。
 * 5xx / 429 / 网络错误一律不重试（重试也没用，还会让用户多等一次）。
 */
export function shouldRetryWithoutInjection(params: {
  statusCode: number;
  responseText: string;
  injected: boolean;
}): boolean {
  const { statusCode, responseText, injected } = params;
  if (!injected) return false;
  if (statusCode < 400 || statusCode > 499) return false;
  return isUnknownFieldError(responseText);
}

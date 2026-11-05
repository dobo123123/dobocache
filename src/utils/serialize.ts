/**
 * DoboCache 确定性序列化工具
 * 稳定前缀工程的地基：同样的对象永远得到同样的字符串，
 * 保证送入 LLM 的上下文逐字节稳定，从而命中厂商前缀缓存。
 */

/** 稳定排序：数组递归稳定化，对象按 key 字典序重排 */
export function stableNormalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => stableNormalize(v));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = stableNormalize(obj[key]);
    }
    return out;
  }
  return value;
}

/** 确定性 JSON 序列化：key 排序 + 稳定的缩进格式 */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(stableNormalize(value), null, indent);
}

/** 构造稳定缓存键：多个片段拼接并归一化 */
export function stableKey(parts: Array<string | undefined>, separator = "::"): string {
  return parts
    .filter((p): p is string => p !== undefined && p !== null && p.length > 0)
    .map((p) => p.trim().replace(/\s+/g, " "))
    .join(separator);
}

/** 粗略 token 估算：中文/全角按 1 token/字符，英文按 4 字符/token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x2e7f) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk + ascii / 4);
}

/** 字符级预算换算为 token 预算的辅助：默认 1 token ≈ 2 个 CJK 字符 */
export function charsToTokens(chars: number, mode: "cjk" | "mixed" = "mixed"): number {
  return mode === "cjk" ? Math.ceil(chars / 2) : Math.ceil(chars / 4);
}

/**
 * 稳定前缀指纹：对任意文本计算确定性 64bit 哈希（CyclicHash 变体）。
 * 用于会话增量注入的跨请求前缀复用判定：同前缀必同 hash，hash 不同即前缀已变。
 */
export function hashString(input: string): string {
  if (!input) return "0000000000000000";
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = (h2 >>> 0).toString(16).padStart(8, "0");
  const hi = (h1 >>> 0).toString(16).padStart(8, "0");
  return hi + lo;
}

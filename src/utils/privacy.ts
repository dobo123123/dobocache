/**
 * DoboCache 隐私脱敏工具（v0.4.4）
 * 白盒日志只记录"可追溯、无内容语义"的标识：
 *   - 用户 prompt 原文 → req-<8 位短哈希>（加盐，不可反推、同文同指纹，便于请求级对照）
 *   - 会话标识 sessionId → sid-<8 位短哈希>
 * 仅作用于日志落盘，不影响任何命中判定 / 前缀构造逻辑。
 */

import { hashString } from "./serialize.js";

/** 固定盐：避免短文本被简单字典穷举（跨版本保持一致，保证同文同指纹） */
const PRIVACY_SALT = "dobocache/privacy/v0.4.4";

const REQ_PREFIX = "req-";
const SID_PREFIX = "sid-";

/** 8 位短哈希（取 64bit hash 前 8 位十六进制） */
function shortHash(input: string): string {
  return hashString(`${PRIVACY_SALT}|${input}`).slice(0, 8);
}

/** 用户 prompt → 无内容语义的可追溯标识（同一文本恒得同一标识） */
export function fingerprintPrompt(text: string): string {
  const t = (text ?? "").trim();
  if (!t) return `${REQ_PREFIX}00000000`;
  return `${REQ_PREFIX}${shortHash(t)}`;
}

/** 会话标识 → 无内容语义的可追溯标识 */
export function fingerprintSession(sessionId: string): string {
  const s = (sessionId ?? "").trim();
  if (!s) return `${SID_PREFIX}00000000`;
  return `${SID_PREFIX}${shortHash(`sid|${s}`)}`;
}

/** 是否已是脱敏标识（幂等保护，避免二次哈希） */
export function isFingerprinted(value: string, kind: "req" | "sid"): boolean {
  const prefix = kind === "req" ? REQ_PREFIX : SID_PREFIX;
  return new RegExp(`^${prefix}[0-9a-f]{8}$`).test(value ?? "");
}

/** 幂等脱敏：已是标识则原样返回 */
export function ensureRequestId(value: string): string {
  return isFingerprinted(value, "req") ? value : fingerprintPrompt(value);
}

/** 幂等脱敏：已是标识则原样返回 */
export function ensureSessionId(value: string): string {
  return isFingerprinted(value, "sid") ? value : fingerprintSession(value);
}

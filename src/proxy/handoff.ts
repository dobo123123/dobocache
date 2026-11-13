/**
 * handoff.ts —— 任务交接单生成与读写（纯规则，不调用任何模型）
 *
 * 作用：把一次请求里"人和模型都说了什么、动过哪些文件"抽成结构化交班记录，
 * 换会话/换模型后可以一键续接。这里只做正则与字符串处理，零外部依赖、零网络。
 *
 * 落盘位置：<仓库>/data/handoff/<sessionKey>.json
 * 可用 DOBOSTITCH_HANDOFF_DIR 覆盖（便于测试与多实例隔离）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HandoffRecord } from "./types.js";
import { estimateTokens } from "./usage.js";

/** 单条文本字段的字符上限，防止一条超长消息把整个交接单撑爆 */
const FIELD_CHAR_LIMIT = 600;
/** 保留的 user 指令条数 */
const USER_INSTRUCTION_LIMIT = 5;
/** 保留的本地文件条数 */
const TOUCHED_FILE_LIMIT = 20;
/** 续接摘要的 token 上限 */
const BRIEF_TOKEN_BUDGET = 800;

/** 仓库根目录：src/proxy 或 dist/proxy 向上两级都正好是仓库根 */
function repoRoot(): string {
  try {
    return fileURLToPath(new URL("../../", import.meta.url));
  } catch {
    // 兜底：import.meta.url 不可用（极端打包场景）时退回 cwd
    return process.cwd();
  }
}

/** 交接单目录：环境变量优先，否则 <仓库>/data/handoff */
export function defaultHandoffDir(): string {
  const fromEnv = process.env.DOBOSTITCH_HANDOFF_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(repoRoot(), "data", "handoff");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 裁到指定字符数，超长补省略号（保留头部，因为指令的关键通常在前半段） */
function clip(text: string, limit = FIELD_CHAR_LIMIT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

/** 按估算 token 预算裁剪文本，用于续接摘要 */
function trimToTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  let current = text;
  // 逐步收缩，直到落进预算；收缩步长按 10% 递减，最多 40 轮
  for (let i = 0; i < 40 && estimateTokens(current) > budget; i += 1) {
    const nextLength = Math.floor(current.length * 0.9);
    if (nextLength <= 0) break;
    current = `${current.slice(0, nextLength)}…`;
  }
  return current;
}

/** 取消息里的纯文本（兼容字符串内容与 OpenAI/Anthropic 的块数组） */
function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isObject(block)) continue;
    if (typeof block.text === "string") parts.push(block.text);
    // Anthropic tool_result 的 content 也可能是字符串或块数组
    const nested = block.content;
    if (typeof nested === "string") parts.push(nested);
    else if (Array.isArray(nested)) {
      for (const inner of nested) {
        if (isObject(inner) && typeof inner.text === "string") parts.push(inner.text);
      }
    }
  }
  return parts.join("\n");
}

/** 取消息里的工具名（OpenAI tool_calls + Anthropic tool_use 块 + 旧式 function_call） */
function messageToolNames(message: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isObject(call)) continue;
      const fn = isObject(call.function) ? call.function : null;
      const name = asString(fn?.name);
      if (name) names.push(name);
    }
  }
  const legacy = isObject(message.function_call) ? message.function_call : null;
  const legacyName = asString(legacy?.name);
  if (legacyName) names.push(legacyName);

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_use") {
        const name = asString(block.name);
        if (name) names.push(name);
      }
    }
  }
  return names;
}

/** 从请求体里取 messages 数组 */
function pickMessages(body: unknown): Record<string, unknown>[] {
  if (!isObject(body)) return [];
  const raw = body.messages;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject);
}

/** 文件路径候选的正则（Windows 绝对路径 / POSIX 常见根 / 带扩展名的文件名） */
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'<>|*?，。；、）】》]+/g;
const POSIX_PATH = /\/(?:Users|home|opt|var|tmp|etc|mnt|srv|root)\/[^\s"':<>|*?，。；、）】》]+/g;
const RELATIVE_PATH =
  /\b[\w.-]+(?:\/[\w.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sql|yaml|yml|toml|ini|sh|ps1|bat|txt|csv|html|css|scss|vue|svelte)\b/g;
const FILE_NAME =
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|sql|yaml|yml|toml|ini|sh|ps1|bat|txt|csv|html|css|scss|vue|svelte)\b/g;

/** 去掉路径尾部的标点噪声 */
function cleanCandidate(raw: string): string {
  return raw.replace(/[),;:.!'"`，。；：、）】」》]+$/u, "").trim();
}

/** 扫描文本里的本地文件路径，保序去重 */
function collectFiles(text: string, sink: string[], seen: Set<string>): void {
  for (const pattern of [WINDOWS_PATH, POSIX_PATH, RELATIVE_PATH, FILE_NAME]) {
    pattern.lastIndex = 0;
    let matched = pattern.exec(text);
    while (matched) {
      const candidate = cleanCandidate(matched[0]);
      if (candidate.length > 2 && !seen.has(candidate)) {
        seen.add(candidate);
        sink.push(candidate);
      }
      matched = pattern.exec(text);
    }
  }
}

/**
 * 同一文件常被同时抽到"绝对路径"与"裸文件名"，这里按 basename 合并，
 * 优先保留信息量更大的带目录形式，避免交接单里出现重复条目。
 */
function dedupeByBasename(files: string[]): string[] {
  const basenames = new Set<string>();
  for (const file of files) {
    if (!file.includes("\\") && !file.includes("/")) continue;
    basenames.add(file.split(/[\\/]/).pop() ?? file);
  }
  return files.filter((file) => {
    if (file.includes("\\") || file.includes("/")) return true;
    return !basenames.has(file);
  });
}

/**
 * 生成 sessionKey：上游域名 + 首个 user 消息哈希前 8 位。
 * 哈希只取前 8 位十六进制，落盘文件名不会泄露指令原文。
 */
export function sessionKeyFor(upstream: string, firstUserText: string): string {
  const host = upstream.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase() || "unknown";
  const safeHost = host.replace(/[^\w.-]/g, "_");
  const digest = crypto.createHash("sha256").update(firstUserText).digest("hex").slice(0, 8);
  return `${safeHost}-${digest}`;
}

export interface BuildHandoffInput {
  /** 上游 host（可含路径前缀） */
  upstream: string;
  /** 已解析的请求体（拿不到解析结果就传 undefined） */
  requestBody: unknown;
  /** 捕获时的输入 token；未判定传 0 */
  inputTokens: number;
  /** 请求路径（无 user 文本时用于区分会话，如 "/v1/models"） */
  path?: string;
  /** 当前时间，默认 new Date() */
  now?: Date;
}

/** 从请求体抽取交接单（纯规则） */
export function buildHandoff(input: BuildHandoffInput): HandoffRecord {
  const messages = pickMessages(input.requestBody);
  const userTexts: string[] = [];
  const toolNames: string[] = [];
  const toolSeen = new Set<string>();
  const files: string[] = [];
  const fileSeen = new Set<string>();
  let lastAssistantSummary = "";
  let firstUserText = "";

  for (const message of messages) {
    const role = asString(message.role);
    const text = messageText(message);

    if (role === "user") {
      const cleaned = clip(text);
      if (cleaned) {
        if (!firstUserText) firstUserText = cleaned;
        userTexts.push(cleaned);
      }
    } else if (role === "assistant") {
      const cleaned = clip(text);
      if (cleaned) lastAssistantSummary = cleaned;
    }

    for (const name of messageToolNames(message)) {
      if (!toolSeen.has(name)) {
        toolSeen.add(name);
        toolNames.push(name);
      }
    }

    // 文件线索：正文 + 工具入参（工具入参里常带绝对路径）
    if (text) collectFiles(text, files, fileSeen);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isObject(block) && block.type === "tool_use" && block.input !== undefined) {
          collectFiles(JSON.stringify(block.input), files, fileSeen);
        }
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (isObject(call)) collectFiles(JSON.stringify(call.function ?? {}), files, fileSeen);
      }
    }
  }

  const now = input.now ?? new Date();
  const recentUsers = userTexts.slice(-USER_INSTRUCTION_LIMIT);
  // 去重后保留"最近 20 条"：文件线索按出现顺序收集，这里取尾部
  const touchedFiles = dedupeByBasename(files).slice(-TOUCHED_FILE_LIMIT);
  // 会话种子：优先首个 user 指令；没有 user 文本（如 GET /models）时退到"全部文本 + 路径"，
  // 都没有则用固定占位，避免出现"空内容哈希"这种看不懂的 key。
  const seed =
    firstUserText ||
    messages.map((m) => messageText(m)).join("") ||
    `(no-message)${input.path ?? ""}`;

  return {
    sessionKey: sessionKeyFor(input.upstream, seed),
    createdAt: now.toISOString(),
    upstream: input.upstream,
    lastUserInstruction: recentUsers.length > 0 ? recentUsers[recentUsers.length - 1] : "",
    userInstructions: recentUsers,
    toolNames,
    touchedFiles,
    lastAssistantSummary,
    inputTokensAtCapture: Number.isFinite(input.inputTokens) ? input.inputTokens : 0,
  };
}

/** 落盘交接单，返回实际写入路径；失败抛错由调用方兜住 */
export function saveHandoff(record: HandoffRecord, dir = defaultHandoffDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const safeKey = record.sessionKey.replace(/[^\w.-]/g, "_") || "unknown";
  const target = path.join(dir, `${safeKey}.json`);
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return target;
}

/** 读取指定会话的交接单；不存在或损坏返回 null */
export function loadHandoff(sessionKey: string, dir = defaultHandoffDir()): HandoffRecord | null {
  const safeKey = sessionKey.replace(/[^\w.-]/g, "_");
  const target = path.join(dir, `${safeKey}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as unknown;
    if (!isObject(parsed) || typeof parsed.sessionKey !== "string") return null;
    return parsed as unknown as HandoffRecord;
  } catch {
    return null;
  }
}

/** 列出全部交接单，按创建时间倒序；损坏文件静默跳过 */
export function listHandoffs(dir = defaultHandoffDir()): HandoffRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: HandoffRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const loaded = loadHandoff(entry.slice(0, -".json".length), dir);
    if (loaded) records.push(loaded);
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return records;
}

/**
 * 渲染续接摘要（纯文本，不超过 800 token）：
 * 目标 / 已改文件 / 关键进展 / 下一步提示位。
 */
export function renderResumeBrief(record: HandoffRecord): string {
  const lines: string[] = [];
  const header = `【续接摘要 · dobostitch】会话 ${record.sessionKey}｜上游 ${record.upstream}｜捕获于 ${record.createdAt}`;
  lines.push(trimToTokens(header, 60));
  lines.push("");

  const goal = record.lastUserInstruction || record.userInstructions[0] || "（请求体里没有可识别的 user 指令）";
  lines.push(`目标：${trimToTokens(goal, 160)}`);

  const earlier = record.userInstructions.slice(0, -1);
  if (earlier.length > 0) {
    const history = earlier.map((item, index) => `  ${index + 1}) ${item}`).join("\n");
    lines.push(`之前提过的要求：\n${trimToTokens(history, 160)}`);
  }

  const files = record.touchedFiles.length > 0 ? record.touchedFiles.join("\n  ") : "（未识别到本地文件路径）";
  lines.push(`已改/涉及文件（${record.touchedFiles.length}）：\n  ${trimToTokens(files, 200)}`);

  const tools = record.toolNames.length > 0 ? record.toolNames.join("、") : "（无）";
  lines.push(`用过的工具：${trimToTokens(tools, 60)}`);

  const progress = record.lastAssistantSummary || "（尚未捕获到 assistant 文本）";
  lines.push(`最近进展：${trimToTokens(progress, 160)}`);

  lines.push(`捕获时输入 token：${record.inputTokensAtCapture > 0 ? record.inputTokensAtCapture : "未判定（厂商未回传 usage）"}`);
  lines.push("下一步提示位：请先核对上面「已改/涉及文件」，确认无回退后继续；若目标已变，以最新指令为准。");

  return trimToTokens(lines.join("\n"), BRIEF_TOKEN_BUDGET);
}

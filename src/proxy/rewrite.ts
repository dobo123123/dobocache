/**
 * rewrite.ts —— 请求改写 + 前缀诊断引擎（皮①的算法薄层）
 *
 * 两层能力：
 *  1. 前缀稳定化：把"同一语义的请求"整理成"同一串字节"，让厂商的自动前缀缓存
 *     （DeepSeek / OpenAI / Anthropic 都按前缀连续匹配）不会被序列化抖动打穿；
 *  2. 前缀断点诊断：告诉你前缀在第几段塌了、是"变了"还是"被裁了"。
 *
 * 四条自我约束：
 *  - 不 import 任何内核实现（src/core/*），内核零分叉；
 *  - 不新增第三方依赖，只用 node:crypto / node:buffer；
 *  - messages 顺序绝不动（顺序有语义），只规范化对象内部 key 序；
 *  - mode 为 off / observe 时，返回的 body 必须是入参同一个 Buffer 引用，
 *    绝不重新序列化（保证诊断反映"原样直通"的真实情况）。
 *
 * 本模块不做 token 估算（仓库内没有 tokenizer），只报段数与结构信号。
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { DivergenceKind, PrefixDiag, RewriteMode, Vendor } from "./types.js";

export type { DivergenceKind, PrefixDiag, RewriteMode } from "./types.js";

/** 会话状态表里的一格：上一轮各段 hash + 时间锚点 */
export interface SessionEntry {
  /** 上一轮各段 hash，按顺序 */
  segments: string[];
  /** 对应 kind，便于排障 */
  segmentKinds: string[];
  /** 正则槽位 → 该会话首次见到的时间原串 */
  anchors: Map<string, string>;
  /** Date.now()，用于 LRU 淘汰 */
  lastSeen: number;
}

/** 段切分结果 */
export interface Segment {
  kind: string;
  hash: string;
}

/** 默认最多记多少个会话 */
const DEFAULT_MAX_SESSIONS = 200;

/** 时间锚点正则：数组下标即"槽位号"，同槽位共享一个锚点 */
const TIME_SLOTS: RegExp[] = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?/g,
  /\d{4}年\d{1,2}月\d{1,2}日(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?/g,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 会话状态容器：按 lastSeen 做 LRU，避免长跑进程无限吃内存 */
export class RewriteState {
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(maxSessions: number = DEFAULT_MAX_SESSIONS) {
    this.maxSessions = Number.isFinite(maxSessions) && maxSessions > 0 ? Math.floor(maxSessions) : DEFAULT_MAX_SESSIONS;
  }

  /** 取会话格子；不存在则新建空 entry */
  get(key: string): SessionEntry {
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const entry: SessionEntry = { segments: [], segmentKinds: [], anchors: new Map<string, string>(), lastSeen: Date.now() };
    this.sessions.set(key, entry);
    this.evict();
    return entry;
  }

  /** 当前会话数（自测与排障用） */
  get size(): number {
    return this.sessions.size;
  }

  /** 超过上限时淘汰最久没动的会话 */
  private evict(): void {
    while (this.sessions.size > this.maxSessions) {
      let oldestKey: string | null = null;
      let oldestSeen = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.sessions) {
        if (entry.lastSeen < oldestSeen) {
          oldestSeen = entry.lastSeen;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      this.sessions.delete(oldestKey);
    }
  }
}

/** 稳定序列化：对象 key 按字典序递归输出（不依赖 JSON.stringify 的插入序） */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashOf(value: unknown): string {
  return createHash("sha1").update(stableStringify(value), "utf-8").digest("hex").slice(0, 16);
}

/** 递归把对象树按 key 字典序重建（值不变，只换顺序） */
function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item ?? null));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeValue(value[key]);
    }
    return out;
  }
  return value;
}

/** 取工具名：兼容 {name} 与 {function:{name}} 两种写法 */
function toolNameOf(item: unknown): string {
  if (!isPlainObject(item)) return "";
  if (typeof item.name === "string") return item.name;
  const fn = item.function;
  if (isPlainObject(fn) && typeof fn.name === "string") return fn.name;
  return "";
}

/**
 * 零语义风险变换：
 *  1. 递归 key 序规范化；
 *  2. tools 数组按工具名稳定排序（同名保持原相对顺序）。
 * messages 数组顺序绝不动。
 */
export function normalizeStructure(parsed: unknown): { value: unknown; toolsSorted: boolean } {
  const normalized = normalizeValue(parsed);
  let toolsSorted = false;
  if (!isPlainObject(normalized)) return { value: normalized, toolsSorted };

  const tools = normalized.tools;
  if (Array.isArray(tools) && tools.length > 1) {
    const before = tools.map((item) => toolNameOf(item));
    const sorted = tools
      .map((item, index) => ({ item, index, name: before[index] ?? "" }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index))
      .map((wrapped) => wrapped.item);
    const after = sorted.map((item) => toolNameOf(item));
    if (after.some((name, index) => name !== before[index])) {
      normalized.tools = sorted;
      toolsSorted = true;
    }
  }
  return { value: normalized, toolsSorted };
}

/**
 * 对单个字符串做时间锚定。
 * 做法：先把三个槽位的匹配全部收集出来，再去掉被更靠前槽位"占住"的重叠区间
 * （例如 ISO 串同时会被日期时间槽匹配），最后按位置重建字符串。
 * 槽位锚点：该槽位在本会话第一次见到的原串；之后一律替换成锚点值。
 */
function replaceTimesInText(text: string, anchors: Map<string, string>): { text: string; count: number } {
  const edits: { start: number; end: number; slot: number; original: string }[] = [];
  const taken: { start: number; end: number }[] = [];

  for (let slot = 0; slot < TIME_SLOTS.length; slot += 1) {
    const source = TIME_SLOTS[slot];
    if (!source) continue;
    const flags = source.flags.includes("g") ? source.flags : `${source.flags}g`;
    const pattern = new RegExp(source.source, flags);
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      const original = match[0];
      const start = match.index;
      const end = start + original.length;
      if (original.length === 0) {
        pattern.lastIndex += 1;
        match = pattern.exec(text);
        continue;
      }
      const overlapped = taken.some((span) => start < span.end && end > span.start);
      if (!overlapped) {
        taken.push({ start, end });
        edits.push({ start, end, slot, original });
      }
      match = pattern.exec(text);
    }
  }

  if (edits.length === 0) return { text, count: 0 };
  edits.sort((a, b) => a.start - b.start);

  let count = 0;
  let cursor = 0;
  let out = "";
  for (const edit of edits) {
    const key = String(edit.slot);
    const anchor = anchors.get(key);
    out += text.slice(cursor, edit.start);
    if (anchor === undefined) {
      anchors.set(key, edit.original);
      out += edit.original;
    } else if (anchor === edit.original) {
      out += edit.original;
    } else {
      out += anchor;
      count += 1;
    }
    cursor = edit.end;
  }
  out += text.slice(cursor);
  return { text: out, count };
}

/**
 * 时间字面量锚定（实验能力，默认不开）。
 * 只动 messages[*].content 与 system 里的字符串，跳过 tools 子树
 * （避免破坏 JSON schema 里的日期格式定义）。
 */
export function anchorTimes(parsed: unknown, anchors: Map<string, string>): { value: unknown; count: number } {
  if (!isPlainObject(parsed)) return { value: parsed, count: 0 };
  let count = 0;
  const applyText = (text: string): string => {
    const result = replaceTimesInText(text, anchors);
    count += result.count;
    return result.text;
  };
  const applyBlocks = (blocks: unknown[]): void => {
    for (const block of blocks) {
      if (!isPlainObject(block)) continue;
      if (typeof block.text === "string") block.text = applyText(block.text);
    }
  };

  if (typeof parsed.system === "string") {
    parsed.system = applyText(parsed.system);
  } else if (Array.isArray(parsed.system)) {
    applyBlocks(parsed.system);
  }

  const messages = parsed.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isPlainObject(message)) continue;
      if (typeof message.content === "string") {
        message.content = applyText(message.content);
      } else if (Array.isArray(message.content)) {
        applyBlocks(message.content);
      }
    }
  }
  return { value: parsed, count };
}

/** 由请求体形状猜 wire 方言（改写引擎拿不到 header，只能看结构） */
function inferVendor(parsed: unknown): Vendor {
  if (!isPlainObject(parsed)) return "unknown";
  if ("system" in parsed) return "anthropic";
  if (Array.isArray(parsed.messages) || Array.isArray(parsed.tools)) return "openai";
  return "unknown";
}

/** 段切分：system → tools → 每条非 system 消息各一段 */
export function segmentPrefix(parsed: unknown, vendor: Vendor): Segment[] {
  const segments: Segment[] = [];

  if (vendor !== "unknown" && isPlainObject(parsed)) {
    if ("system" in parsed && parsed.system !== undefined && parsed.system !== null) {
      segments.push({ kind: "system", hash: hashOf(parsed.system) });
    }
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      segments.push({ kind: "tools", hash: hashOf(parsed.tools) });
    }
  }

  if (isPlainObject(parsed) && Array.isArray(parsed.messages)) {
    parsed.messages.forEach((message, index) => {
      const role = isPlainObject(message) && typeof message.role === "string" ? message.role : "unknown";
      if (role === "system") return;
      segments.push({ kind: `msg:${index}:${role}`, hash: hashOf(message) });
    });
  }

  return segments;
}

/** 前缀断点比较：appended 是健康态，modified 才是命中率杀手，shrunk 说明被压缩过 */
export function compareSegments(prev: string[], next: string[]): { kind: DivergenceKind; index: number | null; shrunkBy: number } {
  if (prev.length === 0) return { kind: "first", index: null, shrunkBy: 0 };

  const limit = Math.min(prev.length, next.length);
  let diff = 0;
  while (diff < limit && prev[diff] === next[diff]) diff += 1;

  if (diff === prev.length && next.length === prev.length) return { kind: "none", index: null, shrunkBy: 0 };
  if (diff === prev.length && next.length > prev.length) return { kind: "appended", index: null, shrunkBy: 0 };
  if (diff === next.length && next.length < prev.length) {
    return { kind: "shrunk", index: null, shrunkBy: prev.length - next.length };
  }
  return { kind: "modified", index: diff, shrunkBy: 0 };
}

/** 取首条 user 消息的文本（用于生成会话 key） */
function firstUserText(parsed: unknown): string {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.messages)) return "";
  for (const message of parsed.messages) {
    if (!isPlainObject(message)) continue;
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content
        .map((block) => (isPlainObject(block) && typeof block.text === "string" ? block.text : ""))
        .filter((text) => text !== "");
      if (parts.length > 0) return parts.join("\n");
    }
    return "";
  }
  return "";
}

/** 会话 key：host + 首个 user 消息内容的 sha1 前 8 位；找不到 user 消息则为 host|noguest */
export function sessionKeyFor(host: string, parsed: unknown): string {
  const text = firstUserText(parsed);
  if (!text) return `${host}|noguest`;
  const digest = createHash("sha1").update(text, "utf-8").digest("hex").slice(0, 8);
  return `${host}|${digest}`;
}

export interface RewriteResult {
  /** 实际发往上游的 body；未改写时必须返回入参 body 的同一个引用 */
  body: Buffer;
  report: PrefixDiag;
}

/** 未改写时的占位诊断 */
function placeholderReport(mode: RewriteMode, reason: string): PrefixDiag {
  return {
    mode,
    segmentCount: 0,
    divergenceKind: "first",
    firstDivergenceIndex: null,
    shrunkBy: 0,
    stabilizedTools: false,
    stabilizedKeys: false,
    anchoredTimes: 0,
    changed: false,
    reason,
  };
}

/**
 * 主入口：按 mode 决定是否改写，并始终产出前缀诊断。
 * 未改写时返回的 body 与入参是同一个 Buffer 引用（调用方可据此判断是否发生改写）。
 */
export function rewriteRequestBody(params: {
  host: string;
  body: Buffer;
  parsed: unknown | undefined;
  mode: RewriteMode;
  state: RewriteState;
}): RewriteResult {
  const { host, body, parsed, mode, state } = params;

  if (parsed === undefined) {
    return { body, report: placeholderReport(mode, "非 JSON 请求体") };
  }

  const vendor = inferVendor(parsed);
  const key = sessionKeyFor(host, parsed);
  const prev = state.get(key);

  let work: unknown = parsed;
  let stabilizedTools = false;
  let stabilizedKeys = false;
  let anchoredTimes = 0;

  if (mode === "stabilize" || mode === "anchor") {
    const normalized = normalizeStructure(work);
    work = normalized.value;
    stabilizedTools = normalized.toolsSorted;
    stabilizedKeys = true;
  }

  if (mode === "anchor") {
    const anchored = anchorTimes(work, prev.anchors);
    work = anchored.value;
    anchoredTimes = anchored.count;
  }

  const segments = segmentPrefix(work, vendor);
  const compared = compareSegments(prev.segments, segments.map((segment) => segment.hash));

  prev.segments = segments.map((segment) => segment.hash);
  prev.segmentKinds = segments.map((segment) => segment.kind);
  prev.lastSeen = Date.now();

  let outBody = body;
  let changed = false;
  let reason: string | undefined;

  if (mode === "stabilize" || mode === "anchor") {
    try {
      const serialized = Buffer.from(JSON.stringify(work), "utf-8");
      outBody = serialized;
      changed = !serialized.equals(body);
    } catch {
      outBody = body;
      changed = false;
      reason = "重新序列化失败，已回退";
    }
  }

  const report: PrefixDiag = {
    mode,
    segmentCount: segments.length,
    divergenceKind: compared.kind,
    firstDivergenceIndex: compared.index,
    shrunkBy: compared.shrunkBy,
    stabilizedTools,
    stabilizedKeys,
    anchoredTimes,
    changed,
    ...(reason === undefined ? {} : { reason }),
  };

  return { body: outBody, report };
}

/**
 * server.ts —— 本地代理服务核心（皮①）
 *
 * 职责：坐在客户端与厂商 API 之间，按路径前缀路由、原样透传请求与响应（含 SSE），
 * 旁路读取 usage 做计量，并顺手生成交接单与体检卡。
 *
 * 三条生死线：
 *  1. 只监听回环地址（默认 127.0.0.1:27880），不对局域网开放；
 *  2. 绝不阻断用户请求：转发异常/证书错误/超时一律降级为直连上游；
 *  3. 不 MITM：不解密 TLS，不做证书替换，只做"客户端 → 本机 HTTP → 上游 HTTPS"。
 *
 * 只使用 Node 内置模块，不引入任何第三方依赖。
 */

import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import zlib from "node:zlib";

import { buildHealthCard, renderHealthCard } from "./card.js";
import { buildHandoff, saveHandoff } from "./handoff.js";
import { injectStreamUsage, shouldRetryWithoutInjection } from "./inject.js";
import type { InjectUsageResult } from "./inject.js";
import { RewriteState, rewriteRequestBody } from "./rewrite.js";
import { extractUsage, extractUsageFromSse } from "./usage.js";
import type {
  HandoffRecord,
  HealthCard,
  PrefixDiag,
  ProxyOptions,
  RewriteMode,
  RouteConfig,
  UsageInjectNote,
  UsageSample,
  Vendor,
} from "./types.js";

/** 默认端口：刻意避开 bili 生态占用的 8787 / 18787 */
export const DEFAULT_PORT = 27880;
/** 只监听回环 */
export const DEFAULT_HOST = "127.0.0.1";
/** 上下文阈值（token）：超过即提示该做交接 */
export const DEFAULT_CONTEXT_THRESHOLD_TOKENS = 3000;
/** 上游超时：超时后降级直连 */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
/** 端口被占时最多顺延几个号 */
const PORT_DRIFT_LIMIT = 10;
/** 请求体上限（防止误把大文件塞进代理） */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** 响应旁路缓存的字节上限（usage 帧通常在尾部，保留尾部即可） */
const MAX_TEE_BYTES = 512 * 1024;
/** 4xx 探测时最多扣住多少响应体（用于判断要不要去掉注入字段重试；超限即放弃重试） */
const MAX_HOLD_BYTES = 64 * 1024;

/** 内置路由表：前缀 → 上游基址 */
export function builtinRoutes(): RouteConfig[] {
  return [
    { prefix: "/deepseek", baseUrl: "https://api.deepseek.com", vendor: "openai", label: "DeepSeek" },
    { prefix: "/openai", baseUrl: "https://api.openai.com", vendor: "openai", label: "OpenAI" },
    { prefix: "/anthropic", baseUrl: "https://api.anthropic.com", vendor: "anthropic", label: "Anthropic" },
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function asVendor(value: unknown): Vendor {
  return value === "openai" || value === "anthropic" ? value : "unknown";
}

/**
 * 解析 DOBOSTITCH_ROUTES 环境变量（JSON）：
 * 支持两种写法，都与内置路由表做"同前缀覆盖、新前缀追加"：
 *   1) [{ "prefix": "/glm", "baseUrl": "https://open.bigmodel.cn", "vendor": "openai", "label": "GLM" }]
 *   2) { "/glm": "https://open.bigmodel.cn", "/kimi": { "baseUrl": "https://api.moonshot.cn", "vendor": "openai" } }
 */
export function parseRoutesEnv(raw: string | undefined): RouteConfig[] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    console.error("[dobostitch] DOBOSTITCH_ROUTES 不是合法 JSON，已忽略该环境变量。");
    return [];
  }

  const result: RouteConfig[] = [];
  const push = (prefix: string, baseUrl: string, vendor: Vendor, label: string) => {
    if (!/^https?:\/\//i.test(baseUrl)) {
      console.error(`[dobostitch] DOBOSTITCH_ROUTES 中的 ${prefix} 基址不是 http(s) 地址，已跳过：${baseUrl}`);
      return;
    }
    result.push({ prefix: normalizePrefix(prefix), baseUrl: baseUrl.replace(/\/+$/, ""), vendor, label });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!isObject(item)) continue;
      const prefix = typeof item.prefix === "string" ? item.prefix : "";
      const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl : "";
      if (!prefix || !baseUrl) continue;
      const label = typeof item.label === "string" && item.label ? item.label : normalizePrefix(prefix).slice(1);
      push(prefix, baseUrl, asVendor(item.vendor), label);
    }
    return result;
  }

  if (isObject(parsed)) {
    for (const [prefix, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        push(prefix, value, "unknown", normalizePrefix(prefix).slice(1));
      } else if (isObject(value) && typeof value.baseUrl === "string") {
        const label = typeof value.label === "string" && value.label ? value.label : normalizePrefix(prefix).slice(1);
        push(prefix, value.baseUrl, asVendor(value.vendor), label);
      }
    }
  }
  return result;
}

/** 合并路由表：显式传入 > 环境变量 > 内置 */
export function resolveRoutes(explicit?: RouteConfig[]): RouteConfig[] {
  const merged = new Map<string, RouteConfig>();
  for (const route of builtinRoutes()) merged.set(normalizePrefix(route.prefix), route);
  for (const route of parseRoutesEnv(process.env.DOBOSTITCH_ROUTES)) {
    merged.set(normalizePrefix(route.prefix), route);
  }
  for (const route of explicit ?? []) {
    merged.set(normalizePrefix(route.prefix), { ...route, prefix: normalizePrefix(route.prefix) });
  }
  // 长前缀优先，避免 "/openai" 抢走 "/openai-cn" 的请求
  return [...merged.values()].sort((a, b) => b.prefix.length - a.prefix.length);
}

/** 最长前缀匹配；未命中返回 null */
export function matchRoute(pathname: string, routes: RouteConfig[]): { route: RouteConfig; rest: string } | null {
  for (const route of routes) {
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) {
      const rest = pathname.slice(route.prefix.length);
      return { route, rest: rest === "" ? "/" : rest };
    }
  }
  return null;
}

/** 把"剥离前缀后的路径"拼回上游基址（保留基址自带的路径部分） */
function buildTarget(baseUrl: string, rest: string, search: string): URL {
  const target = new URL(baseUrl);
  const basePath = target.pathname.replace(/\/+$/, "");
  const restPath = rest.startsWith("/") ? rest : `/${rest}`;
  target.pathname = `${basePath}${restPath}` || "/";
  target.search = search;
  return target;
}

/** 逐跳头（RFC 7230 §6.1）不能跨代理转发 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * zstd 支持探测。
 * Node 22.15+/23.8+ 起内置 zstd（zstdDecompress / createZstdDecompress），
 * 更早的运行时（如 22.12 LTS）没有，需要走"剥掉 zstd 协商"的降级路径。
 */
const ZSTD_DECODER_FACTORY = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
  .createZstdDecompress;
const ZSTD_SYNC_DECODER = (zlib as unknown as { zstdDecompressSync?: (body: Buffer) => Buffer }).zstdDecompressSync;
const ZSTD_SUPPORTED = typeof ZSTD_DECODER_FACTORY === "function";

let zstdStripWarned = false;

/**
 * 运行时不支持 zstd 时，把客户端 Accept-Encoding 里的 zstd 去掉再转发。
 * 真实客户端（Claude Code 2.1.199，X-Stainless 运行时 node v26）默认发
 * "gzip, deflate, br, zstd"，上游据此回 Content-Encoding: zstd，
 * 而旧运行时解不了 → 旁路采样整段失效。剥掉协商项只影响压缩算法选择，
 * 不改请求语义，客户端仍能用 br/gzip 正常解压。
 */
function stripZstdFromAcceptEncoding(value: string | string[]): string | string[] {
  const strip = (single: string): string => {
    const kept = single
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "" && part.split(";")[0]?.trim().toLowerCase() !== "zstd");
    return kept.length > 0 ? kept.join(", ") : "identity";
  };
  const out = Array.isArray(value) ? value.map(strip) : strip(value);
  if (!zstdStripWarned) {
    zstdStripWarned = true;
    console.warn("[dobostitch] 当前 Node 运行时不支持 zstd，已在转发时移除 Accept-Encoding 中的 zstd 协商项");
  }
  return out;
}

/** 构造发往上游的请求头：去掉逐跳头与本地鉴权头，重算 content-length */
function upstreamHeaders(raw: http.IncomingHttpHeaders, body: Buffer): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "content-length") continue;
    if (lower === "x-dobostitch-token") continue; // 本地 token 不外泄
    if (lower === "accept-encoding" && !ZSTD_SUPPORTED) {
      headers[key] = stripZstdFromAcceptEncoding(value);
      continue;
    }
    headers[key] = value;
  }
  headers["content-length"] = body.length;
  return headers;
}

/** 构造回给客户端的响应头：去掉逐跳头 */
function downstreamHeaders(raw: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  return headers;
}

/** 只保留尾部若干字节的旁路缓冲（usage 帧在流尾） */
class ByteTail {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly limit = MAX_TEE_BYTES) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped) this.size -= dropped.length;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }
}

/**
 * 按 content-encoding 造解压流。
 * 真实客户端（如 DSH）会发 Accept-Encoding: gzip, deflate, br，上游随即用 brotli 压缩 SSE，
 * 若不解压就直接当文本解析，usage 永远抠不出来（命中率显示"未判定"）。
 * 返回 null 表示无需解压（identity / 空）；返回 undefined 表示编码不认识（放弃旁路解析）。
 */
function createContentDecoder(encoding: string): NodeJS.ReadWriteStream | null | undefined {
  const first = (encoding.split(",")[0] ?? "").trim().toLowerCase();
  if (first === "" || first === "identity") return null;
  if (first === "br") return zlib.createBrotliDecompress();
  if (first === "gzip" || first === "x-gzip") return zlib.createGunzip();
  // createUnzip 能自动区分 zlib 包装的 deflate 与 gzip
  if (first === "deflate") return zlib.createUnzip();
  // zstd：Node 22.15+ 才有流式解压；老运行时会拿到 undefined，走"未判定"降级
  if (first === "zstd") return typeof ZSTD_DECODER_FACTORY === "function" ? ZSTD_DECODER_FACTORY() : undefined;
  return undefined;
}

/** 同步解压一小段响应体（4xx 扣住的错误体用，解压失败返回 null） */
function decodeBufferSync(body: Buffer, encoding: string): Buffer | null {
  const first = (encoding.split(",")[0] ?? "").trim().toLowerCase();
  if (first === "" || first === "identity") return body;
  try {
    if (first === "br") return zlib.brotliDecompressSync(body);
    if (first === "gzip" || first === "x-gzip") return zlib.gunzipSync(body);
    if (first === "deflate") return zlib.unzipSync(body);
    if (first === "zstd") return typeof ZSTD_SYNC_DECODER === "function" ? ZSTD_SYNC_DECODER(body) : null;
  } catch {
    return null;
  }
  return null;
}

/** 收集请求体 */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("请求体超过代理上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface ForwardParams {
  target: URL;
  method: string;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
  res: http.ServerResponse;
  vendorHint: Vendor;
  timeoutMs: number;
  /** 是否开启 response 旁路解析（降级直连时关闭） */
  teeEnabled: boolean;
  /**
   * 4xx 探测：为 true 时，上游回 4xx 先别写回客户端，
   * 先把状态/头/响应体扣在内存里，交上层判断"要不要去掉注入字段重试一次"。
   */
  holdOnClientError?: boolean;
}

/** 被扣住的 4xx 响应（此时客户端一个字节都还没收到） */
export interface HeldResponse {
  statusCode: number;
  headers: http.OutgoingHttpHeaders;
  body: Buffer;
}

interface ForwardOutcome {
  statusCode: number;
  usage: UsageSample | null;
  bytes: number;
  /** 非空表示响应尚未写回客户端，调用方必须 flush 或丢弃重试 */
  held?: HeldResponse | null;
}

/** 把扣住的响应原样吐给客户端（用于"决定不重试"或"重试也失败"两条路径） */
function flushHeldResponse(res: http.ServerResponse, held: HeldResponse): void {
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) res.writeHead(held.statusCode, held.headers);
  res.end(held.body);
}

/** 扣住的响应体转文本；压缩体先解压，解压失败才判为"看不出原因"（此时不会重试） */
function heldTextOf(held: HeldResponse): string {
  const encoding = String(held.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoded = decodeBufferSync(held.body, encoding);
  if (decoded === null) return "";
  return decoded.toString("utf-8");
}

/**
 * 执行一次转发并逐块透传响应。
 * 只有"尚未向客户端写出任何字节"时的失败才可以被上层降级重试，
 * 因此所有上游连接错误都在 resolve 之前 reject。
 */
function attemptForward(params: ForwardParams): Promise<ForwardOutcome> {
  return new Promise((resolve, reject) => {
    const transport = params.target.protocol === "https:" ? https : http;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const upstreamReq = transport.request(
      params.target,
      { method: params.method, headers: params.headers },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;
        const headers = downstreamHeaders(upstreamRes.headers);

        const contentType = String(upstreamRes.headers["content-type"] ?? "").toLowerCase();
        const encoding = String(upstreamRes.headers["content-encoding"] ?? "").trim().toLowerCase();
        const isSse = contentType.includes("text/event-stream");
        const tee = new ByteTail();
        let bytes = 0;

        // 旁路解析：压缩响应先边收边解压，再把解压后的字节喂给尾部缓冲
        const decoder = params.teeEnabled ? createContentDecoder(encoding) : undefined;
        const decodable = params.teeEnabled && decoder !== undefined;
        if (decoder) {
          decoder.on("data", (chunk: Buffer) => tee.push(Buffer.from(chunk)));
          // 解压出错只影响旁路计数，绝不能污染主链路
          decoder.on("error", () => {
            /* 忽略：usage 抠不到就按"未判定"记账 */
          });
        }

        // 4xx 探测模式：先扣住，不写头也不写体
        let heldChunks: Buffer[] | null =
          params.holdOnClientError === true && statusCode >= 400 && statusCode < 500 ? [] : null;
        let heldSize = 0;
        if (!heldChunks) params.res.writeHead(statusCode, headers);

        const releaseHeld = (): void => {
          if (!heldChunks) return;
          const pending = heldChunks;
          heldChunks = null;
          params.res.writeHead(statusCode, headers);
          for (const chunk of pending) params.res.write(chunk);
        };

        upstreamRes.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (decodable) {
            if (decoder) {
              try {
                decoder.write(chunk);
              } catch {
                /* 解压链路异常：旁路放弃，主链路继续 */
              }
            } else {
              tee.push(chunk);
            }
          }
          if (heldChunks) {
            heldChunks.push(chunk);
            heldSize += chunk.length;
            // 扣住的体超过上限（4xx 正常没这么大）：放弃重试，原样吐出去后改回纯透传
            if (heldSize > MAX_HOLD_BYTES) releaseHeld();
            return;
          }
          params.res.write(chunk);
        });

        upstreamRes.on("end", () => {
          if (!settled) settled = true;
          const held: HeldResponse | null = heldChunks ? { statusCode, headers, body: Buffer.concat(heldChunks) } : null;
          heldChunks = null;
          if (!held) params.res.end();

          // 解压流是异步的，必须等它冲完（'end'）再解析，否则拿到的是半截文本
          const finish = (): void => {
            let usage: UsageSample | null = null;
            if (!held && decodable) {
              const text = tee.text();
              if (isSse) {
                usage = extractUsageFromSse(text, params.vendorHint);
              } else if (text.trim() !== "") {
                try {
                  usage = extractUsage(JSON.parse(text) as unknown, params.vendorHint);
                } catch {
                  usage = null;
                }
              }
            }
            resolve({ statusCode, usage, bytes, held });
          };

          if (decoder) {
            decoder.once("end", finish);
            try {
              decoder.end();
            } catch {
              finish();
            }
          } else {
            finish();
          }
        });

        upstreamRes.on("error", (err) => {
          // 响应已开始，无法降级，只能收尾
          if (heldChunks) {
            // 扣住期间出错：把已扣住的内容吐出去，避免客户端空等
            releaseHeld();
          }
          params.res.destroy();
          fail(err);
        });
      },
    );

    upstreamReq.setTimeout(params.timeoutMs, () => {
      upstreamReq.destroy(new Error(`上游响应超时（${params.timeoutMs}ms）`));
    });
    upstreamReq.on("error", fail);

    // 客户端提前断开时，同步掐掉上游连接，避免悬挂
    params.res.on("close", () => {
      if (!params.res.writableEnded) upstreamReq.destroy();
    });

    if (params.body.length > 0) upstreamReq.write(params.body);
    upstreamReq.end();
  });
}

/** 单进程上下文 */
interface ProxyContext {
  routes: RouteConfig[];
  options: ProxyOptions;
  counter: { n: number };
  threshold: number;
  timeoutMs: number;
  authToken?: string;
  requireToken: boolean;
  handoffDir?: string;
  onCard: (card: string) => void;
  /** 请求改写引擎的会话状态表 */
  rewriteState: RewriteState;
  /** 当前改写档位 */
  rewriteMode: RewriteMode;
  /** 是否给 OpenAI 方言的流式请求自动补 stream_options.include_usage */
  injectUsage: boolean;
}

/** 请求结束后的记账：usage → 交接单 → 体检卡 */
function afterRequest(
  ctx: ProxyContext,
  params: {
    index: number;
    route: RouteConfig;
    target: URL;
    requestBody: unknown;
    outcome: ForwardOutcome | null;
    prefixDiag?: PrefixDiag | null;
    usageInject?: UsageInjectNote | null;
  },
): void {
  const usage: UsageSample =
    params.outcome?.usage ?? { inputTokens: 0, cachedTokens: 0, hitRatio: null, vendor: params.route.vendor, judged: false };

  let handoffSaved = false;
  let record: HandoffRecord | null = null;
  try {
    record = buildHandoff({
      upstream: params.target.host,
      requestBody: params.requestBody,
      inputTokens: usage.inputTokens,
      path: params.target.pathname,
    });
    saveHandoff(record, ctx.handoffDir);
    handoffSaved = true;
  } catch (err) {
    // 落盘失败不影响代理主链路
    console.error(`[dobostitch] 交接单落盘失败：${(err as Error)?.message ?? err}`);
  }

  const card: HealthCard = buildHealthCard({
    requestIndex: params.index,
    routePrefix: params.route.prefix,
    upstreamLabel: params.route.label,
    upstreamHost: params.target.host,
    usage,
    handoffSaved,
    contextThresholdTokens: ctx.threshold,
    prefix: params.prefixDiag ?? null,
    usageInject: params.usageInject ?? null,
  });
  ctx.onCard(renderHealthCard(card));
}

/** 处理单个 HTTP 请求 */
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ProxyContext): Promise<void> {
  const index = ctx.counter.n + 1;
  ctx.counter.n = index;

  let requestUrl: URL;
  try {
    requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${ctx.options.port ?? DEFAULT_PORT}`}`);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("dobostitch: 无法解析请求路径\n");
    return;
  }

  const pathname = requestUrl.pathname;

  // 本机自检端点（不转发）
  if (pathname === "/__dobostitch/health") {
    const payload = {
      ok: true,
      requests: ctx.counter.n,
      rewriteMode: ctx.rewriteMode,
      injectUsage: ctx.injectUsage,
      routes: ctx.routes.map((route) => ({ prefix: route.prefix, baseUrl: route.baseUrl, vendor: route.vendor, label: route.label })),
    };
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  // MITM 明确不支持：CONNECT 直接拒绝并给出人话
  if (req.method === "CONNECT") {
    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("dobostitch 不做 TLS 中间人，请改用 URL 前缀方式配置 baseURL。\n");
    return;
  }

  // 鉴权：仅在配置了 token 时校验；requireToken 未开时允许"不带 token"（客户端只需改 baseURL）
  if (ctx.authToken) {
    const provided = req.headers["x-dobostitch-token"];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!token && ctx.requireToken) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("dobostitch: 缺少 X-Dobostitch-Token\n");
      return;
    }
    if (token && token !== ctx.authToken) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("dobostitch: token 不匹配\n");
      return;
    }
  }

  const matched = matchRoute(pathname, ctx.routes);
  if (!matched) {
    const table = ctx.routes.map((route) => `  ${route.prefix}  ->  ${route.baseUrl}`).join("\n");
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dobostitch: 未匹配到路由 ${pathname}\n可用前缀：\n${table}\n`);
    return;
  }

  const target = buildTarget(matched.route.baseUrl, matched.rest, requestUrl.search);

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
    res.end(`dobostitch: 请求体读取失败（${(err as Error)?.message ?? err}）\n`);
    return;
  }

  // 只在明确是 JSON 时才解析，避免把二进制/大文件塞进 JSON.parse
  let requestBody: unknown;
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("json") && body.length > 0) {
    try {
      requestBody = JSON.parse(body.toString("utf-8")) as unknown;
    } catch {
      requestBody = undefined;
    }
  }

  // 请求改写：稳定前缀 + 诊断断点。任何异常都退回原样转发，绝不阻断用户请求。
  let forwardBody = body;
  let prefixDiag: PrefixDiag | null = null;
  try {
    const rw = rewriteRequestBody({
      host: target.host,
      body,
      parsed: requestBody,
      mode: ctx.rewriteMode,
      state: ctx.rewriteState,
    });
    forwardBody = rw.body;
    prefixDiag = rw.report;
    if (forwardBody !== body && contentType.includes("json") && forwardBody.length > 0) {
      try {
        requestBody = JSON.parse(forwardBody.toString("utf-8")) as unknown;
      } catch {
        /* 保留原解析结果 */
      }
    }
  } catch (err) {
    console.error(`[dobostitch] 改写引擎异常，已按原样转发：${(err as Error)?.message ?? err}`);
  }

  // 流式 usage 注入：OpenAI 方言 + stream=true 且没写 stream_options.include_usage 时补上。
  // 任何异常都退回原样转发，绝不阻断用户请求。
  let injection: InjectUsageResult = {
    body: forwardBody,
    parsed: requestBody,
    status: "not-applicable",
    injected: false,
    previous: null,
    reason: "未执行",
  };
  try {
    injection = injectStreamUsage({
      body: forwardBody,
      parsed: requestBody,
      vendor: matched.route.vendor,
      enabled: ctx.injectUsage,
    });
    if (injection.injected) {
      forwardBody = injection.body;
      requestBody = injection.parsed;
    }
  } catch (err) {
    console.error(`[dobostitch] 流式 usage 注入异常，已按未注入转发：${(err as Error)?.message ?? err}`);
  }
  let injectNote: UsageInjectNote = {
    status: injection.status,
    retried: false,
    ...(injection.reason === undefined ? {} : { reason: injection.reason }),
  };

  const commonParams = {
    target,
    method: req.method ?? "POST",
    headers: upstreamHeaders(req.headers, forwardBody),
    body: forwardBody,
    res,
    vendorHint: matched.route.vendor,
    timeoutMs: ctx.timeoutMs,
  };

  try {
    let outcome = await attemptForward({ ...commonParams, teeEnabled: true, holdOnClientError: injection.injected });

    // 上游 4xx 且明确说"不认识这个字段"→ 去掉注入字段重试一次（仅一次，不递归）
    if (
      outcome.held &&
      shouldRetryWithoutInjection({
        statusCode: outcome.held.statusCode,
        responseText: heldTextOf(outcome.held),
        injected: injection.injected,
      })
    ) {
      const held = outcome.held;
      const retryBody = injection.previous?.body ?? body;
      const retryParsed = injection.previous?.parsed ?? requestBody;
      console.error(
        `[dobostitch] 上游不认 stream_options（HTTP ${held.statusCode}），已去掉该字段重试一次：${heldTextOf(held).slice(0, 200)}`,
      );
      try {
        outcome = await attemptForward({
          target,
          method: commonParams.method,
          headers: upstreamHeaders(req.headers, retryBody),
          body: retryBody,
          res,
          vendorHint: matched.route.vendor,
          timeoutMs: ctx.timeoutMs,
          teeEnabled: true,
          holdOnClientError: false,
        });
        injectNote = { ...injectNote, retried: true };
        forwardBody = retryBody;
        requestBody = retryParsed;
      } catch (retryError) {
        // 重试也没成：把第一次那份 4xx 原样还给客户端，用户看到的是上游真实回答
        console.error(`[dobostitch] 去掉注入字段重试失败：${(retryError as Error)?.message ?? retryError}`);
        flushHeldResponse(res, held);
        outcome = { statusCode: held.statusCode, usage: null, bytes: held.body.length, held: null };
      }
    }

    // 决定不重试：把扣住的 4xx 原样吐回客户端
    if (outcome.held) {
      flushHeldResponse(res, outcome.held);
      outcome = { ...outcome, held: null };
    }

    afterRequest(ctx, { index, route: matched.route, target, requestBody, outcome, prefixDiag, usageInject: injectNote });
  } catch (primaryError) {
    if (res.headersSent) {
      // 已经开始回字节，不能再重来；只能断开，由客户端自行重试
      res.destroy();
      console.error(`[dobostitch] 响应中途失败：${(primaryError as Error)?.message ?? primaryError}`);
      return;
    }
    // 降级：直连上游，关掉旁路解析，保证用户请求不被阻断
    console.error(`[dobostitch] 代理转发失败，降级直连：${(primaryError as Error)?.message ?? primaryError}`);
    try {
      const fallback = await attemptForward({ ...commonParams, teeEnabled: false });
      afterRequest(ctx, {
        index,
        route: matched.route,
        target,
        requestBody,
        outcome: fallback,
        prefixDiag,
        usageInject: injectNote,
      });
    } catch (fallbackError) {
      const message = `dobostitch: 上游不可达（代理与直连均失败）\n${(fallbackError as Error)?.message ?? fallbackError}\n`;
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(message);
      } else {
        res.destroy();
      }
    }
  }
}

/** 在端口上监听；被占则顺延跳号（最多 10 次） */
function listenWithDrift(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = (candidate: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && attempt < PORT_DRIFT_LIMIT) {
          attempt += 1;
          tryListen(candidate + 1);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(candidate);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, host);
    };

    tryListen(port);
  });
}

/**
 * 启动代理。
 * 返回 { port, close }：port 可能与入参不同（端口被占时跳号）。
 */
export async function startProxy(options: ProxyOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const routes = resolveRoutes(options.routes);
  const host = options.host?.trim() || DEFAULT_HOST;
  const ctx: ProxyContext = {
    routes,
    options,
    counter: { n: 0 },
    threshold: options.contextThresholdTokens ?? DEFAULT_CONTEXT_THRESHOLD_TOKENS,
    timeoutMs: options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    authToken: options.authToken?.trim() || undefined,
    requireToken: options.requireToken ?? false,
    handoffDir: options.handoffDir,
    onCard: options.onCard ?? ((card: string) => console.log(card)),
    rewriteState: new RewriteState(),
    rewriteMode: options.rewriteMode ?? "stabilize",
    // 流式 usage 默认注入：不开这个开关，流式请求基本拿不到 usage，命中率永远"未判定"
    injectUsage: options.injectUsage ?? true,
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, ctx).catch((err: unknown) => {
      console.error(`[dobostitch] 未捕获的请求异常：${(err as Error)?.message ?? err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("dobostitch: 内部错误，已尝试不影响你的请求\n");
      } else {
        res.destroy();
      }
    });
  });

  // 长连接场景下避免默认 5s 超时掐断 SSE
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  const port = await listenWithDrift(server, options.port ?? DEFAULT_PORT, host);
  ctx.options.port = port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // 长连接（尤其 SSE）会拖住 server.close()，先断存量连接再关闭，保证 Ctrl+C 立刻退出
        const closable = server as http.Server & {
          closeAllConnections?: () => void;
          closeIdleConnections?: () => void;
        };
        closable.closeIdleConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
        closable.closeAllConnections?.();
      }),
  };
}

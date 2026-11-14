/**
 * v0.6.0（C-2）：代理端口探活。
 *
 * 背景：`cf_ping` 原来只返回一行固定文本 `pong: dobocache ready`，它只证明
 * **MCP 进程活着**，完全不证明**代理端口活着**。于是出现过这样的场面：
 * 客户端 `/mcp` 显示 connected、cf_ping 也返回 pong，但代理早就没在监听，
 * 请求根本没被改写，用户却以为「插件在工作」——数据一路为零，也没有任何可读原因。
 *
 * 本模块只做一件事：请求本机回环上的 `/__dobostitch/health`，把
 * 「连不上 / 连上了但不是本代理 / 正常」翻译成结构化状态 + 一句人话 + 一句自愈提示。
 *
 * 边界：
 *   - 只探 127.0.0.1 回环，不发起任何外网请求，不携带 token、不读用户内容；
 *   - 探测超时默认 800ms（cf_ping 必须"立刻返回"，不能因为代理不在就卡住）；
 *   - 探测失败绝不抛异常，一律转成 status 返回，让调用方永远能拿到可读结果。
 */
import http from "node:http";

/** 探测结果状态 */
export type ProxyProbeStatus =
  /** 端口有 HTTP 响应且确认为 dobostitch（健康端点 ok=true） */
  | "listening"
  /** 端口有 HTTP 响应，但不是本代理（被别的程序占用） */
  | "listening_other"
  /** 端口无人监听（代理没起） */
  | "refused"
  /** 端口有监听但没在超时内响应（可能卡死） */
  | "timeout"
  /** 其它网络错误（权限、DNS、非 http 协议等） */
  | "error"
  /** 用户显式关闭了探测 */
  | "skipped";

export interface ProxyProbeResult {
  status: ProxyProbeStatus;
  host: string;
  port: number;
  /** 探测的完整 URL，便于用户自己去浏览器验证 */
  url: string;
  /** 探测耗时（毫秒） */
  latencyMs: number;
  /** 有 HTTP 响应时的状态码 */
  httpStatus?: number;
  /** 代理自报的已转发请求数（健康端点 requests 字段） */
  requests?: number;
  /** 结构化原因（一句话，面向用户） */
  reason: string;
  /** 自愈提示（一句话，面向用户） */
  hint: string;
}

export interface ProxyProbeOptions {
  /** 代理端口；不传则读 DOBOSTITCH_PORT / DOBOCACHE_PROXY_PORT，再退回 27880 */
  port?: number;
  /** 监听地址，默认 127.0.0.1 */
  host?: string;
  /** 超时毫秒，默认 800 */
  timeoutMs?: number;
}

const DEFAULT_PROXY_PORT = 27880;
const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 800;
const HEALTH_PATH = "/__dobostitch/health";

/** 解析代理端口：显式入参 > 环境变量 > 默认 27880；非法值退回默认 */
export function resolveProxyPort(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return explicit;
  for (const name of ["DOBOSTITCH_PORT", "DOBOCACHE_PROXY_PORT"]) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value < 65536) return Math.floor(value);
  }
  return DEFAULT_PROXY_PORT;
}

/** 探测是否被显式关闭（DOBOCACHE_PING_SKIP_PROXY=1）；用于极简环境或不想多一次回环时 */
function probeDisabled(): boolean {
  const raw = process.env.DOBOCACHE_PING_SKIP_PROXY;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * 探测代理端口。永不抛异常：任何失败都转成结构化 status + 原因 + 提示。
 */
export async function probeProxyPort(options: ProxyProbeOptions = {}): Promise<ProxyProbeResult> {
  const host = options.host?.trim() || process.env.DOBOSTITCH_HOST?.trim() || DEFAULT_PROXY_HOST;
  const port = resolveProxyPort(options.port);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `http://${host}:${port}${HEALTH_PATH}`;
  const base = { host, port, url, latencyMs: 0 };

  if (probeDisabled()) {
    return {
      ...base,
      status: "skipped",
      reason: "代理探测已按 DOBOCACHE_PING_SKIP_PROXY 关闭，本次只确认 MCP 进程存活",
      hint: "如需确认代理是否在跑，去掉该环境变量后重跑 cf_ping，或直接访问 /__dobostitch/health",
    };
  }

  const startedAt = Date.now();
  try {
    const result = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = http.get(url, { timeout: timeoutMs, headers: { accept: "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") }));
        res.on("error", reject);
      });
      req.on("timeout", () => {
        const err = new Error("probe timeout") as NodeJS.ErrnoException;
        err.code = "ETIMEDOUT";
        req.destroy(err);
      });
      req.on("error", reject);
    });

    const latencyMs = Date.now() - startedAt;
    const body = result.body ?? "";
    // 健康端点返回 { ok: true, requests, rewriteMode, injectUsage, routes }
    const looksLikeProxy = result.status === 200 && /"ok"\s*:\s*true/.test(body);
    if (looksLikeProxy) {
      let requests: number | undefined;
      try {
        const parsed = JSON.parse(body) as { requests?: number };
        if (typeof parsed.requests === "number") requests = parsed.requests;
      } catch {
        // 健康端点返回体解析失败不影响"活着"的判定
      }
      return {
        ...base,
        latencyMs,
        httpStatus: result.status,
        requests,
        status: "listening",
        reason:
          requests === undefined
            ? `代理在 ${host}:${port} 正常监听`
            : `代理在 ${host}:${port} 正常监听（已转发 ${requests} 次请求）`,
        hint: "无需处理",
      };
    }

    return {
      ...base,
      latencyMs,
      httpStatus: result.status,
      status: "listening_other",
      reason: `${host}:${port} 有 HTTP 服务在应答，但不是 dobostitch（状态码 ${result.status ?? "unknown"}，健康端点无 ok:true）`,
      hint: `端口可能被别的程序占用：换个端口重跑代理（dobostitch start --port <端口>），或关掉占用 ${port} 的程序`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    if (code === "ECONNREFUSED") {
      return {
        ...base,
        latencyMs,
        status: "refused",
        reason: `${host}:${port} 无人监听——代理没在跑，请求不会被改写`,
        hint: "启动代理：dobostitch start（或 npm run start:proxy），启动后重跑 cf_ping 确认",
      };
    }
    if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ABORT_ERR") {
      return {
        ...base,
        latencyMs,
        status: "timeout",
        reason: `${host}:${port} 有监听但 ${timeoutMs}ms 内没响应（代理可能卡住或端口被半开连接占用）`,
        hint: "重启代理（Ctrl+C 后重新 start），仍无响应则换端口并检查防火墙/代理软件",
      };
    }
    return {
      ...base,
      latencyMs,
      status: "error",
      reason: `探测 ${host}:${port} 失败（${code}）`,
      hint: "确认端口号与监听地址是否正确（DOBOSTITCH_PORT / DOBOSTITCH_HOST），再重跑 cf_ping",
    };
  }
}

/** 把探测结果渲染成 cf_ping 的多行文本（第一行之外的部分，供工具直接返回） */
export function renderProxyProbe(result: ProxyProbeResult): string {
  const head = `proxy: ${result.status} (${result.host}:${result.port})`;
  const lines = [head, `  原因：${result.reason}`, `  下一步：${result.hint}`];
  if (result.httpStatus !== undefined) lines.push(`  HTTP 状态：${result.httpStatus}`);
  lines.push(`  自检地址：${result.url}`);
  return lines.join("\n");
}

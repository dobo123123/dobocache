#!/usr/bin/env node
/**
 * bundle.ts —— DoboCache MCP 一体化入口（v0.5.3「一装即自动」）
 *
 * 为什么存在：
 *   历史上代理和 MCP 是两条独立通道，用户得先手动起代理、再配 MCP，
 *   漏一步就"装了但没效果"。本入口把两件事合成一个动作：
 *   任何 MCP 客户端（Loomy / opencode / Claude Code / 自研底座）拉起本文件时，
 *   自动确认本地代理在跑（不在跑就低调拉起来），然后把控制权交给 MCP 本体。
 *
 * 行为契约：
 *   1) 代理已在跑且路由正确 → 直接复用（幂等，不抢端口、不重复起进程）
 *   2) 代理不在跑 → detached 后台拉起，日志单独落盘，最多等 8s 就绪
 *   3) 代理起不来 → 仍照常启动 MCP（cf_* 工具可用），只往 stderr 说明，绝不阻塞客户端
 *   4) stdout 全程只属于 MCP 协议，本文件所有日志一律走 stderr
 *
 * 环境变量：
 *   DOBOSTITCH_PORT        代理端口，默认 27880
 *   DOBOSTITCH_ROUTES      路由表 JSON（与 proxy/cli.js 同格式），默认按内置默认路由
 *   DOBOSTITCH_AUTOSTART   on|off（默认 on）；off 表示只做探测、不代拉起
 *   DOBOSTITCH_LOG_DIR     代理日志目录，默认 <cwd>/data/logs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkNodeVersion } from "./utils/runtime.js";
import { portCandidates, writeLastPort } from "./state.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.join(HERE, "proxy", "cli.js");
const MCP_ENTRY = path.join(HERE, "index.js");

/** 默认代理端口：与 proxy/server.ts 的 DEFAULT_PORT 保持一致 */
const DEFAULT_PROXY_PORT = 27880;
/** 等代理就绪的上限（毫秒） */
const READY_TIMEOUT_MS = 8000;
/** 轮询间隔（毫秒） */
const READY_POLL_MS = 250;

/** MCP 的 stdout 是协议通道，日志只能走 stderr */
function log(...args: unknown[]): void {
  try {
    console.error("[dobocache]", ...args);
  } catch {
    // stderr 不可写时静默，绝不能影响 MCP
  }
}

function autostartEnabled(): boolean {
  const raw = (process.env.DOBOSTITCH_AUTOSTART ?? "on").trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
}

interface ProxyHealth {
  ok?: boolean;
  requests?: number;
  routes?: { prefix?: string }[];
}

/** 探代理 health（用 http 而非 fetch：避免 undici 在短命进程退出时拖尾） */
async function probeHealth(port: number): Promise<ProxyHealth | null> {
  return await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/__dobostitch/health", method: "GET", timeout: 1500 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf) as ProxyHealth);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function resolveLogDir(): string {
  const fromEnv = process.env.DOBOSTITCH_LOG_DIR ?? process.env.DOBOCACHE_LOG_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // 绝不能默认写到调用方的 cwd：客户端启动 MCP 时 cwd 可能是只读目录（如 C:\Windows），
  // 落盘失败无所谓，但把日志塞进用户当前工作目录会很脏。统一收进 ~/.dobocache/logs。
  return path.join(os.homedir(), ".dobocache", "logs");
}

/**
 * 确保代理在跑；返回是否可用。
 * 注意：detached=true 让代理脱离 MCP 子进程的生死——客户端重启不会把代理带走，
 * 下次启动直接复用，避免"改个配置代理就掉线"的断流体验。
 */
async function ensureProxy(port: number): Promise<boolean> {
  const health = await probeHealth(port);
  if (health?.ok) {
    log(`代理已在 ${port} 运行（累计请求 ${health.requests ?? 0} 次），直接复用`);
    return true;
  }
  if (!autostartEnabled()) {
    log(`代理未运行，且 DOBOSTITCH_AUTOSTART=off，本次不代拉起（MCP 工具仍可用）`);
    return false;
  }
  if (!fs.existsSync(CLI_ENTRY)) {
    log(`找不到代理入口 ${CLI_ENTRY}，跳过自动拉起`);
    return false;
  }

  const logDir = resolveLogDir();
  let logFile = "";
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    logFile = path.join(logDir, `dobostitch-${port}-bundle-${stamp}.log`);
  } catch (err) {
    log(`日志目录不可写（${logDir}）：${(err as Error)?.message ?? err}；代理日志将关闭`);
  }

  // 代理的 stdout/stderr 一律绑到日志文件（不是 MCP 的 stdout），所以既不会污染
  // 协议流，也不会继承调用方管道。注意：stdio 只接受「已打开的 fd」或句柄，
  // 传未打开的 WriteStream 会被 Node 判为非法，所以这里用 openSync 拿 fd。
  let outFd: number | undefined;
  if (logFile) {
    try {
      outFd = fs.openSync(logFile, "a");
    } catch {
      logFile = "";
    }
  }

  const args = [CLI_ENTRY, "start", "--port", String(port), "--rewrite", "stabilize", "--inject-usage", "on"];
  // 双保险：--log 让代理自己写文件（不依赖句柄继承），stdio 再绑一次兜底。
  if (logFile) args.push("--log", logFile);

  try {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", outFd ?? "ignore", outFd ?? "ignore"],
      windowsHide: true,
      detached: true,
    });
    child.on("error", (err) => log(`代理进程启动异常：${err?.message ?? err}`));
    child.unref();
    log(`已拉起代理 PID=${child.pid ?? "?"} 端口=${port}${logFile ? ` 日志=${logFile}` : ""}`);
  } catch (err) {
    log(`拉起代理失败：${(err as Error)?.message ?? err}（MCP 工具仍可用）`);
    return false;
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
    const h = await probeHealth(port);
    if (h?.ok) {
      log(`代理就绪（约 ${READY_TIMEOUT_MS - (deadline - Date.now())} ms）`);
      return true;
    }
  }
  log(`代理 ${READY_TIMEOUT_MS}ms 内未就绪，先继续启动 MCP（首个请求可能失败，随后会自动恢复）`);
  return false;
}

/**
 * 挑一个能用的端口：先按候选顺序找「已经在跑的代理」并直接复用，
 * 都找不到才用第一候选新起一个。这样多底座共用同一个代理，缓存不会分裂。
 */
async function resolveLivePort(): Promise<number> {
  const candidates = portCandidates(process.env.DOBOSTITCH_PORT ?? process.env.DOBOSTITCH_DEFAULT_PORT);
  for (const candidate of candidates) {
    const health = await probeHealth(candidate);
    if (health?.ok) {
      log(`发现已在运行的代理：端口 ${candidate}（累计请求 ${health.requests ?? 0} 次），直接复用`);
      writeLastPort(candidate);
      return candidate;
    }
  }
  return candidates[0] ?? DEFAULT_PROXY_PORT;
}

async function main(): Promise<void> {
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.error(nodeCheck.message);
    process.exitCode = 1;
    return;
  }

  const port = await resolveLivePort();
  try {
    await ensureProxy(port);
    writeLastPort(port);
  } catch (err) {
    log(`代理环节异常，不影响 MCP：${(err as Error)?.message ?? err}`);
  }

  if (!fs.existsSync(MCP_ENTRY)) {
    log(`找不到 MCP 入口 ${MCP_ENTRY}`);
    process.exitCode = 1;
    return;
  }
  // 交给 MCP 本体；此后 stdout 归协议所有
  await import(pathToFileURL(MCP_ENTRY).href);
}

main().catch((err: unknown) => {
  log(`启动失败：${(err as Error)?.message ?? err}`);
  process.exitCode = 1;
});

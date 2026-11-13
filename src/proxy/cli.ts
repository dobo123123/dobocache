#!/usr/bin/env node
/**
 * cli.ts —— dobostitch 命令行入口
 *
 * 子命令：
 *   start    起代理，打印首屏体检卡与接入指引
 *   status   读 data/handoff，列出最近会话
 *   resume   打印指定会话（或最近会话）的续接摘要
 *   doctor   自检：Node 版本 / 端口占用 / 路由表 / 交接单目录可写性
 *
 * 说明：本文件只做命令行编排，业务能力都在 usage / handoff / card / server 四个模块里。
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { renderHealthCard } from "./card.js";
import { defaultHandoffDir, handoffDirNotice, handoffDirWarning, listHandoffs, loadHandoff, renderResumeBrief } from "./handoff.js";
import { DEFAULT_CONTEXT_THRESHOLD_TOKENS, DEFAULT_PORT, resolveRoutes, startProxy } from "./server.js";
import { checkNodeVersion } from "../utils/runtime.js";
import type { HealthCard, RewriteMode, RouteConfig } from "./types.js";

const USAGE = `dobostitch —— DoboCache 本地代理层

用法：
  dobostitch start [--port 27880] [--token <本机token>] [--require-token] [--rewrite <off|observe|stabilize|anchor>] [--inject-usage <on|off>]
  dobostitch status
  dobostitch resume [sessionKey]
  dobostitch doctor

改写档位（默认 stabilize）：
  off        不改请求体，只转发
  observe    只看不改，用来验证"原样直通时前缀到底稳不稳"
  stabilize  规范化 key 序 + 重排 tools，稳定前缀（零语义风险）
  anchor     stabilize + 时间字面量锚定（实验能力，等价 --anchor-time）

流式 usage 注入（默认 on）：
  openai 方言且 stream=true 的请求，自动补 stream_options.include_usage=true，
  让流末尾带回 usage——不补的话流式请求基本拿不到 usage，命中率只能写"未判定"。
  上游若因该字段回 4xx 且正文说"不认识这个字段"，自动去掉该字段重试一次。
  客户端自己写了 include_usage 的一律不改；off 用于复现"上游确实不认这个字段"的现场。

接入方式（改一次 baseURL 即可，无需装证书、无需重启换配置）：
  DeepSeek   http://127.0.0.1:27880/deepseek
  OpenAI     http://127.0.0.1:27880/openai
  Anthropic  http://127.0.0.1:27880/anthropic
`;

/** 改写档位默认值 */
const DEFAULT_REWRITE_MODE: RewriteMode = "stabilize";

/** 流式 usage 注入默认值：开 */
const DEFAULT_INJECT_USAGE = true;

/** 校验并解析 --inject-usage <on|off>（默认 on） */
function resolveInjectUsage(argv: string[]): { enabled: boolean; invalid?: string } {
  const raw = argValue(argv, "inject-usage");
  if (raw === undefined) return { enabled: DEFAULT_INJECT_USAGE };
  const text = raw.trim().toLowerCase();
  if (text === "on" || text === "true" || text === "1") return { enabled: true };
  if (text === "off" || text === "false" || text === "0") return { enabled: false };
  return { enabled: DEFAULT_INJECT_USAGE, invalid: raw };
}

/** 校验并解析 --rewrite / --anchor-time */
function resolveRewriteMode(argv: string[]): { mode: RewriteMode; invalid?: string } {
  if (argv.includes("--anchor-time")) return { mode: "anchor" };
  const raw = argValue(argv, "rewrite");
  if (raw === undefined) return { mode: DEFAULT_REWRITE_MODE };
  if (raw === "off" || raw === "observe" || raw === "stabilize" || raw === "anchor") return { mode: raw };
  return { mode: DEFAULT_REWRITE_MODE, invalid: raw };
}

/** 取命令行参数值：--key value */
function argValue(argv: string[], key: string): string | undefined {
  const index = argv.indexOf(`--${key}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/** 端口是否已被占用（尝试绑定，失败即视为占用） */
function isPortBusy(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}

/** 交接单目录是否可写（建目录 + 写探针 + 删除探针） */
function checkHandoffDirWritable(dir: string): { ok: boolean; detail: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.dobostitch-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
    return { ok: true, detail: dir };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    return { ok: false, detail: `${dir}（${code}）` };
  }
}

/** 首屏体检卡：进程刚起、还没有真实请求时的占位版 */
function renderStartupCard(port: number, routes: RouteConfig[], threshold: number): string {
  const prefixes = routes.map((route) => route.prefix).join(" ");
  const firstPrefix = routes[0]?.prefix ?? "/";
  const card: HealthCard = {
    requestIndex: 0,
    routePrefix: routes[0]?.prefix ?? "/",
    upstreamLabel: "待第一次请求",
    upstreamHost: `127.0.0.1:${port}`,
    vendor: "unknown",
    inputTokens: null,
    cachedTokens: null,
    hitRatio: null,
    judged: false,
    didWhat: `代理已就绪，等待第一次请求；可用前缀 ${prefixes}；交接阈值 ${threshold} token`,
    // 横幅必须给出可直接复制的完整地址，避免对端把"端口/前缀"填错
    entryUrl: `http://127.0.0.1:${port}${firstPrefix}`,
  };
  return renderHealthCard(card);
}

async function commandStart(argv: string[]): Promise<void> {
  const portArg = argValue(argv, "port");
  const port = portArg ? Number(portArg) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[dobostitch] 端口不合法：${portArg}`);
    process.exitCode = 1;
    return;
  }

  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.error(nodeCheck.message);
    process.exitCode = 1;
    return;
  }

  const token = argValue(argv, "token");
  const requireToken = argv.includes("--require-token");
  const rewrite = resolveRewriteMode(argv);
  if (rewrite.invalid) {
    console.error(`[dobostitch] 未知改写档位：${rewrite.invalid}（可用 off/observe/stabilize/anchor），已用默认 stabilize。`);
  }
  const inject = resolveInjectUsage(argv);
  if (inject.invalid) {
    console.error(`[dobostitch] 未知 --inject-usage 取值：${inject.invalid}（可用 on/off），已用默认 on。`);
  }
  const thresholdEnv = Number(process.env.DOBOSTITCH_CONTEXT_THRESHOLD ?? "");
  const threshold = Number.isFinite(thresholdEnv) && thresholdEnv > 0 ? thresholdEnv : DEFAULT_CONTEXT_THRESHOLD_TOKENS;

  const starting = await startProxy({
    port,
    authToken: token,
    requireToken,
    contextThresholdTokens: threshold,
    rewriteMode: rewrite.mode,
    injectUsage: inject.enabled,
  });
  const routes = resolveRoutes();

  console.log(renderStartupCard(starting.port, routes, threshold));
  console.log("");
  if (starting.port !== port) {
    console.log(`[提示] 端口 ${port} 已被占用，已自动顺延到 ${starting.port}（请把下面的地址端口一并改掉）。`);
  }
  console.log(`现在把客户端 baseURL 设为 http://127.0.0.1:${starting.port}/<厂商前缀> 即可：`);
  for (const route of routes) {
    console.log(`  ${route.label.padEnd(10, " ")} http://127.0.0.1:${starting.port}${route.prefix}`);
  }
  console.log("");
  console.log(`改写档位：${rewrite.mode}`);
  console.log(
    inject.enabled
      ? "流式 usage 注入：on（openai 方言 + stream=true 时自动补 stream_options.include_usage）"
      : "流式 usage 注入：off（流式响应多半不带 usage，命中率会显示未判定）",
  );
  console.log(`交接单目录：${defaultHandoffDir()}`);
  const dirNotice = handoffDirNotice();
  if (dirNotice) console.log(`[提示] ${dirNotice}`);
  const dirWarning = handoffDirWarning();
  if (dirWarning) console.log(`[警告] ${dirWarning}`);
  console.log("按 Ctrl+C 停止代理。");

  const shutdown = () => {
    console.log("\n[dobostitch] 正在停止代理…");
    void starting.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // 保持进程常驻：server 自身已挂住事件循环，这里不再额外定时器
}

function commandStatus(): void {
  const dir = defaultHandoffDir();
  const records = listHandoffs(dir);
  if (records.length === 0) {
    console.log(`[dobostitch] ${dir} 下还没有交接单（先跑 dobostitch start，并让客户端发一次请求）。`);
    return;
  }
  console.log(`[dobostitch] 最近会话（共 ${records.length} 个，目录 ${dir}）：`);
  for (const record of records.slice(0, 20)) {
    const inputText = record.inputTokensAtCapture > 0 ? `${record.inputTokensAtCapture} token` : "未判定";
    console.log(`  ${record.sessionKey}  ${record.createdAt}  上游 ${record.upstream}  输入 ${inputText}`);
    console.log(`    最近指令：${record.lastUserInstruction || "（无）"}`);
  }
}

function commandResume(argv: string[]): void {
  const key = argv[0];
  const dir = defaultHandoffDir();
  if (key) {
    const record = loadHandoff(key, dir);
    if (!record) {
      console.error(`[dobostitch] 没找到会话 ${key}（目录 ${dir}）。可用 dobostitch status 查看全部会话。`);
      process.exitCode = 1;
      return;
    }
    console.log(renderResumeBrief(record));
    return;
  }
  const records = listHandoffs(dir);
  if (records.length === 0) {
    console.error(`[dobostitch] ${dir} 下还没有交接单可续接。`);
    process.exitCode = 1;
    return;
  }
  console.log(renderResumeBrief(records[0]));
}

async function commandDoctor(argv: string[] = []): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const nodeCheck = checkNodeVersion();
  checks.push({
    name: "Node 版本",
    ok: nodeCheck.ok,
    detail: nodeCheck.ok ? `v${process.versions.node}（要求 ≥ 18）` : `v${process.versions.node} 过旧，请升级到 18+`,
  });

  const busy = await isPortBusy(DEFAULT_PORT);
  checks.push({
    name: "端口占用",
    ok: !busy,
    detail: busy ? `${DEFAULT_PORT} 已被占用，start 会自动跳号（最多 +10）` : `${DEFAULT_PORT} 空闲`,
  });

  const routes = resolveRoutes();
  const routeText = routes.map((route) => `${route.prefix}→${route.baseUrl}`).join("；");
  checks.push({
    name: "路由表",
    ok: routes.length > 0,
    detail: routes.length > 0 ? `${routes.length} 条：${routeText}` : "没有任何路由，请检查 DOBOSTITCH_ROUTES",
  });

  const dirCheck = checkHandoffDirWritable(defaultHandoffDir());
  checks.push({ name: "交接单目录可写", ok: dirCheck.ok, detail: dirCheck.detail });

  const rewrite = resolveRewriteMode(argv);
  const MODE_DESC: Record<RewriteMode, string> = {
    off: "不改请求体，只转发",
    observe: "只看不改（用于验证原样直通的前缀稳定性）",
    stabilize: "规范化 key 序 + 重排 tools（默认）",
    anchor: "stabilize + 时间字面量锚定（实验）",
  };
  checks.push({
    name: "改写档位",
    ok: rewrite.invalid === undefined,
    detail: rewrite.invalid === undefined ? `${rewrite.mode}：${MODE_DESC[rewrite.mode]}` : `未知档位 ${rewrite.invalid}，将回退到 stabilize`,
  });

  const inject = resolveInjectUsage(argv);
  checks.push({
    name: "流式 usage 注入",
    ok: inject.invalid === undefined,
    detail:
      inject.invalid === undefined
        ? inject.enabled
          ? "on：openai 方言 + stream=true 时自动补 stream_options.include_usage"
          : "off：流式请求不补字段，命中率多为未判定"
        : `未知取值 ${inject.invalid}，将回退到 on`,
  });

  console.log("[dobostitch] 自检结果：");
  for (const check of checks) {
    console.log(`  [${check.ok ? "通过" : "失败"}] ${check.name}：${check.detail}`);
  }
  const handoffNotice = handoffDirNotice();
  if (handoffNotice) console.log(`  [提示] 交接单目录：${handoffNotice}`);
  const handoffWarning = handoffDirWarning();
  if (handoffWarning) console.log(`  [警告] 交接单目录：${handoffWarning}`);
  const failed = checks.filter((check) => !check.ok).length;
  console.log(failed === 0 ? "[dobostitch] 全部通过，可以 start 了。" : `[dobostitch] 有 ${failed} 项失败，建议先处理再 start。`);
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [, , command = "", ...rest] = process.argv;
  switch (command) {
    case "start":
      await commandStart(rest);
      return;
    case "status":
      commandStatus();
      return;
    case "resume":
      commandResume(rest);
      return;
    case "doctor":
      await commandDoctor(rest);
      return;
    case "":
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(`[dobostitch] 未知子命令：${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`[dobostitch] 启动失败：${(err as Error)?.message ?? err}`);
  process.exitCode = 1;
});

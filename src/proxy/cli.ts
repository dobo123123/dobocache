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

import { findTargets, makeContext, renderGenericSnippet, resolveAttachPort, type AttachResult } from "../attach.js";
import { disable as disableAutostart, enable as enableAutostart, statusTransport } from "../autostart.js";
import { readLastPort, writeLastPort } from "../state.js";
import { renderHealthCard } from "./card.js";
import { defaultHandoffDir, handoffDirNotice, handoffDirWarning, listHandoffs, loadHandoff, renderResumeBrief } from "./handoff.js";
import { DEFAULT_CONTEXT_THRESHOLD_TOKENS, DEFAULT_PORT, resolveRoutes, startProxy } from "./server.js";
import { checkNodeVersion } from "../utils/runtime.js";
import { ensureAgentRules as ensureAgentRulesAt } from "../rules.js";
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

全自动接入（不想手改配置就用这个）：
  dobostitch setup [--dry-run]                      一条命令装完，小白只需记这一条
  dobostitch attach [--target auto|loomy|opencode|claude-code|generic] [--dry-run] [--revert] [--no-autostart]
  dobostitch autostart [status|enable|disable]

  setup = attach（自动找客户端配置、备份、改 baseURL、写入自带拉起代理的 MCP 入口）+ 注册开机自启。
  之后换任何底座都不用再写脚本：MCP 入口会自己把代理拉起来。
  attach 的 --dry-run 只预览，--revert 原样退回；generic 只打印可粘贴片段，适合自研底座。
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

  // 代理真正跑起来后落一次端口，其它入口（bundle / 自启 / attach）都以此为准
  writeLastPort(starting.port);

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

/** 打印一条 attach 结果 */
function printAttachResult(result: AttachResult): void {
  const tag =
    result.status === "applied" ? "已写入" : result.status === "dry-run" ? "预览" : result.status === "skipped" ? "跳过" : "失败";
  console.log(`  [${tag}] ${result.label}：${result.configPath}`);
  for (const change of result.changes) console.log(`        · ${change}`);
  if (result.detail) console.log(`        · ${result.detail}`);
  if (result.backup) console.log(`        · 备份：${result.backup}`);
}

/** attach：自动找配置、备份、改 baseURL、写 MCP 入口 */
async function commandAttach(argv: string[]): Promise<void> {
  const portText = argValue(argv, "port");
  const parsedPort = portText ? Number(portText) : NaN;
  const explicitPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null;
  const dryRun = argv.includes("--dry-run");
  const revert = argv.includes("--revert");
  const targetId = argValue(argv, "target") ?? "auto";
  const targets = findTargets(targetId);
  if (targets.length === 0) {
    console.error(`[dobostitch] 不认识的底座：${targetId}（可选 auto / loomy / opencode / claude-code / generic）`);
    process.exitCode = 1;
    return;
  }

  // 端口选择：用户显式指定 > 沿用已在跑的代理 > 默认端口
  const locatedFiles = targets.flatMap((target) => target.locate());
  const chosen = explicitPort ? { port: explicitPort, reused: false } : await resolveAttachPort(locatedFiles);
  const port = chosen.port;
  // 记住最终端口，MCP bundle / 开机自启都读它，保证全机一个端口口径
  if (!dryRun) writeLastPort(port);

  const ctx = makeContext(port, dryRun);
  const routes = resolveRoutes().map((route) => ({ prefix: route.prefix, baseUrl: route.baseUrl }));

  if (targetId === "generic") {
    console.log(renderGenericSnippet(ctx, routes));
    return;
  }

  console.log(`[dobostitch] ${revert ? "退回" : "接入"}模式${dryRun ? "（预览，不写盘）" : ""}；代理端口 ${port}${chosen.reused ? "（沿用已在跑的代理）" : ""}`);
  console.log(`[dobostitch] MCP 入口：${ctx.bundlePath}`);
  console.log("");

  const results: AttachResult[] = [];
  for (const target of targets) {
    const files = target.locate();
    if (files.length === 0) {
      results.push({
        target: target.id,
        label: target.label,
        configPath: "-",
        status: "skipped",
        changes: [],
        detail: "没找到该底座的配置文件",
      });
      continue;
    }
    for (const file of files) {
      try {
        results.push(revert ? target.revert(file, ctx) : target.sync(file, ctx));
      } catch (err) {
        results.push({
          target: target.id,
          label: target.label,
          configPath: file,
          status: "error",
          changes: [],
          detail: (err as Error)?.message ?? String(err),
        });
      }
    }
  }

  for (const result of results) printAttachResult(result);

  const applied = results.filter((result) => result.status === "applied").length;
  const failed = results.filter((result) => result.status === "error").length;
  const touched = results.some((result) => result.status === "applied" || result.status === "dry-run");
  // 已接入状态也属于「识别到了底座」：重复执行时不能再吐 generic 片段，否则用户会以为接入失败
  const alreadyReady = results.filter(
    (result) => result.status === "skipped" && (result.detail ?? "").includes("已是接入状态"),
  ).length;

  if (!revert && !dryRun && applied > 0 && !argv.includes("--no-autostart")) {
    const auto = enableAutostart(port);
    console.log("");
    console.log(`[dobostitch] 开机自启：${auto.registered ? "已注册" : "未注册"} —— ${auto.detail}`);
    console.log(`            载体：${auto.location}`);
  }

  console.log("");
  if (!revert && !touched && alreadyReady === 0) {
    console.log("[dobostitch] 没识别到可自动接入的底座，下面这段可直接粘到任意客户端：");
    console.log("");
    console.log(renderGenericSnippet(ctx, routes));
    return;
  }
  if (failed > 0) {
    console.log(`[dobostitch] ${failed} 个文件处理失败，原文件已备份，按上面提示排查后重跑即可。`);
    process.exitCode = 1;
    return;
  }
  console.log(
    dryRun
      ? "[dobostitch] 预览结束，以上都没写盘；确认无误后去掉 --dry-run 再跑一次即真正接入。"
      : revert
        ? "[dobostitch] 已退回接入前状态，重启客户端即生效。"
        : applied > 0
          ? "[dobostitch] 接好了：重启客户端即可，代理会随 MCP 自动起来，不用再单独起进程。"
          : "[dobostitch] 已是接入状态，无需重复执行；直接重启客户端即可用。",
  );
}

function ensureAgentRules(dryRun: boolean): void {
  for (const r of ensureAgentRulesAt(process.cwd(), dryRun)) {
    const verb = r.action === "created" || r.action === "preview-created"
      ? "新建"
      : r.action === "appended" || r.action === "preview-appended"
        ? "追加"
        : "更新";
    if (dryRun) console.log(`[dobostitch] 使用规程：将${verb} ${r.file}（预览，未写入）`);
    else console.log(`[dobostitch] 使用规程：已${verb} ${r.file}`);
  }
}

/** setup：一条命令完成"探测底座 → 写配置 → 注册自启"，小白唯一需要记的命令 */
async function commandSetup(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  console.log("[dobostitch] 一键接入：识别本机 AI 客户端 → 写入 MCP 配置 → 注册开机自启 → 写入使用规程");
  console.log("");

  await commandAttach(dryRun ? ["--dry-run", "--no-autostart"] : ["--no-autostart"]);
  ensureAgentRules(dryRun);
  if (dryRun) return;

  const located = findTargets("auto").flatMap((target) => target.locate());
  const { port } = await resolveAttachPort(located);
  writeLastPort(port);

  const st = statusTransport();
  if (st.registered) {
    console.log(`[dobostitch] 开机自启：已注册（${st.detail}）`);
  } else {
    const r = enableAutostart(port);
    console.log(`[dobostitch] 开机自启：${r.registered ? "已开启" : "未开启"}（${r.detail}）`);
    if (!r.registered) process.exitCode = 1;
  }

  console.log("");
  console.log("[dobostitch] 接入完成。重启 AI 客户端即可生效，不需要改代码，也不需要写任何脚本。");
}

/** autostart：注册/取消/查看开机自启 */
async function commandAutostart(argv: string[]): Promise<void> {
  const action = argv[0] ?? "status";
  const portText = argValue(argv, "port");
  const parsedPort = portText ? Number(portText) : NaN;
  // 端口口径：显式 --port > 已在跑的代理 > 上次记录的端口 > 默认端口
  let port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : NaN;
  if (!Number.isFinite(port)) {
    const located = findTargets("auto").flatMap((target) => target.locate());
    port = (await resolveAttachPort(located)).port;
  }
  if (!Number.isFinite(port)) port = readLastPort() ?? DEFAULT_PORT;

  if (action === "enable") {
    writeLastPort(port);
    const result = enableAutostart(port);
    console.log(`[dobostitch] ${result.registered ? "已开启" : "未开启"}：${result.detail}`);
    console.log(`            载体：${result.location}`);
    if (!result.registered) process.exitCode = 1;
    return;
  }
  if (action === "disable") {
    const result = disableAutostart();
    console.log(`[dobostitch] 关闭开机自启：${result.detail}`);
    console.log(`            载体：${result.location}`);
    return;
  }
  if (action !== "status") {
    console.error(`[dobostitch] 未知动作：${action}（可选 status / enable / disable）`);
    process.exitCode = 1;
    return;
  }
  const result = statusTransport();
  console.log(`[dobostitch] 开机自启状态：${result.registered ? "已注册" : "未注册"}`);
  console.log(`            平台支持：${result.supported ? "是" : "否"}`);
  console.log(`            载体：${result.location}`);
  console.log(`            说明：${result.detail}`);
}

/**
 * --log <path>：把本进程的 console 输出写进文件。
 * 用途：被 bundle 以后台方式拉起时，日志必须由代理自己落盘，
 * 否则后台进程会继承调用方的 stdout/stderr，把 MCP 协议流搞脏、还让调用方管道不结束。
 */
function redirectConsoleIfRequested(argv: string[]): void {
  const target = argValue(argv, "log");
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stream = fs.createWriteStream(target, { flags: "a" });
    const write = (...args: unknown[]): void => {
      stream.write(`${args.map((item) => (typeof item === "string" ? item : String(item))).join(" ")}\n`);
    };
    console.log = write;
    console.error = write;
  } catch {
    /* 写不了就保持原样，不能因为日志失败影响代理 */
  }
}

async function main(): Promise<void> {
  const [, , command = "", ...rest] = process.argv;
  redirectConsoleIfRequested(rest);
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
    case "attach":
      await commandAttach(rest);
      return;
    case "setup":
      await commandSetup(rest);
      return;
    case "autostart":
      await commandAutostart(rest);
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

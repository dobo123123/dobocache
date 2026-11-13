#!/usr/bin/env node
// DoboCache MCP Server 入口（v0.4.6：命中缓存 + 可开关的白盒报告）
// 职责：注册缓存优化工具（命中判定/价值分级准入/记忆提纯注入/测量仪表/白盒报告），
// 供任意 MCP 客户端调用。核心算法在 src/core/，不依赖任何第三方缓存实现。
// v0.4.1 变更：产品改名 DoboCache；白盒报告随 cf_judge/cf_inject 返回即时摘要卡片；
// 累计统计写入本地日志目录（平台标准可写目录，见 utils/logDir.ts），不占对话 token；
// v0.4.6 变更：白盒卡片默认关闭（默认只在本地写日志，可用 DOBOCACHE_WHITEBOX=once|always 打开）；
// 对外术语废除"轮"，统一为"次请求"；命中率只认厂商 usage 回传，拿不到即记为"未判定"。
// 不实现行为采集/数据回传/仪表盘。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCacheTools } from "./adapters/mcpTools.js";
import { Meter } from "./core/meter.js";
import { WhiteboxLogger } from "./core/whitebox.js";
import { checkNodeVersion } from "./utils/runtime.js";

// ─────────────────────────────────────────────────────────────────────────────
// v0.5.2 · P0 修复：子命令转发（DOBOCACHE_SUBCOMMAND_FORWARD）
//
// 背景：package.json 声明了两个 bin —— dobocache → dist/index.js、
// dobostitch → dist/proxy/cli.js。而 `npx <包名> <参数...>` 只会执行与包同名的
// 那个 bin（dobocache），后面的 `dobostitch start` 是当作普通参数传进来的。
// 本文件原先完全不读 process.argv，直接连 stdio，于是首屏命令表现为：
//   · stdin 活着（终端交互）→ 静默挂死，不打印体检卡、不监听端口；
//   · stdin 已 EOF（管道/重定向）→ 立刻退出，stdout/stderr 全空。
// 两种表现用户都读不出"命令写错了"。
//
// 修法：建 MCP server 之前先识别子命令；命中就把 argv 重排后交给 proxy/cli.js。
// 其余情况（无参数 / MCP 客户端拉起）走原路径，行为一字不变。
//
// 硬约束：本段不得向 stdout 打印任何内容（会污染 MCP 通道），日志一律走 stderr。
// ─────────────────────────────────────────────────────────────────────────────
const PROXY_SUBCOMMANDS = new Set(["start", "status", "resume", "doctor", "setup", "attach", "autostart"]);

async function forwardToProxyIfNeeded(): Promise<boolean> {
  const rawArgs = process.argv.slice(2);
  // 兼容首屏写法 `dobocache dobostitch start`：把中间多出来的 bin 名当噪声丢掉
  const args = rawArgs[0] === "dobostitch" ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) return false;
  const command = args[0];
  if (command === undefined || !PROXY_SUBCOMMANDS.has(command)) return false;
  // cli.ts 读的是 [, , command, ...rest]，把 argv 重排成它期望的形状
  process.argv = [process.argv[0] ?? "node", process.argv[1] ?? "dobocache", ...args];
  await import("./proxy/cli.js");
  return true;
}

// 命中子命令时 cli.js 已接管命令行（start 长期驻留，status/resume/doctor 干完自退），
// 这里什么都不做；未命中才建立 MCP server，行为与 v0.5.1 完全一致。
if (!(await forwardToProxyIfNeeded())) {
  try {
    await startMcpServer();
  } catch (err) {
    console.error("[dobocache] fatal:", err);
    process.exit(1);
  }
}

/**
 * MCP server 主路径（无子命令参数时走这里）。
 * 整体包在函数里，是为了让上方的子命令转发能干净地"什么都不做"地返回，
 * 而不是靠挂住顶层执行流去阻止后续代码 —— 后者会让 Node 在进程结束时
 * 打印 "Detected unsettled top-level await" 噪声到 stderr。
 */
async function startMcpServer(): Promise<void> {
  // 启动自检①：Node.js 主版本（MCP SDK 1.x 需 >= 18）。
  // 不满足时打印一句人话提示后退出，避免用户看到一堆难以理解的语法错误。
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    console.error(nodeCheck.message);
    process.exit(1);
  }

  const server = new McpServer(
    {
      name: "dobocache",
      version: "0.6.0",
    },
    {
      // v0.4.4 r3：服务级说明（MCP 规范 initialize.instructions）。
      // 客户端把这段原样展示给模型，因此只写"怎么用/边界在哪"，不写任何内部实现细节。
      instructions: [
        "DoboCache 是本地 stdio MCP server，用于稳定化上下文前缀以命中厂商 prompt cache，并输出可追溯的白盒报告。",
        "典型顺序：cf_tier 做价值分级准入 → cf_inject 注入（首次请求 reset=true，后续请求同 sessionId 复用冻结前缀）→ 需要时 cf_warmup 预热。",
        "观测口径：cf_meter 报当前进程内即时快照（重启归零），cf_report 读本地日志做跨进程/跨天累计并给出日志实际落点（logDir / logDirSource）；日志仅写本机，不含提问原文。",
        "白盒卡片默认关闭：默认只在本地写日志、不往对话里塞报告，累计数据用 cf_report 随时查（不占对话 token）；想看每次详情可设 DOBOCACHE_WHITEBOX=once（看一次）或 always（每次都看）。",
        "命中率只认厂商回传的缓存 usage；调用方未回传 usage 时记为\"未判定\"（null），不按 0% 计。",
        "所有工具均在本地计算，不发起任何网络请求，不上传任何数据。",
        "平台说明：Windows 为已验证的主打平台；Linux / macOS 仅有单元测试覆盖，未经真机验证。",
      ].join("\n"),
    },
  );

  // 健康检查
  server.tool(
    "ping",
    "DoboCache 健康检查",
    {},
    {
      title: "健康检查（ping）",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => ({ content: [{ type: "text", text: "pong: dobocache ready" }] }),
  );

  /**
   * v0.4.4 r3：计价系数环境变量解析。
   * 原实现直接 Number(env)，环境变量写错（"abc" / "-1" / 空串）会得到 NaN 或负数，
   * 之后 cf_meter / cf_report 的比例字段会静默变成 NaN，用户只能看到无法解释的输出。
   * 这里改为：非法值回退默认值 + 一条 stderr 提示，避免静默异常。
   */
  function resolvePriceEnv(names: string[], fallback: number, label: string): number {
    for (const name of names) {
      const raw = process.env[name];
      if (raw === undefined || raw.trim() === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) return value;
      console.error(
        `[dobocache] 环境变量 ${name} 的值 "${raw}" 不是合法计价系数（要求 ≥ 0 的有限数字），已回退默认值 ${fallback}（${label}）。`,
      );
      return fallback;
    }
    return fallback;
  }

  // 注册核心缓存优化工具（共享一个测量仪表实例；命中/未命中计价系数可配，均由环境变量覆盖，默认值仅为占位量级）
  const hitPricePerM = resolvePriceEnv(
    ["DOBOCACHE_HIT_PRICE_PER_M", "CACHEFORGE_HIT_PRICE_PER_M"],
    0.014,
    "命中计价系数",
  );
  const missPricePerM = resolvePriceEnv(
    ["DOBOCACHE_MISS_PRICE_PER_M", "CACHEFORGE_MISS_PRICE_PER_M"],
    0.5,
    "未命中计价系数",
  );
  const meter = new Meter({
    hitPricePerM,
    missPricePerM,
  });
  // v0.4.1 白盒报告：累计统计 + 单次报告落盘（仅本机，不随包分发，不占对话 token）；
  // 日志目录优先级：DOBOCACHE_LOG_DIR 环境变量 > 平台标准可写目录 > <cwd>/data/logs（详见 utils/logDir.ts）。
  const whitebox = new WhiteboxLogger({
    logDir: process.env.DOBOCACHE_LOG_DIR ?? process.env.CACHEFORGE_LOG_DIR,
    hitPricePerM,
    missPricePerM,
  });
  // 启动自检②：日志目录不可写时只提醒、不退出（白盒是增强而非依赖）。
  for (const warning of whitebox.logWarnings) {
    console.error(`[dobocache] ${warning}`);
  }
  // 启动提示：只在用户显式打开白盒卡片时打一行，便于自查"我开了但没看到卡"的原因；默认 quiet 不打扰。
  if (whitebox.cardModeValue !== "quiet") {
    console.error(
      `[dobocache] 白盒卡片已开启（DOBOCACHE_WHITEBOX=${whitebox.cardModeValue}）：每张卡约 300+ tokens，看完建议改回 quiet。`,
    );
  }

  registerCacheTools(server, meter, whitebox);

    // MCP 客户端拉起路径：连上 stdio 后由 SDK 自身维持事件循环
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

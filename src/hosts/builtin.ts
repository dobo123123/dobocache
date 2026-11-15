/**
 * hosts/builtin.ts —— 内置底座描述符（v0.7.0 起按版本累积）
 *
 * 每个版本往这里加一家/几家，加完在 test/hosts.test.ts 里补一条用例。
 * 字段口径：
 *   plan       P0 自动写 / P1 谨慎写 / P2 只指路
 *   confidence verified（真机验证过）才参与 setup 自动接入；
 *              unverified 必须 --allow-unverified 显式指定才会写
 *   since      从哪个版本开始支持
 *
 * 红线：宁可只指路，也不写一份猜出来的配置 —— 底座配置文件格式一错，
 * 用户看到的是"装上以后客户端起不来"，比不写更糟。
 */
import type { HostDescriptor } from "./types.js";

// ---------------------------------------------------------------- v0.7.0

/** Codex CLI：~/.codex/config.toml 的 [mcp_servers.<name>] 表 */
const codexCli: HostDescriptor = {
  id: "codex-cli",
  label: "Codex CLI",
  plan: "P0",
  since: "0.7.0",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "config.toml 的 mcp_servers 表结构（TOML），未经真机验证",
  locations: [{ pattern: "~/.codex/config.toml", role: "mcp", note: "Codex CLI 用户级配置" }],
  write: {
    kind: "managed-block",
    syntax: "toml",
    // mcp_servers 一般已在文件里，但新装可能没有；追加到末尾是合法的 TOML 表定义
    anchor: "mcp_servers",
    appendIfMissing: true,
    render: (ctx) =>
      [
        "[mcp_servers.dobocache]",
        `command = ${JSON.stringify(ctx.nodeExe)}`,
        `args = [${JSON.stringify(ctx.bundlePath)}]`,
      ].join("\n"),
  },
  manualSteps: ["重启 Codex CLI 会话后生效；config.toml 其余内容未改动"],
};

/** Aider：没有原生 MCP，走 OpenAI 兼容 baseURL（openai-api-base） */
const aider: HostDescriptor = {
  id: "aider",
  label: "Aider",
  plan: "P0",
  since: "0.7.0",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "Aider 的 openai-api-base 配置项（YAML），未经真机验证",
  locations: [{ pattern: "~/.aider.conf.yml", role: "env", note: "Aider 用户级 YAML 配置" }],
  write: {
    kind: "managed-block",
    syntax: "yaml",
    // 顶层键，追加到末尾即可；已存在同名键就拒绝，避免 YAML 重复键
    conflictKey: "openai-api-base",
    render: (ctx) => [`openai-api-base: ${ctx.proxyBase}/openai`, `openai-api-key: dobocache-local`].join("\n"),
  },
  manualSteps: ["重启 Aider 后生效；api-key 只是占位（本地代理不校验），真实上游 key 仍由环境变量或启动参数提供"],
};

export const BUILTIN_HOSTS: HostDescriptor[] = [codexCli, aider];

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

// ---------------------------------------------------------------- v0.7.1

/** Goose：~/.config/goose/config.yaml（Windows 为 %APPDATA%\Block\goose\config\config.yaml）的 extensions 段 */
const goose: HostDescriptor = {
  id: "goose",
  label: "Goose",
  plan: "P0",
  since: "0.7.1",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 config-files 文档：extensions 下 type: stdio 需 name/enabled/cmd/args/envs/timeout，未经真机验证",
  locations: [
    { pattern: "%APPDATA%/Block/goose/config/config.yaml", role: "mcp", note: "Windows 用户级配置" },
    { pattern: "~/.config/goose/config.yaml", role: "mcp", note: "macOS / Linux 用户级配置" },
  ],
  write: {
    kind: "managed-block",
    syntax: "yaml",
    // extensions 是 Goose 必有的顶层键；缺了也不猜，直接退回只指路
    anchor: "extensions",
    appendIfMissing: false,
    conflictKey: "dobocache",
    render: (ctx) =>
      [
        "dobocache:",
        "  type: stdio",
        "  name: dobocache",
        "  enabled: true",
        `  cmd: ${ctx.nodeExe}`,
        "  args:",
        `    - ${ctx.bundlePath}`,
        "  envs: {}",
        "  timeout: 300",
      ].join("\n"),
  },
  manualSteps: ["重启 goose 会话后生效；config.yaml 其余内容未改动"],
};

/** Kimi CLI（Kimi Code CLI）：~/.kimi/mcp.json，格式与其他 MCP 客户端兼容 */
const kimiCli: HostDescriptor = {
  id: "kimi-cli",
  label: "Kimi CLI",
  plan: "P0",
  since: "0.7.1",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 MCP 文档：~/.kimi/mcp.json 的 mcpServers 下 command/args/env，未经真机验证",
  locations: [{ pattern: "~/.kimi/mcp.json", role: "mcp", note: "Kimi Code CLI 的 MCP 配置文件" }],
  write: {
    kind: "json",
    mcpKeyPath: ["mcpServers"],
    entryShape: "command-args",
  },
  manualSteps: ["重启 Kimi CLI 后生效；上游 base_url 在 ~/.kimi/config.toml 的 providers 里，本工具不改，需按指路自行填写"],
};

/** Gemini CLI：~/.gemini/settings.json 的 mcpServers（官方文档明确）；api.baseUrl 无官方依据，故不写 */
const geminiCli: HostDescriptor = {
  id: "gemini-cli",
  label: "Gemini CLI",
  plan: "P1",
  since: "0.7.1",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方文档：用户级 settings.json 的 mcpServers；自定义 endpoint 字段未见官方文档，故不写 baseUrl",
  locations: [{ pattern: "~/.gemini/settings.json", role: "mcp", note: "Gemini CLI 用户级设置" }],
  write: {
    kind: "json",
    mcpKeyPath: ["mcpServers"],
    entryShape: "command-args",
  },
  guide: [
    "本工具只往 settings.json 的 mcpServers 里加一条 dobocache，供模型调用缓存压缩工具",
    "Gemini CLI 走自家协议，本工具的缓存字段观测不到它的请求体；想把它的流量也接进代理，需要命令行改用自身支持的 endpoint 参数，本工具不代写",
  ],
  manualSteps: ["重启 Gemini CLI 后生效；settings.json 其余内容未改动"],
};

/** Crush：配置已转为 crushrc（shell 风格），旧 crush.json 官方标为 deprecated，故只指路不写盘 */
const crush: HostDescriptor = {
  id: "crush",
  label: "Crush",
  plan: "P1",
  since: "0.7.1",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 README：配置优先级 .crushrc → crushrc → ~/.config/crush/crushrc；JSON 旧格式已标 deprecated",
  locations: [
    { pattern: "~/.config/crush/crushrc", role: "mcp", note: "全局 crushrc（shell 风格配置）" },
    { pattern: "~/.config/crush/crush.json", role: "mcp", note: "旧 JSON 格式，官方已标 deprecated" },
  ],
  write: null,
  guide: [
    "Crush 的配置是可执行风格的 crushrc，本工具不代写（写错会让客户端起不来）",
    "在 crushrc 里加一行即可接入 MCP：",
    "mcp add dobocache --command <node 路径> --args <bundle 路径>",
    "上面的路径可用 dobocache providers show crush 打印",
  ],
  manualSteps: ["重启 Crush 后生效"],
};

// ---------------------------------------------------------------- v0.7.2（编辑器档）

/**
 * Cline（VS Code 扩展）：全局 MCP 设置文件，键为 mcpServers。
 * 新版把全局配置挪到 ~/.cline/data/settings/，老版在 VS Code 的 globalStorage 下；两个位置都列，
 * 只写真正存在的那个文件（不凭空造配置）。
 */
const cline: HostDescriptor = {
  id: "cline",
  label: "Cline（VS Code 扩展）",
  plan: "P1",
  since: "0.7.2",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 Config 文档：全局 MCP 设置 cline_mcp_settings.json（新路径 ~/.cline/data/settings/，老版在 VS Code globalStorage），未经真机验证",
  locations: [
    { pattern: "~/.cline/data/settings/cline_mcp_settings.json", role: "mcp", note: "新版 Cline 全局 MCP 设置" },
    {
      pattern: "%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      role: "mcp",
      note: "老版 Cline（Windows，VS Code globalStorage）",
    },
    {
      pattern: "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      role: "mcp",
      note: "老版 Cline（macOS）",
    },
    {
      pattern: "~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
      role: "mcp",
      note: "老版 Cline（Linux）",
    },
  ],
  write: {
    kind: "json",
    mcpKeyPath: ["mcpServers"],
    entryShape: "command-args",
  },
  manualSteps: ["在 VS Code 里重载窗口或重启 Cline 面板后生效；设置文件其余内容未改动"],
};

/**
 * Continue：~/.continue/config.yaml 的 mcpServers —— 注意是**列表**形态（- name: ...），不是映射。
 * 所以用受管块写一个列表项，冲突检测也要匹配 `- name: dobocache`。
 */
const continueHost: HostDescriptor = {
  id: "continue",
  label: "Continue",
  plan: "P1",
  since: "0.7.2",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 MCP 文档：config.yaml 的 mcpServers 为列表项（name / command / args / env），仅在 agent 模式可用，未经真机验证",
  locations: [{ pattern: "~/.continue/config.yaml", role: "mcp", note: "Continue 用户级 YAML 配置" }],
  write: {
    kind: "managed-block",
    syntax: "yaml",
    anchor: "mcpServers",
    appendIfMissing: false,
    conflictRegex: "^\\s*-\\s*name:\\s*[\"']?dobocache[\"']?\\s*$",
    render: (ctx) =>
      [
        "- name: dobocache",
        "  command: " + ctx.nodeExe,
        "  args:",
        "    - " + ctx.bundlePath,
      ].join("\n"),
  },
  manualSteps: ["重启 Continue（重载窗口）后生效；Continue 仅在 Agent 模式下挂 MCP，Chat 模式看不到该工具"],
};

/** Cursor：~/.cursor/mcp.json 的 mcpServers（全局 MCP 配置） */
const cursor: HostDescriptor = {
  id: "cursor",
  label: "Cursor",
  plan: "P1",
  since: "0.7.2",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 MCP 文档：~/.cursor/mcp.json 的 mcpServers（command / args / env）；Cursor 自家模型不支持自定义 baseURL，故只写 MCP，未经真机验证",
  locations: [{ pattern: "~/.cursor/mcp.json", role: "mcp", note: "Cursor 全局 MCP 配置" }],
  write: {
    kind: "json",
    mcpKeyPath: ["mcpServers"],
    entryShape: "command-args",
  },
  guide: [
    "Cursor 自家补全/Agent 的请求不能改到自定义端点，本工具只给它挂 MCP 工具，不写 baseURL",
    "想让缓存字段被观测到，需要在 Cursor 里用「OpenAI 兼容自定义模型」指向本地代理（设置里手填）",
  ],
  manualSteps: ["在 Cursor 的 MCP 面板里点一次刷新/重连后生效"],
};

/** Windsurf：~/.codeium/windsurf/mcp_config.json 的 mcpServers */
const windsurf: HostDescriptor = {
  id: "windsurf",
  label: "Windsurf",
  plan: "P1",
  since: "0.7.2",
  platforms: ["win32", "darwin", "linux"],
  confidence: "unverified",
  source: "官方 MCP 文档：mcp_config.json 的 mcpServers（command / args / env），未经真机验证",
  locations: [{ pattern: "~/.codeium/windsurf/mcp_config.json", role: "mcp", note: "Windsurf 全局 MCP 配置" }],
  write: {
    kind: "json",
    mcpKeyPath: ["mcpServers"],
    entryShape: "command-args",
  },
  guide: [
    "Windsurf 的模型端点不可自定义，本工具只挂 MCP 工具，不写 baseURL",
    "缓存命中数据需在 Windsurf 里改用 OpenAI 兼容自定义模型指向本地代理后才观测得到",
  ],
  manualSteps: ["在 Windsurf 的 Cascade → MCP 面板里点刷新后生效"],
};

export const BUILTIN_HOSTS: HostDescriptor[] = [
  codexCli,
  aider,
  goose,
  kimiCli,
  geminiCli,
  crush,
  cline,
  continueHost,
  cursor,
  windsurf,
];

/**
 * hosts/types.ts —— 底座描述符（Host Descriptor）类型定义（v0.7.0）
 *
 * 背景：v0.6.x 之前，能自动接入的底座写死在 attach.ts 的 TARGETS 数组里（三家）。
 * v0.7.0 起改成「描述符注册表」：新增一家底座 = 加一条描述符数据，不改引擎代码。
 *
 * 设计红线（沿用 v0.6.x）：
 *   - 误伤率 0：只碰自己写进去的那一段；判断不了就退回「只指路、不写盘」
 *   - 内核零改：本目录只负责"找配置 / 写配置 / 退回去"，不涉及代理与缓存算法
 *   - P2（桌面 GUI）一律不写盘，只输出指路文案
 */

/** 分档：P0 自动写、P1 谨慎写、P2 只指路 */
export type HostPlan = "P0" | "P1" | "P2";

/** 支持平台 */
export type HostPlatform = "win32" | "darwin" | "linux";

/**
 * 可信度：
 *   verified   = 已在真机验证过读写与回滚（只有这类默认参与 setup 自动接入）
 *   unverified = 字段来源为公开文档/社区实践，未经真机验证（必须显式 --allow-unverified 才写）
 */
export type HostConfidence = "verified" | "unverified";

/**
 * 验证分级（v0.9.1「适配矩阵收尾」新增）：
 *   client-confirmed = 真实客户端自己认过这条接入（客户端 CLI/界面能列出 dobocache）
 *   write-rollback   = 本机真实文件系统上跑完整链路：写入 → 语法解析通过 → 条目在位 → 回滚后与接入前逐字节一致
 *   docs-only        = 只按官方文档给指路文案、不写盘（这类不参与任何自动写入）
 *
 * 为什么要分级：v0.8.1 之前只写"3 家真机验证过、其余照文档写"，等于把 10 家的状态糊成一句
 * "没验证"。分级之后每一项都带自己的证据与日期，发布口径可以逐项交代，不再需要整体兜底话术。
 */
export type HostVerificationLevel = "client-confirmed" | "write-rollback" | "docs-only";

/** 一项底座的验证记录（写进描述符，`dobostitch providers list` 会原样打印） */
export interface HostVerification {
  level: HostVerificationLevel;
  /** 最近一次复核日期 YYYY-MM-DD */
  at: string;
  /** 证据：在什么环境、用什么手段、得到什么结果（对外可复算，不写"应该没问题"） */
  basis: string;
}

/** 一个候选配置文件 */
export interface HostLocation {
  /** 绝对路径或含 ~ / 环境变量的模板，支持单层 * 展开 */
  pattern: string;
  /** 该文件承载什么：mcp 条目 / baseURL 或 env / 两者都有 */
  role: "mcp" | "env" | "both";
  note?: string;
}

/** JSON 类写盘规格 */
export interface JsonWriteSpec {
  kind: "json";
  /** MCP 条目父级键路径，如 ["mcpServers"] / ["mcp"] / ["context_servers"]；不写 MCP 则不填 */
  mcpKeyPath?: string[];
  /** 条目形态 */
  entryShape?: "command-args" | "opencode-local" | "stdio-type" | "zed-context-server";
  /** baseURL 落点键路径，如 ["provider","imodel","options","baseURL"] */
  baseURLPath?: string[];
  /** 拼在 proxyBase 之后的路径，如 "/api/v1"、"/anthropic"、" /v1" */
  baseURLSuffix?: string;
}

/** 文本配置受管块规格（TOML / YAML 这类没有 JSON 安全写法、但可以"整段托管"的格式） */
export interface ManagedBlockWriteSpec {
  kind: "managed-block";
  syntax: "toml" | "yaml";
  /**
   * 锚点键（顶层键名，如 "extensions"）。填了就插入到该键下一层；
   * 不填则追加到文件末尾（顶层）。
   */
  anchor?: string;
  /** 锚点不存在时是否仍可在文件末尾追加（默认 false：宁可只指路也不猜） */
  appendIfMissing?: boolean;
  /** 禁止重复的键名（默认 dobocache）；文件里已存在同名键时拒绝写入 */
  conflictKey?: string;
  /** 额外的冲突检测正则（形如列表项 `- name: dobocache` 这类非键值写法的底座用） */
  conflictRegex?: string;
  /** 生成受管块内容（不含 markers），ctx 提供 bundle / 端口等变量 */
  render(ctx: BlockRenderContext): string;
}

export type HostWriteSpec = JsonWriteSpec | ManagedBlockWriteSpec;

/** 渲染受管块时可用的变量 */
export interface BlockRenderContext {
  nodeExe: string;
  bundlePath: string;
  /** 如 http://127.0.0.1:27880 */
  proxyBase: string;
  port: number;
}

/** 一条底座描述符 */
export interface HostDescriptor {
  /** 稳定 id，命令行 --target 用 */
  id: string;
  /** 展示名 */
  label: string;
  plan: HostPlan;
  /** 从哪个版本开始支持，如 "0.7.0" */
  since: string;
  platforms: HostPlatform[];
  confidence: HostConfidence;
  /** v0.9.1：这一项自己的验证等级与证据（13 项内置适配逐项交代，不再整体兜底） */
  verification?: HostVerification;
  /** 来源说明（文档出处 / 实测记录），对外不夸大 */
  source?: string;
  locations: HostLocation[];
  /** null 表示只指路不写盘（P2 或无法安全写入的底座） */
  write: HostWriteSpec | null;
  /** 只指路时的引导文案（P2 必填） */
  guide?: string[];
  /** 写盘后仍需人工确认的事项 */
  manualSteps?: string[];
}

/** 单文件处理结果（形状与 attach 的 AttachResult 对齐，便于 CLI 统一打印） */
export interface HostResult {
  target: string;
  label: string;
  configPath: string;
  status: "applied" | "dry-run" | "skipped" | "error";
  changes: string[];
  detail?: string;
  backup?: string;
  /** v0.8.1：写入前预检判定不可写，本次一个字节都没动（CLI 据此改打可粘贴片段） */
  writeBlocked?: boolean;
}

/** 探测结果（只读，不写盘） */
export interface HostDetection {
  id: string;
  label: string;
  plan: HostPlan;
  since: string;
  confidence: HostConfidence;
  platforms: HostPlatform[];
  /** 真正存在的文件 */
  files: string[];
  /** 是否已写入过接入记录（读 sidecar 判断） */
  attached: boolean;
  /** v0.9.1：验证等级（体检与清单打印用） */
  verification?: HostVerification;
  /** 只指路时的文案 */
  guide?: string[];
}

/**
 * dobostitch 代理层：类型契约
 *
 * 定位：本地代理中间件（皮①）。本目录只做 wire 层适配与记账，
 * 不 import 任何内核算法实现（src/core/*），内核零分叉。
 *
 * 约定：
 * - 所有金额相关字段一律不存在（体检卡禁止出现金额）；
 * - 命中率只认厂商回传 usage，拿不到即"未判定"，绝不按 0% 计；
 * - 时间一律 ISO8601 字符串，只用于日志排序，不得参与前缀构造。
 */

/** 上游厂商的 wire 方言：决定请求/响应体怎么解析（不是厂商名，是协议族） */
export type Vendor = "openai" | "anthropic" | "unknown";

/**
 * 请求改写档位：
 *  - off      完全不动请求体，只透传（诊断也不做）；
 *  - observe  只看不改，用来验证"原样直通时前缀到底稳不稳"；
 *  - stabilize 规范化 key 序 + 重排 tools（默认档，零语义风险）；
 *  - anchor   stabilize + 时间字面量锚定（实验能力）。
 */
export type RewriteMode = "off" | "observe" | "stabilize" | "anchor";

/**
 * 前缀分歧类型：
 *  - first     本次进程里第一次见这个会话，建立基线；
 *  - none      和上一轮完全一致；
 *  - appended  只在尾部追加新消息（健康态，前面全部还能命中）；
 *  - modified  旧内容被改写（命中率就死在这里）；
 *  - shrunk    历史被裁掉了若干段（压缩后命中率必掉）。
 */
export type DivergenceKind = "first" | "none" | "appended" | "modified" | "shrunk";

/** 一轮请求的前缀诊断结果（复杂度与 token 无关，只报结构信号） */
export interface PrefixDiag {
  /** 本轮生效的改写档位 */
  mode: RewriteMode;
  /** 本次前缀段数（system + tools + 每条 message 各算一段） */
  segmentCount: number;
  /** 与上一轮相比的分歧类型 */
  divergenceKind: DivergenceKind;
  /** 第一处变化的段的索引；无历史或完全一致时为 null */
  firstDivergenceIndex: number | null;
  /** shrunk 时被裁掉的旧消息条数，其余为 0 */
  shrunkBy: number;
  /** 本次是否重排了 tools 顺序 */
  stabilizedTools: boolean;
  /** 本次是否做了 JSON key 序规范化 */
  stabilizedKeys: boolean;
  /** 本次锚定的时间字面量个数 */
  anchoredTimes: number;
  /** 是否真的改写了发给上游的 body */
  changed: boolean;
  /** 未改写的原因（非 JSON、解析失败等） */
  reason?: string;
}

/**
 * 流式 usage 注入的生效状态：
 *  - injected      本次确实把 stream_options.include_usage 补进去了；
 *  - already-set   客户端自己写了 include_usage（true/false 都算），本层不动；
 *  - disabled      开关关闭（--inject-usage off）；
 *  - not-applicable 非 OpenAI 方言 / 非流式 / 请求体不可解析，不适用。
 */
export type InjectUsageStatus = "injected" | "already-set" | "disabled" | "not-applicable";

/** 一轮请求的注入结果（进体检卡，便于对端直接看到有没有生效） */
export interface UsageInjectNote {
  /** 本次注入状态 */
  status: InjectUsageStatus;
  /** 上游因该字段回 4xx 未知字段、已去掉字段重试过一次 */
  retried: boolean;
  /** 未注入 / 未重试的原因（排障用） */
  reason?: string;
}

/** 一条路由：路径前缀 → 上游基址 */
export interface RouteConfig {
  /** 本地路径前缀，必须以 "/" 开头，例如 "/deepseek" */
  prefix: string;
  /** 上游基址，例如 "https://api.deepseek.com"（可带路径） */
  baseUrl: string;
  /** 该上游使用的 wire 方言 */
  vendor: Vendor;
  /** 展示用名字，例如 "DeepSeek" */
  label: string;
}

/** 代理进程启动参数 */
export interface ProxyOptions {
  /** 监听端口，默认 27880（刻意避开 8787 / 18787） */
  port?: number;
  /** 监听地址，默认 127.0.0.1，仅回环 */
  host?: string;
  /** 路由表；不传则用内置 /deepseek /openai /anthropic */
  routes?: RouteConfig[];
  /** 本实例鉴权 token（写进 X-Dobostitch-Token） */
  authToken?: string;
  /** 是否强制要求 token；默认 false（客户端只需改 baseURL 即可用，降低摩擦） */
  requireToken?: boolean;
  /** 上下文阈值（token）：超过即视为"该做交接" */
  contextThresholdTokens?: number;
  /** 交接单落盘目录，默认 <仓库>/data/handoff */
  handoffDir?: string;
  /** 单次上游请求超时（毫秒），超时降级直连 */
  upstreamTimeoutMs?: number;
  /** 体检卡的输出通道，默认打到 stdout */
  onCard?: (card: string) => void;
  /** 请求改写档位，默认 "stabilize" */
  rewriteMode?: RewriteMode;
  /**
   * 是否给 OpenAI 方言的流式请求自动补 stream_options.include_usage，默认 true。
   * 关掉后流式响应通常不带 usage，命中率会长期"未判定"。
   */
  injectUsage?: boolean;
}

/**
 * 一次请求的缓存命中样本。
 * judged=false 表示"厂商没回传 usage"，此时 inputTokens/cachedTokens 只作占位，
 * hitRatio 必须为 null，展示层必须写"未判定"。严禁按 0% 计。
 */
export interface UsageSample {
  /** 输入 token 总量（Anthropic 为 input + cache_read + cache_creation） */
  inputTokens: number;
  /** 命中缓存的 token 数 */
  cachedTokens: number;
  /** 命中率 0~1，未判定时为 null */
  hitRatio: number | null;
  /** 该样本来自哪种 wire 方言 */
  vendor: Vendor;
  /** 是否真的拿到了厂商 usage */
  judged: boolean;
}

/**
 * 任务交接单（简化版 Handoff）。
 * 纯规则提取，不调用任何模型；用于换会话/换模型后接着干。
 */
export interface HandoffRecord {
  /** 上游域名 + 首个 user 消息哈希前 8 位 */
  sessionKey: string;
  /** ISO8601 */
  createdAt: string;
  /** 上游 host（含可选路径前缀），例如 "api.deepseek.com" */
  upstream: string;
  /** 最近一条 user 指令原文（截断后） */
  lastUserInstruction: string;
  /** 最近 5 条 user 指令（按原顺序） */
  userInstructions: string[];
  /** 本次会话出现过的工具名集合 */
  toolNames: string[];
  /** 出现过的本地文件路径，去重后保留最近 20 条 */
  touchedFiles: string[];
  /** 最后一条 assistant 文本摘要（截断后） */
  lastAssistantSummary: string;
  /** 捕获时的输入 token（未判定则为 0） */
  inputTokensAtCapture: number;
}

/** 形态A即时摘要卡的字段结构（渲染成纯文本由 card.ts 负责） */
export interface HealthCard {
  /** 本进程内第几次请求，从 1 开始 */
  requestIndex: number;
  /** 命中的本地路由前缀，例如 "/deepseek" */
  routePrefix: string;
  /** 上游展示名，例如 "DeepSeek" */
  upstreamLabel: string;
  /** 上游 host */
  upstreamHost: string;
  /** wire 方言 */
  vendor: Vendor;
  /** 输入 token；未判定时为 null */
  inputTokens: number | null;
  /** 命中 token；未判定时为 null */
  cachedTokens: number | null;
  /** 命中率 0~1；未判定时为 null */
  hitRatio: number | null;
  /** 是否已判定 */
  judged: boolean;
  /** 本次做了什么（一行，纯规则拼装） */
  didWhat: string;
  /** 本轮前缀诊断；未启用或未判定时为 null */
  prefix?: PrefixDiag | null;
  /** 本轮流式 usage 注入结果；不适用时为 null（卡上不出这一行） */
  usageInject?: UsageInjectNote | null;
  /** 首屏横幅专用：客户端 baseURL 该填的完整地址（如 http://127.0.0.1:27880/deepseek）；请求卡不带此字段 */
  entryUrl?: string | null;
}

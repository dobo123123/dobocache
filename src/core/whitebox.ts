/**
 * DoboCache whitebox — 白盒日志模块（v0.4.1 产品差异化核心）
 *
 * 每次调用的「白盒报告」+ cf_report 累计统计。
 * 设计原则：
 *   - 白盒日志写入本地日志文件（<日志目录>/dobocache-<date>.log.jsonl，JSONL 追加），
 *     不占对话 token；日志目录默认取平台标准可写目录（见 utils/logDir.ts），
 *     不再依赖进程 cwd，MCP 客户端以任意工作目录拉起都能写对位置；
 *   - 单次报告记录：原始 token / 优化后 token / 预计命中 token 与命中率 /
 *     本次做了什么（前缀稳定化、去重、动态内容移至末尾等变更明细）；
 *   - 形态 A 即时摘要：formatReportCard 把单次报告排版为固定格式对齐文本块，
 *     随 cf_judge / cf_inject 返回直接可见；
 *   - 累计统计：今日（按自然日滚动）与进程内累计（调用次数、命中率、预计命中）。
 *   - v0.4.4 隐私脱敏：日志落盘前把 requestId / sessionId 统一替换为无内容语义的短标识
 *     （req-xxxxxxxx / sid-xxxxxxxx），并追加 reqIndex 递增请求序号；日志中永不出现用户 prompt 原文。
 *   - v0.4.6 三项口径修正：
 *     ① 卡片默认关闭（cardMode=quiet），只有显式设置 DOBOCACHE_WHITEBOX=once/always 才随工具返回；
 *        首次运行出一次"引入提示"卡片，之后不再打扰。
 *     ② hitRate 语义收敛为"厂商 usage 回传的真实命中率"，取不到时记 null（未判定），
 *        绝不用本地命中判定/前缀复用比例冒充命中率，也不再落盘 0 造成"0% 命中"的假象。
 *     ③ 对外术语废除"轮"：日志字段 round 改名 reqIndex，含义是"本机进程内第几次请求"，与对话阶段无关。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ensureRequestId, ensureSessionId } from "../utils/privacy.js";
import { resolveLogDir, type LogDirSource } from "../utils/logDir.js";

/**
 * 报告署名（v0.4.7+）
 *
 * 白盒报告尾部固定标注工具名 + 版本 + 仓库地址，让用户把报告贴到群里、贴进 issue 时
 * 链接能跟着走。
 *   - 版本从 package.json 动态读取，升级版本无需再改这里；读不到时回退常量（不抛错）；
 *   - 只在报告文本里多一行，不联网、不上报，不改变任何统计口径与缓存行为；
 *   - 署名行不写入 JSONL 日志（日志仍是纯数据，不带任何额外文本）。
 */
export const REPORT_REPO_URL = "github.com/dobo123123/dobocache";
/** 读不到 package.json 时的兜底版本（与 package.json 手动保持一致即可） */
const SIGNATURE_VERSION_FALLBACK = "0.4.7";
const SIGNATURE_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    const v = typeof pkg.version === "string" ? pkg.version.trim() : "";
    return v !== "" ? v : SIGNATURE_VERSION_FALLBACK;
  } catch {
    return SIGNATURE_VERSION_FALLBACK;
  }
})();

/** 报告署名行文本（导出便于测试断言与文档引用） */
export function reportSignatureLine(): string {
  return `DoboCache v${SIGNATURE_VERSION} · 全本地生成 · ${REPORT_REPO_URL}`;
}

/** 单次变更明细条目 */
export interface WhiteboxChange {
  /** 变更类型标识：prefix-stabilize / dedup / volatile-tail / align128 / topup / scenario / judge-hit / judge-miss */
  kind: string;
  /** 人类可读说明 */
  label: string;
  /** 补充细节（数量、示例等），可选 */
  detail?: string;
}

/** 单次调用白盒报告 */
export interface SavingsReport {
  /** v0.4.4：日志中为脱敏标识（req-xxxxxxxx）；内存态为调用方传入值 */
  requestId: string;
  /** 本地时间戳（ms） */
  ts: number;
  /** v0.4.4：请求序号（本机进程内递增，含义是"第几次请求"，与对话阶段无关；脱敏后仍可做请求级对照） */
  reqIndex?: number;
  /** v0.4.4：本次请求的用户输入字符数（仅长度，无任何内容语义） */
  promptChars?: number;
  /** 原始输入 token（优化前估算） */
  rawTokens: number;
  /** 优化后 token（注入后估算 / judge 场景为原值） */
  optimizedTokens: number;
  /**
   * 缓存命中率（0-100），口径唯一：只认厂商 usage 回传的 hitTokens/missTokens。
   * null = 未判定（本机拿不到厂商 usage），此时不计入任何均值，也不写成 0 冒充"命中率 0%"。
   */
  hitRate: number | null;
  /** 厂商 usage 命中 tokens（可选） */
  hitTokens?: number;
  /** 厂商 usage 未命中 tokens（可选） */
  missTokens?: number;
  /** 节省 token = raw - optimized */
  savedTokens: number;
  /** 节省比例（0-100） */
  savedPct: number;
  /** 节省估算（按命中/未命中两个计价系数折算的相对值，系数由配置注入，非货币金额；字段名保留兼容） */
  /** 按未命中/命中计价系数之差折算的相对值（非货币金额；字段名为历史兼容保留） */
  savedUsd: number;
  /** 本次做了什么（变更明细） */
  changes: WhiteboxChange[];
  /** 备注（可选） */
  note?: string;
  /** v0.4.2：会话标识（cf_inject 场景） */
  sessionId?: string;
  /** v0.4.2：场景（first/full） */
  scenario?: string;
  /** v0.4.2：注入模式（frozen=冻结复用 / rebuild=重建；judge 场景缺省） */
  mode?: string;
  /** v0.4.2：128 对齐追加块数 */
  alignBlocks?: number;
  /** v0.4.2：前缀 tokens（含对齐块） */
  prefixTokens?: number;
}

/** 累计统计块（今日 / 累计共用结构） */
export interface WhiteboxStats {
  /** 调用次数（含未判定命中率的调用） */
  calls: number;
  /** 命中率均值（仅统计拿到厂商 usage 的调用；judgedCalls=0 时为 null） */
  hitRate: number | null;
  /** 命中率样本数（拿到厂商 usage 的调用次数），用于判断 hitRate 是否可信 */
  judgedCalls: number;
  rawTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  savedPct: number;
  /** 按未命中/命中计价系数之差折算的相对值（非货币金额；字段名为历史兼容保留） */
  savedUsd: number;
}

/**
 * v0.4.6 白盒卡片投放档位。
 * 卡片本身要占对话 token（每张约 300+），默认关闭；需要看详情时再按需打开。
 */
export type CardMode = "quiet" | "once" | "always";

/**
 * 日志保留策略（v0.4.7 缺口2：轮转 + 保留期）
 *
 * 背景：v0.4.6 之前 JSONL 只追加、不轮转、不清理，长期使用会让单个日志文件无限增长
 * （白盒是"长期本地跑"的功能，一天几千次调用就会到几十 MB）。这里给出一条确定性的
 * 硬策略，全部由本机执行，不联网、不上报：
 *   - 单文件超过上限（默认 10MB，DOBOCACHE_LOG_MAX_MB 可调）→ 滚动为 .1，旧的 .1→.2，
 *     最多保留 3 个轮转副本，更旧的直接删除；
 *   - 主文件按自然日命名，超过保留天数（默认 7 天，DOBOCACHE_LOG_KEEP_DAYS 可调）的
 *     日志文件（含轮转副本）在当天首次写入时清理掉。
 * 任何一步失败都不影响主流程：白盒是增强能力，缓存功能不会因为清理失败而中断。
 */
export const LOG_MAX_MB_ENV = ["DOBOCACHE_LOG_MAX_MB"] as const;
export const LOG_KEEP_DAYS_ENV = ["DOBOCACHE_LOG_KEEP_DAYS"] as const;
/** 单文件上限默认值（MB） */
export const DEFAULT_LOG_MAX_MB = 10;
/** 保留天数默认值（含今天） */
export const DEFAULT_LOG_KEEP_DAYS = 7;
/** 轮转副本个数（.1 / .2 / .3） */
export const LOG_ROLL_KEEP = 3;

/** 日志文件名解析结果：roll=0 表示当日主文件，1..N 表示轮转副本 */
export interface LogFileInfo {
  fileName: string;
  date: string;
  roll: number;
}

const LOG_FILE_RE = /^dobocache-(\d{4}-\d{2}-\d{2})\.log\.jsonl(?:\.(\d+))?$/;

/** 解析日志文件名；非本模块生成的文件返回 null（清理时绝不碰用户自己的文件） */
export function parseLogFileName(fileName: string): LogFileInfo | null {
  const m = LOG_FILE_RE.exec(fileName);
  if (!m) return null;
  return { fileName, date: m[1], roll: m[2] ? Number(m[2]) : 0 };
}

/**
 * 读取正整数环境变量配置：缺省用 fallback；写了但非法（非数字 / ≤0 / 超范围）时
 * 回退 fallback 并推一条 hint 到 warnings，避免"我设了却不生效"却毫无线索。
 */
export function resolvePositiveIntEnv(
  keys: readonly string[],
  fallback: number,
  max: number,
  warnings: string[],
): number {
  const raw = keys.map((k) => process.env[k]).find((v) => v !== undefined && v.trim() !== "");
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) {
    warnings.push(`环境变量 ${keys[0]} 的值 "${raw}" 无法识别（需 1-${max} 的整数），已回退为默认值 ${fallback}。`);
    return fallback;
  }
  return n;
}

/** 一次日志维护（轮转 / 过期清理）的结果；供 cf_report 自查，也便于测试断言 */
export interface LogMaintenance {
  /** 维护发生时间（ms） */
  at: number;
  /** 本次发生滚动的主文件名（滚动成 .1 的那些） */
  rolled: string[];
  /** 本次被删除的过期文件名 */
  pruned: string[];
  /** 失败项（目录不可读、删除被占用等）；有值不影响主流程，仅记录 */
  errors: string[];
}

/** 日志保留策略的当前生效值（cf_report 展示，便于用户判断磁盘占用预期） */
export interface LogPolicy {
  maxBytes: number;
  keepDays: number;
  rollKeep: number;
}

/** 本地自然日字符串（YYYY-MM-DD，按本机时区，与日志文件名一致） */
function localDateStr(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 环境变量名（新旧两个都认，便于老用户平滑过渡） */
export const CARD_MODE_ENV = ["DOBOCACHE_WHITEBOX", "CACHEFORGE_WHITEBOX"] as const;

/**
 * 把环境变量值解析为 cardMode。
 * 容忍大小写与首尾空格；写错（拼错/空串/未知值）时不抛错、回退 quiet 并返回一条提示，
 * 避免用户以为"我开了开关却没生效"却毫无线索。
 */
export function resolveCardMode(raw: string | undefined): { mode: CardMode; warning?: string } {
  if (raw === undefined) return { mode: "quiet" };
  const v = raw.trim().toLowerCase();
  if (v === "") return { mode: "quiet" };
  if (v === "quiet" || v === "off" || v === "0" || v === "false") return { mode: "quiet" };
  if (v === "once" || v === "1" || v === "true") return { mode: "once" };
  if (v === "always" || v === "on") return { mode: "always" };
  return {
    mode: "quiet",
    warning: `环境变量 ${CARD_MODE_ENV[0]} 的值 "${raw}" 无法识别（可选 quiet / once / always），已回退为 quiet（不附带白盒卡片）。`,
  };
}

export interface WhiteboxOptions {
  /** 日志目录（默认取平台标准可写目录，见 utils/logDir.ts；显式传入时优先），仅存本机，不随包分发 */
  logDir?: string;
  /** 是否写入日志文件（默认 true；测试可关） */
  fileWrite?: boolean;
  /**
   * v0.4.6 白盒卡片投放档位（默认 quiet）：
   *   quiet  = 不随工具返回附带卡片，只写本地日志（默认，省 token）
   *   once   = 下一次调用带一张卡，之后自动回落到 quiet
   *   always = 每次调用都带卡（排查/演示用，每张约 300+ tokens）
   */
  cardMode?: CardMode;
  /** 命中缓存的计价系数（每百万 tokens 的系数），由调用方注入，默认值仅为占位量级，非货币金额 */
  hitPricePerM?: number;
  /** 未命中缓存的计价系数（每百万 tokens 的系数），由调用方注入，默认值仅为占位量级，非货币金额 */
  missPricePerM?: number;
  /** v0.4.2：聚合维度（total=进程内累计 / per_session=按会话分组，默认 total） */
  aggregateBy?: "total" | "per_session";
  /** v0.4.7：单个日志文件上限（MB），默认 DEFAULT_LOG_MAX_MB；DOBOCACHE_LOG_MAX_MB 可覆盖 */
  logMaxMb?: number;
  /** v0.4.7：日志保留天数（含今天），默认 DEFAULT_LOG_KEEP_DAYS；DOBOCACHE_LOG_KEEP_DAYS 可覆盖 */
  logKeepDays?: number;
}

/**
 * v0.4.4 日志脱敏：按白名单字段构造落盘记录
 * - requestId → req-xxxxxxxx（加盐短哈希，同文同指纹，不可反推原文）
 * - sessionId → sid-xxxxxxxx
 * - 追加 reqIndex 递增请求序号 + promptChars 长度，保留请求级对照能力而丢弃全部内容语义
 * 白名单构造可确保以后新增字段即使携带原文也不会被写入日志。
 */
export function sanitizeForLog(report: SavingsReport, reqIndex?: number): SavingsReport {
  return {
    requestId: ensureRequestId(report.requestId),
    ts: report.ts,
    reqIndex: reqIndex ?? report.reqIndex,
    promptChars: report.promptChars,
    rawTokens: report.rawTokens,
    optimizedTokens: report.optimizedTokens,
    hitRate: report.hitRate,
    hitTokens: report.hitTokens,
    missTokens: report.missTokens,
    savedTokens: report.savedTokens,
    savedPct: report.savedPct,
    savedUsd: report.savedUsd,
    changes: (report.changes ?? []).map((c) => ({ kind: c.kind, label: c.label, detail: c.detail })),
    note: report.note,
    sessionId: report.sessionId ? ensureSessionId(report.sessionId) : undefined,
    scenario: report.scenario,
    mode: report.mode,
    alignBlocks: report.alignBlocks,
    prefixTokens: report.prefixTokens,
  };
}

/** 轻量重复行检测：返回文本中重复出现的非空行（用于「去重」变更明细） */
export function detectDuplicateLines(text: string): { count: number; lines: string[] } {
  const lines: string[] = [];
  const seen = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    if (n === 1) lines.push(line);
  }
  return { count: lines.length, lines };
}

/** 千分位格式化（不依赖 locale，保持对齐稳定） */
export function fmtNumber(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 形态 A 即时摘要：把单次白盒报告排版为固定格式的对齐文本块。
 * cf_judge / cf_inject 返回时自动附带此卡片，让客户端对话里直接可见。
 * 纯字符串拼接，不引入悬浮窗 / 按钮 / UI 依赖，不改变工具调用方式。
 */
export function formatReportCard(report: SavingsReport): string {
  const label = (s: string) => s.padEnd(10, " ");
  const lines: string[] = [];
  lines.push("── DoboCache 白盒报告 ───────────────────────────────");
  lines.push(`${label("原始 token")}: ${fmtNumber(report.rawTokens)}`);
  lines.push(`${label("优化后 token")}: ${fmtNumber(report.optimizedTokens)}`);
  // 命中率只有一个口径：厂商 usage 回传的 hitTokens/missTokens。
  // 拿不到就如实写"未判定"，不用本地前缀复用比例充数（v0.4.6）。
  if (report.hitRate !== null) {
    const hitTokens = report.hitTokens ?? report.savedTokens;
    lines.push(`${label("预计命中")}: ${fmtNumber(hitTokens)} tokens（命中率 ${report.hitRate.toFixed(1)}%）`);
  } else {
    lines.push(`${label("命中率")}: 未判定（本机未回传厂商 usage，不计入任何均值）`);
  }
  if (report.changes.length > 0) {
    lines.push(`${label("本次做了什么")}:`);
    for (const c of report.changes) {
      const detail = c.detail ? `（${c.detail}）` : "";
      lines.push(`  · ${c.label}${detail}`);
    }
  }
  if (report.note) {
    lines.push(`${label("备注")}: ${report.note}`);
  }
  lines.push("────────────────────────────────────────────────────");
  lines.push(reportSignatureLine());
  return lines.join("\n");
}

/**
 * 白盒日志器：累计今日/进程统计，并把每次报告追加到本地 JSONL 日志。
 * 不参与任何 LLM 调用，本地纯计数，零额外 token 成本。
 */
export class WhiteboxLogger {
  private readonly logDir: string;
  private fileWrite: boolean;
  /** 日志目录来源：env（环境变量）/ platform（平台标准目录）/ cwd（回退）/ disabled（无法落盘） */
  readonly logDirSource: LogDirSource;
  /** 初始化日志目录时的降级说明（调用方可打到 stderr，提醒但不影响主流程） */
  readonly logWarnings: string[];
  private readonly hitPricePerM: number;
  private readonly missPricePerM: number;
  private aggregateBy: "total" | "per_session";
  /** v0.4.6：白盒卡片投放档位（默认 quiet，不往上下文塞卡片） */
  private cardMode: CardMode;
  /** v0.4.6：是否已确认过"首次引入提示"（进程内只确认一次，避免反复读盘） */
  private welcomeChecked = false;
  /** v0.4.7 缺口2：单个日志文件上限（字节），超过即滚动 */
  private readonly logMaxBytes: number;
  /** v0.4.7 缺口2：日志保留天数（含今天） */
  private readonly logKeepDays: number;
  /** v0.4.7 缺口2：当天是否已执行过过期清理（每天最多扫一次目录） */
  private lastPruneDate = "";
  /** v0.4.7 缺口2：最近一次维护动作，供 cf_report 自查 */
  private lastMaintenance: LogMaintenance | null = null;

  // 今日（自然日）统计
  private todayDate = "";
  private today = this.zeroStats();
  private todayHitRateSum = 0;
  // 进程内累计统计
  private total = this.zeroStats();
  private totalHitRateSum = 0;
  /** v0.4.6：请求序号（每次 record 递增；含义是本机第几次请求，与对话阶段无关） */
  private seq = 0;
  /** 写盘失败只提示一次，避免刷屏 */
  private writeFailWarned = false;
  // v0.4.2：按会话聚合（sessionId → 累计）
  private readonly perSession = new Map<string, { stats: WhiteboxStats; hitRateSum: number }>();

  constructor(opts: WhiteboxOptions = {}) {
    // 日志目录不再依赖 cwd：显式目录 > 平台标准可写目录 > <cwd>/data/logs > 不落盘。
    // 任何一级失败都不抛错，仅记录 warnings，由入口打到 stderr。
    const resolved = resolveLogDir({ explicitDir: opts.logDir, enabled: opts.fileWrite ?? true });
    this.logDir = resolved.dir;
    this.logDirSource = resolved.source;
    this.logWarnings = resolved.warnings;
    this.fileWrite = (opts.fileWrite ?? true) && !resolved.disabled;
    this.hitPricePerM = opts.hitPricePerM ?? 0.014;
    this.missPricePerM = opts.missPricePerM ?? 0.5;
    this.aggregateBy = opts.aggregateBy ?? "total";
    // v0.4.6：卡片档位。显式传入优先；否则读环境变量；都没有则默认 quiet（不添 token 负担）。
    if (opts.cardMode) {
      this.cardMode = opts.cardMode;
    } else {
      const rawEnv = CARD_MODE_ENV.map((k) => process.env[k]).find((v) => v !== undefined && v.trim() !== "");
      const parsed = resolveCardMode(rawEnv);
      this.cardMode = parsed.mode;
      if (parsed.warning) this.logWarnings.push(parsed.warning);
    }

    // v0.4.7 缺口2：日志轮转与保留期。优先级：显式传入 > 环境变量 > 默认值。
    // 上限做硬约束（1024MB / 365 天），防止误配成天文数字把磁盘拖爆，或配成 0 把日志一次全清。
    const maxMb =
      typeof opts.logMaxMb === "number" && Number.isFinite(opts.logMaxMb) && opts.logMaxMb > 0
        ? Math.min(opts.logMaxMb, 1024)
        : resolvePositiveIntEnv(LOG_MAX_MB_ENV, DEFAULT_LOG_MAX_MB, 1024, this.logWarnings);
    this.logMaxBytes = Math.max(1, Math.round(maxMb * 1024 * 1024));
    this.logKeepDays =
      typeof opts.logKeepDays === "number" && Number.isInteger(opts.logKeepDays) && opts.logKeepDays > 0
        ? Math.min(opts.logKeepDays, 365)
        : resolvePositiveIntEnv(LOG_KEEP_DAYS_ENV, DEFAULT_LOG_KEEP_DAYS, 365, this.logWarnings);
  }

  /** 当前生效的日志保留策略（cf_report 展示） */
  get logPolicy(): LogPolicy {
    return { maxBytes: this.logMaxBytes, keepDays: this.logKeepDays, rollKeep: LOG_ROLL_KEEP };
  }

  /** 最近一次维护动作（未发生过则为 null） */
  get lastMaintenanceInfo(): LogMaintenance | null {
    return this.lastMaintenance;
  }

  private zeroStats(): WhiteboxStats {
    return { calls: 0, hitRate: null, judgedCalls: 0, rawTokens: 0, optimizedTokens: 0, savedTokens: 0, savedPct: 0, savedUsd: 0 };
  }

  /** 当前卡片档位（cf_report 可展示，便于用户自查为什么看不到卡片） */
  get cardModeValue(): CardMode {
    return this.cardMode;
  }

  /** 当前聚合维度（cf_report 读盘聚合时复用同一维度，保证两种来源口径一致） */
  get aggregateByValue(): "total" | "per_session" {
    return this.aggregateBy;
  }

  /** 首次引入提示卡片的标记文件（落在日志目录内，与日志同生共死；不落盘时不写） */
  private welcomeMarkerFile(): string {
    return path.join(this.logDir, ".welcomed");
  }

  /**
   * v0.4.6：本次工具返回是否附带白盒卡片。
   * 判定顺序：
   *   1) 本机首次运行（日志目录下无 .welcomed 标记）→ 出一次"引入提示"卡，并落标记，永不重复；
   *   2) 之后按 cardMode：quiet 不出 / once 出一次后回落 quiet / always 每次都出。
   * 卡片要占对话 token，因此默认不出；用户想看详情时自行设 DOBOCACHE_WHITEBOX=once|always。
   */
  shouldEmitCard(): { emit: boolean; welcome: boolean } {
    // ① 首次引入提示（只在能写盘时用标记文件判定，读写失败一律当作已提示，避免每次刷屏）
    if (!this.welcomeChecked) {
      this.welcomeChecked = true;
      if (this.fileWrite) {
        try {
          const marker = this.welcomeMarkerFile();
          if (!fs.existsSync(marker)) {
            fs.mkdirSync(this.logDir, { recursive: true });
            fs.writeFileSync(marker, new Date().toISOString(), "utf-8");
            return { emit: true, welcome: true };
          }
        } catch {
          // 标记文件不可用时静默降级到 cardMode 判定，不影响主流程
        }
      }
    }
    // ② 按档位投放
    if (this.cardMode === "always") return { emit: true, welcome: false };
    if (this.cardMode === "once") {
      this.cardMode = "quiet";
      return { emit: true, welcome: false };
    }
    return { emit: false, welcome: false };
  }

  /** 首次引入提示卡的额外一行说明（告诉用户卡片可关、怎么看累计） */
  static readonly WELCOME_HINT =
    "提示：白盒报告会占对话 token，默认只在本地写日志、不再随调用返回；想每次看到就设 DOBOCACHE_WHITEBOX=always，只看一次设 once，关掉设 quiet。累计数据随时可用 cf_report 查看（不产生额外 token）。";

  /** 当前日志文件绝对路径（按报告时间戳滚动） */
  logFileFor(ts: number): string {
    return path.join(this.logDir, `dobocache-${localDateStr(ts)}.log.jsonl`);
  }

  /**
   * v0.4.7 缺口2：日志维护（保留期清理 + 超限滚动）。
   * 设计约束：
   *   - 只处理本模块自己命名的文件（dobocache-YYYY-MM-DD.log.jsonl[.N]），目录里其它文件一律不碰；
   *   - 过期清理默认每天最多执行一次（lastPruneDate 门闩），滚动检查在每次写盘前都做（成本是一次 stat）；
   *   - 任何失败都吞掉并记进 errors，不影响写日志，更不影响缓存主流程。
   * @param nowTs 参考时间（测试可注入，便于构造跨日/过期场景）
   * @param force 忽略"每天一次"门闩，强制清理（测试与手工排查用）
   */
  runLogMaintenance(nowTs: number = Date.now(), force = false): LogMaintenance {
    const rolled: string[] = [];
    const pruned: string[] = [];
    const errors: string[] = [];

    // ① 过期清理：保留 [today-(keepDays-1), today] 这些自然日，更早的删掉
    const today = localDateStr(nowTs);
    if (force || this.lastPruneDate !== today) {
      this.lastPruneDate = today;
      try {
        const cutoff = localDateStr(nowTs - (this.logKeepDays - 1) * 86400000);
        for (const entry of fs.readdirSync(this.logDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const info = parseLogFileName(entry.name);
          if (!info) continue;
          // YYYY-MM-DD 定长格式，字符串比较等价于日期比较
          if (info.date >= cutoff) continue;
          try {
            fs.unlinkSync(path.join(this.logDir, entry.name));
            pruned.push(entry.name);
          } catch (err) {
            errors.push(`${entry.name}: ${(err as NodeJS.ErrnoException)?.code ?? "UNKNOWN"}`);
          }
        }
      } catch (err) {
        errors.push(`readdir: ${(err as NodeJS.ErrnoException)?.code ?? "UNKNOWN"}`);
      }
    }

    // ② 超限滚动：主文件达到上限，就把历史副本整体后移，最多保留 LOG_ROLL_KEEP 份
    try {
      const main = this.logFileFor(nowTs);
      const size = fs.existsSync(main) ? fs.statSync(main).size : 0;
      if (size >= this.logMaxBytes) {
        const oldest = `${main}.${LOG_ROLL_KEEP}`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let i = LOG_ROLL_KEEP - 1; i >= 1; i -= 1) {
          const from = `${main}.${i}`;
          if (fs.existsSync(from)) fs.renameSync(from, `${main}.${i + 1}`);
        }
        fs.renameSync(main, `${main}.1`);
        rolled.push(path.basename(main));
      }
    } catch (err) {
      errors.push(`roll: ${(err as NodeJS.ErrnoException)?.code ?? "UNKNOWN"}`);
    }

    const result: LogMaintenance = { at: nowTs, rolled, pruned, errors };
    if (rolled.length > 0 || pruned.length > 0 || errors.length > 0) this.lastMaintenance = result;
    return result;
  }

  /** 追加一条白盒报告：累计统计 + 写本地日志文件（不占对话 token） */
  record(report: SavingsReport): void {
    const date = localDateStr(report.ts);
    if (this.todayDate !== date) {
      this.todayDate = date;
      this.today = this.zeroStats();
    }

    this.today.calls += 1;
    this.today.rawTokens += report.rawTokens;
    this.today.optimizedTokens += report.optimizedTokens;
    this.today.savedTokens += report.savedTokens;
    this.today.savedUsd += report.savedUsd;
    this.total.calls += 1;
    this.total.rawTokens += report.rawTokens;
    this.total.optimizedTokens += report.optimizedTokens;
    this.total.savedTokens += report.savedTokens;
    this.total.savedUsd += report.savedUsd;

    // v0.4.6：命中率只统计拿到厂商 usage 的调用；未判定的调用计入 calls 但不进均值
    if (report.hitRate !== null) {
      this.today.judgedCalls += 1;
      this.total.judgedCalls += 1;
      this.todayHitRateSum += report.hitRate;
      this.totalHitRateSum += report.hitRate;
    }
    this.refreshStats(this.today, this.todayHitRateSum);
    this.refreshStats(this.total, this.totalHitRateSum);

    // v0.4.2：按会话聚合
    if (report.sessionId) {
      let entry = this.perSession.get(report.sessionId);
      if (!entry) {
        entry = { stats: this.zeroStats(), hitRateSum: 0 };
        this.perSession.set(report.sessionId, entry);
      }
      entry.stats.calls += 1;
      entry.stats.rawTokens += report.rawTokens;
      entry.stats.optimizedTokens += report.optimizedTokens;
      entry.stats.savedTokens += report.savedTokens;
      entry.stats.savedUsd += report.savedUsd;
      if (report.hitRate !== null) {
        entry.stats.judgedCalls += 1;
        entry.hitRateSum += report.hitRate;
      }
      this.refreshStats(entry.stats, entry.hitRateSum);
    }

    if (this.fileWrite) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
        // v0.4.7 缺口2：写盘前先做维护（过期清理每天一次、超限滚动每次检查）。
        // 维护内部已吞掉所有异常，这里不额外 try，避免把"清理失败"误判成"写日志失败"。
        this.runLogMaintenance(report.ts);
        // v0.4.4 隐私脱敏：落盘前把 requestId / sessionId 换成无内容语义的短标识，并写入请求序号
        this.seq += 1;
        const safe = sanitizeForLog(report, this.seq);
        fs.appendFileSync(this.logFileFor(report.ts), `${JSON.stringify(safe)}\n`, "utf-8");
      } catch (err) {
        // 日志落盘失败不阻断主流程（白盒是增强而非依赖）：仅首次提醒一句到 stderr
        if (!this.writeFailWarned) {
          this.writeFailWarned = true;
          this.fileWrite = false;
          const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
          console.error(`[dobocache] 日志写入失败（${code}）：${this.logDir}；本次运行不再写日志文件，缓存功能不受影响`);
        }
      }
    }
  }

  /**
   * 累计命中率 = 各次「已判定」调用命中率的 token 加权均值（四舍五入到 0.1）；
   * judgedCalls=0（一次厂商 usage 都没拿到）时为 null，而不是 0，避免"0% 命中"的误读（v0.4.6）。
   * 节省比例 = savedTokens / rawTokens。
   */
  private refreshStats(stats: WhiteboxStats, hitRateSum: number): void {
    stats.hitRate = stats.judgedCalls > 0 ? Math.round((hitRateSum / stats.judgedCalls) * 10) / 10 : null;
    stats.savedPct = stats.rawTokens > 0 ? Math.round((stats.savedTokens / stats.rawTokens) * 10000) / 100 : 0;
  }

  /** 构造单次报告（统一口径：raw - optimized = saved；节省估算按命中/未命中两个计价系数之差优先） */
  buildReport(input: {
    requestId: string;
    ts?: number;
    /** v0.4.4：本次请求的用户输入字符数（仅长度，不记录内容） */
    promptChars?: number;
    rawTokens: number;
    optimizedTokens: number;
    /** 命中率（0-100）；不传则按 hitTokens/missTokens 计算；两者都没有时判为"未判定"（null） */
    hitRate?: number | null;
    hitTokens?: number;
    missTokens?: number;
    changes: WhiteboxChange[];
    note?: string;
    sessionId?: string;
    scenario?: string;
    mode?: string;
    alignBlocks?: number;
    prefixTokens?: number;
  }): SavingsReport {
    const ts = input.ts ?? Date.now();
    const raw = Math.max(0, Math.round(input.rawTokens));
    const optimized = Math.max(0, Math.round(input.optimizedTokens));
    const savedTokens = Math.max(0, raw - optimized);
    const savedPct = raw > 0 ? Math.round((savedTokens / raw) * 10000) / 100 : 0;
    let savedUsd: number;
    if (input.hitTokens && input.hitTokens > 0) {
      savedUsd = (input.hitTokens * (this.missPricePerM - this.hitPricePerM)) / 1_000_000;
    } else {
      savedUsd = (savedTokens * this.missPricePerM) / 1_000_000;
    }
    savedUsd = Math.round(savedUsd * 1_000_000) / 1_000_000;
    // v0.4.6：命中率口径唯一 —— 只认厂商 usage 回传的 hitTokens/missTokens（或调用方显式给的离线复算值）。
    // 两者都拿不到时判为"未判定"（null），绝不写 0：0% 和"没测到"是两件事，混为一谈会误导读者。
    let hitRate: number | null;
    if (input.hitRate !== undefined && input.hitRate !== null) {
      hitRate = Math.round(input.hitRate * 10) / 10;
    } else if (
      input.hitTokens !== undefined &&
      input.missTokens !== undefined &&
      input.hitTokens + input.missTokens > 0
    ) {
      hitRate = Math.round((input.hitTokens / (input.hitTokens + input.missTokens)) * 1000) / 10;
    } else {
      hitRate = null;
    }
    return {
      requestId: input.requestId,
      ts,
      promptChars: input.promptChars,
      rawTokens: raw,
      optimizedTokens: optimized,
      hitRate,
      hitTokens: input.hitTokens,
      missTokens: input.missTokens,
      savedTokens,
      savedPct,
      savedUsd,
      changes: input.changes,
      note: input.note,
      sessionId: input.sessionId,
      scenario: input.scenario,
      mode: input.mode,
      alignBlocks: input.alignBlocks,
      prefixTokens: input.prefixTokens,
    };
  }

  /** 输出累计统计（cf_report 用）；v0.4.2：按 aggregateBy 输出聚合维度；v0.4.6 附带卡片档位 */
  report(): {
    today: WhiteboxStats;
    total: WhiteboxStats;
    perSession?: Array<{ sessionId: string; stats: WhiteboxStats }>;
    logDir: string;
    logFile: string;
    cardMode: CardMode;
    welcomeShown: boolean;
    logPolicy: LogPolicy;
    logMaintenance: LogMaintenance | null;
  } {
    const perSession =
      this.aggregateBy === "per_session"
        ? [...this.perSession.entries()].map(([sessionId, entry]) => ({ sessionId, stats: { ...entry.stats } }))
        : undefined;
    return {
      today: { ...this.today },
      total: { ...this.total },
      perSession,
      logDir: this.logDir,
      logFile: this.logFileFor(Date.now()),
      cardMode: this.cardMode,
      welcomeShown: this.welcomeChecked,
      logPolicy: this.logPolicy,
      logMaintenance: this.lastMaintenance,
    };
  }

  /** 运行时切换聚合维度（cf_report 可临时按会话聚合） */
  setAggregateBy(mode: "total" | "per_session"): void {
    this.aggregateBy = mode;
  }

  /**
   * v0.4.7 缺口3：从本地 JSONL 日志重新聚合统计（跨进程、跨天）。
   *
   * 之前 cf_report 只报"当前进程内累计"，MCP 客户端一重启就归零；历史数据明明躺在磁盘上
   * 却读不回来，用户看到 0 会误以为白盒没工作。这里把磁盘日志当作事实来源重算一遍。
   *
   * 口径与内存态严格一致（不新造指标）：
   *   calls / rawTokens / optimizedTokens / savedTokens / savedUsd 直接累加；
   *   hitRate 只对 hitRate !== null 的行走算术均值（分母 judgedCalls），一行都没判定就是 null。
   * 解析失败的行计入 skippedLines 而不会中断整次聚合（日志可能被外部截断）。
   */
  aggregateFromDisk(opts: { days?: number; perSession?: boolean } = {}): {
    source: "disk";
    days: number;
    sinceDate: string;
    files: number;
    lines: number;
    skippedLines: number;
    stats: WhiteboxStats;
    perSession?: Array<{ sessionId: string; stats: WhiteboxStats }>;
    logDir: string;
    logPolicy: LogPolicy;
    logMaintenance: LogMaintenance | null;
  } {
    const days = Math.min(Math.max(Math.round(opts.days ?? this.logKeepDays), 1), 365);
    const now = Date.now();
    const sinceDate = localDateStr(now - (days - 1) * 86400000);

    const stats = this.zeroStats();
    let hitRateSum = 0;
    const sessionAgg = opts.perSession ? new Map<string, { stats: WhiteboxStats; hitRateSum: number }>() : null;
    let files = 0;
    let lines = 0;
    let skippedLines = 0;

    // 只读保留期内的、本模块命名的文件；按 日期 → 副本序号 排序，保证输出稳定
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(this.logDir)
        .map((n) => parseLogFileName(n))
        .filter((i): i is LogFileInfo => i !== null && i.date >= sinceDate)
        .sort((a, b) => (a.date === b.date ? a.roll - b.roll : a.date < b.date ? -1 : 1))
        .map((i) => i.fileName);
    } catch {
      names = [];
    }

    for (const name of names) {
      let content = "";
      try {
        content = fs.readFileSync(path.join(this.logDir, name), "utf-8");
      } catch {
        skippedLines += 1;
        continue;
      }
      files += 1;
      for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        lines += 1;
        let row: SavingsReport;
        try {
          row = JSON.parse(line) as SavingsReport;
        } catch {
          skippedLines += 1;
          continue;
        }
        const rawTokens = Number(row.rawTokens) || 0;
        const optimizedTokens = Number(row.optimizedTokens) || 0;
        const savedTokens = Number(row.savedTokens) || 0;
        const savedUsd = Number(row.savedUsd) || 0;
        const hitRate = typeof row.hitRate === "number" ? row.hitRate : null;

        stats.calls += 1;
        stats.rawTokens += rawTokens;
        stats.optimizedTokens += optimizedTokens;
        stats.savedTokens += savedTokens;
        stats.savedUsd += savedUsd;
        if (hitRate !== null) {
          stats.judgedCalls += 1;
          hitRateSum += hitRate;
        }

        if (sessionAgg && row.sessionId) {
          let entry = sessionAgg.get(row.sessionId);
          if (!entry) {
            entry = { stats: this.zeroStats(), hitRateSum: 0 };
            sessionAgg.set(row.sessionId, entry);
          }
          entry.stats.calls += 1;
          entry.stats.rawTokens += rawTokens;
          entry.stats.optimizedTokens += optimizedTokens;
          entry.stats.savedTokens += savedTokens;
          entry.stats.savedUsd += savedUsd;
          if (hitRate !== null) {
            entry.stats.judgedCalls += 1;
            entry.hitRateSum += hitRate;
          }
        }
      }
    }

    this.refreshStats(stats, hitRateSum);
    const perSession = sessionAgg
      ? [...sessionAgg.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([sessionId, entry]) => {
            this.refreshStats(entry.stats, entry.hitRateSum);
            return { sessionId, stats: { ...entry.stats } };
          })
      : undefined;

    return {
      source: "disk",
      days,
      sinceDate,
      files,
      lines,
      skippedLines,
      stats,
      perSession,
      logDir: this.logDir,
      logPolicy: this.logPolicy,
      logMaintenance: this.lastMaintenance,
    };
  }

  /** 清空今日与累计计数（测试/重置用） */
  reset(): void {
    this.todayDate = "";
    this.today = this.zeroStats();
    this.todayHitRateSum = 0;
    this.total = this.zeroStats();
    this.totalHitRateSum = 0;
    this.perSession.clear();
  }
}

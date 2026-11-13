/**
 * card.ts —— 形态A「即时摘要卡」
 *
 * 纯文本，单卡 ≤600 字符，跟随每次请求输出，让用户第一眼看到
 * "这次请求命中了多少缓存"。字段固定，便于横向对比与机器解析。
 *
 * 硬规则：
 *  - 命中率未判定时写"未判定（厂商未回传 usage）"，严禁显示 0%；
 *  - 卡内严禁出现任何金额数字（本工具只谈 token，不谈钱）。
 */

import type { HealthCard, PrefixDiag, UsageInjectNote, UsageSample, Vendor } from "./types.js";

/** 卡片的字符上限 */
export const CARD_CHAR_LIMIT = 600;

/** 厂商方言 → 展示名 */
const VENDOR_LABEL: Record<Vendor, string> = {
  openai: "OpenAI 兼容",
  anthropic: "Anthropic",
  unknown: "未知厂商",
};

/** 千分位（不依赖本地化设置，保证跨机器输出一致） */
function formatTokens(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 命中率百分比：保留一位小数；null 走"未判定"文案 */
function formatHitRatio(hitRatio: number | null): string {
  if (hitRatio === null) return "未判定（厂商未回传 usage）";
  return `${(hitRatio * 100).toFixed(1)}%`;
}

/** 把卡片正文裁到上限，避免刷屏（只截 didWhat 这一行） */
function clipCard(text: string): string {
  if (text.length <= CARD_CHAR_LIMIT) return text;
  return `${text.slice(0, CARD_CHAR_LIMIT - 1)}…`;
}

/** 前缀行：把诊断结果翻成一句人话，让用户知道命中率死在哪 */
function formatPrefix(prefix: PrefixDiag | null | undefined): string {
  // 首屏横幅、或改写引擎异常退回原样转发时没有诊断对象：如实写"未判定"，不冒充"未启用"
  if (!prefix) return "前缀 未判定（第一个请求后才有基线）";
  if (prefix.mode === "off") return "前缀 未启用改写（--rewrite stabilize 可开启）";

  let text: string;
  switch (prefix.divergenceKind) {
    case "first":
      text = `前缀 首轮建立基线（${prefix.segmentCount} 段）`;
      break;
    case "none":
    case "appended":
      text = `前缀 稳定（${prefix.segmentCount} 段）`;
      break;
    case "modified":
      text = `前缀 第 ${(prefix.firstDivergenceIndex ?? 0) + 1} 段起变化 ← 命中率就死在这`;
      break;
    case "shrunk":
      text = `前缀 被裁掉 ${prefix.shrunkBy} 段旧内容 ← 压缩后命中率必掉`;
      break;
    default:
      text = `前缀 稳定（${prefix.segmentCount} 段）`;
  }

  if (prefix.stabilizedTools) text += " · 工具顺序已重排";
  if (prefix.anchoredTimes > 0) text += ` · 锚定时间 ${prefix.anchoredTimes} 处`;
  return text;
}

/** 流式 usage 那一行：把注入结果翻成一句人话，免得"未判定"被误读成代理坏了 */
function formatUsageInject(note: UsageInjectNote): string {
  if (note.retried) return "流式 usage 上游不认 stream_options，已去掉该字段重试一次";
  switch (note.status) {
    case "injected":
      return "流式 usage 已注入 stream_options.include_usage";
    case "already-set":
      return "流式 usage 客户端已自带 include_usage，未改动";
    case "disabled":
      return "流式 usage 未注入（--inject-usage off），本次多为未判定";
    default:
      return `流式 usage 未注入（${note.reason ?? "不适用"}）`;
  }
}

/** 渲染即时摘要卡 */
export function renderHealthCard(card: HealthCard): string {
  const vendorText = card.vendor === "unknown" ? VENDOR_LABEL.unknown : `${card.upstreamLabel}（${VENDOR_LABEL[card.vendor]}）`;
  const inputText = card.judged && card.inputTokens !== null ? formatTokens(card.inputTokens) : "未回传";
  const cachedText = card.judged && card.cachedTokens !== null ? formatTokens(card.cachedTokens) : "未回传";

  const lines = [
    `【DoboCache 体检卡 A】第 ${card.requestIndex} 次请求 · ${vendorText}`,
    `上游：${card.upstreamHost}（路由 ${card.routePrefix}）`,
    `输入 token：${inputText}`,
    `命中 token：${cachedText}`,
    `命中率：${formatHitRatio(card.hitRatio)}`,
    formatPrefix(card.prefix),
    // 不适用（非流式/非 OpenAI）时不出这一行，避免每张卡都多一行噪音
    ...(card.usageInject && (card.usageInject.status !== "not-applicable" || card.usageInject.retried)
      ? [formatUsageInject(card.usageInject)]
      : []),
    `本次做了什么：${card.didWhat}`,
  ];
  // 首屏横幅专用行：把"客户端 baseURL 到底填什么"写成可直接复制的完整地址
  if (card.entryUrl) lines.unshift(`接入 baseURL 填：${card.entryUrl}（按厂商换前缀）`);
  return clipCard(lines.join("\n"));
}

export interface CardFromSampleInput {
  requestIndex: number;
  routePrefix: string;
  upstreamLabel: string;
  upstreamHost: string;
  usage: UsageSample;
  /** 是否已生成交接单 */
  handoffSaved: boolean;
  /** 上下文阈值（token），用于提示"该做交接了" */
  contextThresholdTokens: number;
  /** 本轮前缀诊断（改写引擎产出） */
  prefix?: PrefixDiag | null;
  /** 本轮流式 usage 注入结果 */
  usageInject?: UsageInjectNote | null;
}

/** 由 usage 样本 + 服务端事实拼装卡片结构（本次做了什么为纯规则描述） */
export function buildHealthCard(input: CardFromSampleInput): HealthCard {
  const { usage } = input;
  const judged = usage.judged;
  const reached = judged && usage.inputTokens >= input.contextThresholdTokens;

  const actions: string[] = [];
  actions.push(judged ? "已按厂商 usage 记账" : "厂商未回传 usage，本次记为未判定");
  actions.push(input.handoffSaved ? "交接单已落盘" : "交接单未落盘");
  if (input.usageInject?.retried) actions.push("上游不认 stream_options，已去掉重试");
  if (reached) actions.push(`上下文 ${formatTokens(usage.inputTokens)} ≥ 阈值 ${formatTokens(input.contextThresholdTokens)}，建议做任务交接`);

  return {
    requestIndex: input.requestIndex,
    routePrefix: input.routePrefix,
    upstreamLabel: input.upstreamLabel,
    upstreamHost: input.upstreamHost,
    vendor: usage.vendor,
    inputTokens: judged ? usage.inputTokens : null,
    cachedTokens: judged ? usage.cachedTokens : null,
    hitRatio: usage.hitRatio,
    judged,
    didWhat: actions.join("；"),
    prefix: input.prefix ?? null,
    usageInject: input.usageInject ?? null,
  };
}

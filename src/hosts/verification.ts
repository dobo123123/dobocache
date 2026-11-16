/**
 * hosts/verification.ts —— 内置 13 项适配的验证台账（v0.9.1）
 *
 * 背景：v0.8.1 发布口径只写"内置 13 项适配里只有 3 家做过真机验证"，把其余 10 家糊成一句
 * "没验证"。这一版逐项收尾：每一项都带自己的验证等级、复核日期与可复算证据。
 *
 * 分级口径（见 types.ts）：
 *   client-confirmed = 真实客户端自己认过这条接入（客户端 CLI / 界面能列出 dobocache）
 *   write-rollback   = 在本机真实文件系统上完整跑过「写入 → 语法解析通过 → 条目在位 → 回滚逐字节还原」
 *   docs-only        = 只按官方文档给指路文案、不写盘（永远不参与自动写入）
 *
 * 台账由 `scripts/ci-hosts-matrix.mjs` 复算生成，改描述符 / 改样例必须同步改脚本。
 */
import type { HostVerification, HostVerificationLevel } from "./types.js";

export const HOST_VERIFICATION: Record<string, HostVerification> = {
  // ---------------------------------------------------------------- 老三家（v0.5.3 起真机端到端验证）
  loomy: {
    level: "client-confirmed",
    at: "2026-11-16",
    basis: "0.5.3 起在 Windows 11 真机对 Loomy 桌面端 opencode.json 完整验证过写入/baseURL 改写/回滚；0.9.1 矩阵沙箱复跑 sync/revert 通过",
  },
  opencode: {
    level: "client-confirmed",
    at: "2026-11-16",
    basis: "0.5.3 起在 Windows 11 真机对 opencode.json 完整验证过写入/回滚；0.9.1 矩阵沙箱复跑 sync/revert 通过",
  },
  "claude-code": {
    level: "client-confirmed",
    at: "2026-11-16",
    basis: "0.5.3 起在 Windows 11 真机对 settings.json 与 ~/.claude.json 完整验证过写入/回滚；0.9.1 矩阵沙箱复跑 sync/revert 通过",
  },

  // ---------------------------------------------------------------- v0.7.0 起描述符档
  "codex-cli": {
    level: "client-confirmed",
    at: "2026-11-16",
    basis: "codex-cli 0.141.0 真机确认：在 CODEX_HOME 沙箱写入 config.toml 的 mcp_servers.dobocache 后，`codex mcp list` 能列出 dobocache（enabled）",
  },
  aider: {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：空 ~/.aider.conf.yml 写入受管块 → YAML 可解析且 openai-api-base 指向本地代理 → 回滚后与原文逐字节一致",
  },
  goose: {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：带 extensions 锚点的 config.yaml 写入 dobocache 块 → YAML 可解析且 extensions.dobocache 在位 → 回滚逐字节还原",
  },
  "kimi-cli": {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：~/.kimi/mcp.json 写入 mcpServers.dobocache → JSON 可解析、条目 command/args 正确 → 回滚逐字节还原",
  },
  "gemini-cli": {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：~/.gemini/settings.json 写入 mcpServers.dobocache → JSON 可解析、条目 command/args 正确 → 回滚逐字节还原；baseURL 无官方依据故不写",
  },
  crush: {
    level: "docs-only",
    at: "2026-11-16",
    basis: "官方 README 明确配置优先级 .crushrc → crushrc → ~/.config/crush/crushrc，JSON 旧格式已 deprecated；写盘规则刻意为空（write=null），只输出 mcp add 指路文案",
  },
  cline: {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：cline_mcp_settings.json（新路径形态）写入 mcpServers.dobocache → JSON 可解析、条目 command/args 正确 → 回滚逐字节还原",
  },
  continue: {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：config.yaml 以 mcpServers 列表形态插入 `- name: dobocache` → YAML 可解析、冲突正则命中旧列表项时拒绝不覆盖 → 回滚逐字节还原",
  },
  cursor: {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：~/.cursor/mcp.json 写入 mcpServers.dobocache → JSON 可解析、条目 command/args 正确 → 回滚逐字节还原；baseURL 不写（Cursor 自家模型不支持自定义端点）",
  },
  windsurf: {
    level: "write-rollback",
    at: "2026-11-16",
    basis: "矩阵沙箱：mcp_config.json 写入 mcpServers.dobocache → JSON 可解析、条目 command/args 正确 → 回滚逐字节还原；baseURL 不写",
  },
};

/** 取某项的验证记录（不在台账里的底座返回 undefined，视为无记录） */
export function verificationOf(id: string): HostVerification | undefined {
  return HOST_VERIFICATION[id];
}

/** 验证等级排序权重（矩阵表格排序用）：client-confirmed 最高 */
export function levelRank(level: HostVerificationLevel): number {
  switch (level) {
    case "client-confirmed":
      return 3;
    case "write-rollback":
      return 2;
    case "docs-only":
      return 1;
    default:
      return 0;
  }
}

/** 是否允许参与 setup 自动接入：docs-only 永不参与（哪怕 confidence 标了 verified） */
export function isAutoAttachEligible(confidence: "verified" | "unverified", verification?: HostVerification): boolean {
  if (confidence !== "verified") return false;
  return verification?.level !== "docs-only";
}

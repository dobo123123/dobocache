/**
 * rules.ts —— v0.6.0（C-4）：把"什么时候该调"的使用规程写进客户端会读的约定文件。
 *
 * 为什么不全塞进工具 description：description 每轮请求都要占 token，而
 * "connected 不等于可用""别每轮调 cf_judge""任务收尾才调 cf_report"这类判断是跨工具的、
 * 一次说清就够，写进 AGENTS.md / CLAUDE.md 更省 token，也更不容易被模型忽略。
 *
 * 设计约束：
 * - 幂等：用 DOBOCACHE:BEGIN/END 标记块包裹，重复执行只原地更新，不重复追加；
 * - 不动用户内容：只碰标记块内部，块外一个字节都不改；
 * - 可预览：dryRun=true 时只回报将要做什么，不落盘（setup --dry-run 用）。
 */
import fs from "node:fs";
import path from "node:path";

export const RULES_BEGIN = "<!-- DOBOCACHE:BEGIN（由 dobostitch setup 自动写入，勿手改本块） -->";
export const RULES_END = "<!-- DOBOCACHE:END -->";
export const RULES_BODY = [
  "## 缓存助手使用规程（DoboCache）",
  "",
  "- 判断是否接通先调 `cf_ping`：返回 `pong: dobocache ready` 才算可用。MCP 客户端显示 connected / 已连接 **不等于** 工具可用。",
  "- `cf_ping` 报 `proxy: refused` 说明代理没起，此时请求不会被改写，插件侧数字不代表真实节省。",
  "- 任务收尾调一次 `cf_report` 看真实命中率；`hitRate` 为 null 表示本期没有可判定的厂商 usage（未判定），不是 0%。",
  "- `cf_judge` / `cf_tier` / `cf_inject` 只在长会话里按需调用，不要每轮调用；`cf_warmup` 会产生少量额外计费。",
].join("\n");

export interface RulesWriteResult {
  file: string;
  /** created=新建文件；appended=追加块；updated=原地更新块；preview=仅预览未写入 */
  action: "created" | "appended" | "updated" | "preview-created" | "preview-appended" | "preview-updated";
  wrote: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 生成带标记的规程块（供写入与测试复用） */
export function renderRulesBlock(): string {
  return `${RULES_BEGIN}\n${RULES_BODY}\n${RULES_END}`;
}

/**
 * 幂等写入使用规程。
 * @param root     目标目录（通常是用户项目根 = process.cwd()）
 * @param dryRun   true 时不写盘，只回报预演动作
 * @param only     限定文件名（测试用）；默认 "已存在的 AGENTS.md / CLAUDE.md 都写，都不存在则建 AGENTS.md"
 */
export function ensureAgentRules(root: string, dryRun = false, only?: string[]): RulesWriteResult[] {
  const known = only && only.length > 0 ? only : ["AGENTS.md", "CLAUDE.md"];
  const existing = known.filter((name) => fs.existsSync(path.join(root, name)));
  const targets = only && only.length > 0 ? known : existing.length > 0 ? existing : ["AGENTS.md"];
  const block = renderRulesBlock();
  const re = new RegExp(`${escapeRe(RULES_BEGIN)}[\\s\\S]*?${escapeRe(RULES_END)}`);
  const out: RulesWriteResult[] = [];

  for (const name of targets) {
    const file = path.join(root, name);
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const hasBlock = re.test(raw);
    let next: string;
    let action: RulesWriteResult["action"];

    if (hasBlock) {
      next = raw.replace(re, () => block); // 用函数替换，避免块内容里的 $ 被当成替换模式
      action = "updated";
    } else if (raw.trim().length > 0) {
      next = `${raw.trimEnd()}\n\n${block}\n`;
      action = "appended";
    } else {
      next = `${block}\n`;
      action = "created";
    }

    if (dryRun) {
      out.push({ file, action: `preview-${action}` as RulesWriteResult["action"], wrote: false });
      continue;
    }
    fs.writeFileSync(file, next, "utf-8");
    out.push({ file, action, wrote: true });
  }
  return out;
}

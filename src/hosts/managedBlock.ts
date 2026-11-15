/**
 * hosts/managedBlock.ts —— 文本配置「受管块」写入器（v0.7.0）
 *
 * 为什么需要它：TOML（Codex CLI）和 YAML（Goose / Aider 等）没法像 JSON 那样
 * 安全地"改一个键再写回"，任何全量解析重写都可能打乱用户的注释、顺序与格式（误伤）。
 * 这里的做法是：只往文件里插一段带标记的文本块 ——
 *
 *   # >>> dobocache managed block begin
 *   ...
 *   # <<< dobocache managed block end
 *
 * 规则：
 *   - 幂等：块已存在就整段替换，不会越写越多
 *   - 可回滚：--revert 只删这两行标记之间的内容，其余一个字都不动
 *   - 不猜：锚点不存在、或文件里已有同名键（会造成重复键报错）→ 直接拒绝，
 *     由上层退回「只指路、不写盘」，宁可不写也不猜错
 */
export const BLOCK_BEGIN = "# >>> dobocache managed block begin";
export const BLOCK_END = "# <<< dobocache managed block end";

export interface BlockRange {
  /** begin 标记所在行号（0-based） */
  start: number;
  /** end 标记所在行号（0-based） */
  end: number;
  /** begin 标记前导空白（用于锚点缩进对齐） */
  indent: string;
}

export type UpsertAction = "inserted-anchor" | "appended" | "replaced" | "refused";

export interface UpsertResult {
  text: string;
  action: UpsertAction;
  reason?: string;
}

const BEGIN_RE = /^(\s*)# >>> dobocache managed block begin\s*$/;
const END_RE = /^\s*# <<< dobocache managed block end\s*$/;

function splitLines(text: string): string[] {
  // 保留 CRLF 的信息：先判断主换行符，最后再拼回去
  return text.split(/\r?\n/);
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** 找到已有的受管块（找不到返回 null） */
export function findBlock(lines: string[]): BlockRange | null {
  for (let i = 0; i < lines.length; i++) {
    const match = BEGIN_RE.exec(lines[i] ?? "");
    if (!match) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (END_RE.test(lines[j] ?? "")) return { start: i, end: j, indent: match[1] ?? "" };
    }
    return null; // 只有 begin 没有 end：视为脏文件，不再动它
  }
  return null;
}

export function hasBlock(text: string): boolean {
  return findBlock(splitLines(text)) !== null;
}

/** 把内容按 baseIndent 缩进（空行不缩进、不产生尾随空格） */
function indentContent(content: string, baseIndent: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "" : `${baseIndent}${line}`))
    .filter((line, index, all) => !(line === "" && index === all.length - 1));
}

/**
 * 插入 / 替换受管块。
 * @param text     原文件内容
 * @param content  块内容（不带 markers，不含缩进）
 * @param anchor   顶层锚点键（如 "extensions"）；给了就插到该键下一层
 * @param appendIfMissing 锚点不存在时是否允许追加到文件末尾
 * @param conflictKey 禁止冲突的键（TOML 用表头 <anchor>.<conflictKey>，YAML 用 <conflictKey>:）
 */
export function upsertBlock(
  text: string,
  content: string,
  opts: { anchor?: string; appendIfMissing?: boolean; conflictKey?: string; syntax?: "toml" | "yaml" } = {},
): UpsertResult {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const existing = findBlock(lines);
  const syntax = opts.syntax ?? "yaml";

  if (text.includes(BLOCK_BEGIN) && !existing) {
    return { text, action: "refused", reason: "文件里有不完整的 dobocache 受管块标记（只有 begin 没有 end），已停止写入以免破坏文件" };
  }

  // 块已存在：整段替换（幂等）
  if (existing) {
    const indent = existing.indent;
    const body = [BLOCK_BEGIN, ...indentContent(content, indent), BLOCK_END];
    const next = [...lines.slice(0, existing.start), ...body, ...lines.slice(existing.end + 1)];
    return { text: next.join(eol), action: "replaced" };
  }

  // 冲突检查：文件里已有同名键，再插一段就会出现重复键（TOML 直接报错、YAML 后者覆盖前者）
  const conflictKey = opts.conflictKey ?? "dobocache";
  const anchor = opts.anchor;
  const conflicts: Array<{ re: RegExp; reason: string }> = [];
  if (syntax === "toml") {
    const prefix = anchor ? `${escapeRe(anchor)}\\s*\\.\\s*` : "";
    conflicts.push({
      re: new RegExp(`^\\s*\\[\\s*${prefix}${escapeRe(conflictKey)}\\s*\\]`),
      reason: `文件里已存在 [${anchor ? `${anchor}.` : ""}${conflictKey}] 配置段，非 dobocache 写入，已停止写入以免冲突`,
    });
  } else {
    conflicts.push({
      re: new RegExp(`^(\\s*)${escapeRe(conflictKey)}\\s*:`),
      reason: `文件里已存在 ${conflictKey}: 键，已停止写入以免覆盖你的配置`,
    });
  }
  for (const line of lines) {
    for (const conflict of conflicts) {
      if (conflict.re.test(line)) return { text, action: "refused", reason: conflict.reason };
    }
  }

  // 锚点存在：插到锚点行之后（缩进 = 锚点缩进 + 2）
  if (anchor) {
    const anchorRe = new RegExp(`^(\\s*)${escapeRe(anchor)}\\s*:\\s*$`);
    const anchorIndex = lines.findIndex((line) => anchorRe.test(line));
    if (anchorIndex === -1) {
      if (!opts.appendIfMissing) {
        return { text, action: "refused", reason: `文件里没有 ${anchor}: 锚点，已停止写入（避免猜错层级）` };
      }
    } else {
      const anchorIndent = (anchorRe.exec(lines[anchorIndex] ?? "")?.[1] ?? "") + "  ";
      const body = [BLOCK_BEGIN, ...indentContent(content, anchorIndent), BLOCK_END];
      const next = [...lines.slice(0, anchorIndex + 1), ...body, ...lines.slice(anchorIndex + 1)];
      return { text: next.join(eol), action: "inserted-anchor" };
    }
  }

  // 末尾追加
  const trimmed = text.replace(/\s*$/, "");
  const body = [BLOCK_BEGIN, ...indentContent(content, ""), BLOCK_END].join(eol);
  return { text: trimmed === "" ? `${body}${eol}` : `${trimmed}${eol}${eol}${body}${eol}`, action: "appended" };
}

/** 删除受管块（回滚用）；块不存在返回 removed=false */
export function removeBlock(text: string): { text: string; removed: boolean } {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const existing = findBlock(lines);
  if (!existing) return { text, removed: false };
  let next = [...lines.slice(0, existing.start), ...lines.slice(existing.end + 1)];
  // 追加型插入会多留一个空行，删除后收一遍尾部空行（只收尾部，不动正文）
  while (next.length > 0 && (next[next.length - 1] ?? "").trim() === "") next = next.slice(0, -1);
  return { text: next.length === 0 ? "" : `${next.join(eol)}${eol}`, removed: true };
}

function escapeRe(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

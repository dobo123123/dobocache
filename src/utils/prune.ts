/**
 * DoboCache 工具输出修剪
 * 在保证确定性（逐字节稳定）的前提下，
 * 压缩工具输出体积，减少进入上下文的噪声，为稳定前缀腾出空间。
 */

export interface PruneOptions {
  maxChars?: number;
  maxLines?: number;
  keepHead?: boolean;
  dedupeLines?: boolean;
  compressWhitespace?: boolean;
}

export interface PruneResult {
  text: string;
  originalChars: number;
  prunedChars: number;
  ratio: number;
  droppedLines: number;
}

const DEFAULT_OPTS: Required<PruneOptions> = {
  maxChars: 2000,
  maxLines: 200,
  keepHead: true,
  dedupeLines: true,
  compressWhitespace: true,
};

/** 单行提纯：去掉行内重复空白 */
function cleanLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * 修剪工具输出：去重行 → 压缩空白 → 行数/字符数双上限截断。
 * 所有步骤均为确定性的纯函数，同一输入永远同一输出。
 */
export function pruneToolOutput(raw: string, opts: PruneOptions = {}): PruneResult {
  const o = { ...DEFAULT_OPTS, ...opts };
  const originalChars = raw.length;

  if (!raw) {
    return { text: "", originalChars, prunedChars: 0, ratio: 0, droppedLines: 0 };
  }

  let lines = raw.split(/\r?\n/);

  if (o.dedupeLines) {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of lines) {
      const key = cleanLine(line);
      if (key.length === 0) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(line);
    }
    lines = unique;
  } else if (o.compressWhitespace) {
    lines = lines.map((l) => cleanLine(l)).filter((l) => l.length > 0);
  }

  const droppedLines = Math.max(0, lines.length - o.maxLines);
  const body = o.keepHead ? lines.slice(0, o.maxLines) : lines.slice(-o.maxLines);

  let text = body.join("\n");
  if (o.compressWhitespace) {
    text = text.replace(/\n{3,}/g, "\n\n").trim();
  }

  if (text.length > o.maxChars) {
    text = o.keepHead ? text.slice(0, o.maxChars) : text.slice(-o.maxChars);
  }

  return {
    text,
    originalChars,
    prunedChars: text.length,
    ratio: originalChars > 0 ? Math.round((1 - text.length / originalChars) * 1000) / 10 : 0,
    droppedLines,
  };
}

/**
 * 结构化工具结果确定性化：数组按稳定序重排、对象 key 排序、字段裁剪。
 * 用于把"内容相同但顺序/格式抖动"的工具返回归一为同一缓存键。
 */
export function normalizeStructured(
  rows: Record<string, unknown>[],
  fields?: string[],
): Record<string, unknown>[] {
  return rows
    .map((row) => {
      const out: Record<string, unknown> = {};
      const keys = fields ?? Object.keys(row).sort();
      for (const k of keys) {
        if (row[k] !== undefined && row[k] !== null) out[k] = row[k];
      }
      return out;
    })
    .sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
}

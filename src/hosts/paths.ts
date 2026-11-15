/**
 * hosts/paths.ts —— 路径展开与受管块 sidecar（v0.7.0）
 *
 * 只做两件事：
 *   1) 把描述符里的路径模板（含 ~ / 环境变量 / 单层 *）展开成真实存在的绝对路径
 *   2) 受管块的 sidecar 读写（记录「我们写过什么」，用来判断是否已接入 / 能否回滚）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SIDECAR_SUFFIX = ".dobocache-attach.json";

/** 把 ~ 与 %VAR% / $VAR 展开（不递归环境变量，够用且可控） */
export function expandVars(template: string): string {
  let out = template;
  if (out === "~") out = os.homedir();
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = path.join(os.homedir(), out.slice(2));
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => process.env[name] ?? whole);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => process.env[name] ?? whole);
  return out;
}

/**
 * 展开通配：只支持单层 *（够覆盖 "Loomy/<任意目录>/opencode.json" 这类模式），
 * 不递归、不匹配文件，避免误扫整个磁盘。
 */
export function expandGlob(pattern: string): string[] {
  const expanded = expandVars(pattern);
  if (!expanded.includes("*")) return fs.existsSync(expanded) ? [expanded] : [];

  const normalized = expanded.replace(/\\/g, "/");
  const segments = normalized.split("/");
  // 起点归一："/a/b" → "/"；"C:/a/b" → "C:/"；"a/b" → "a"
  let bases: string[];
  if (segments[0] === "") bases = ["/"];
  else if (/^[A-Za-z]:$/.test(segments[0])) bases = [`${segments[0]}/`];
  else bases = [segments[0]];

  for (const segment of segments.slice(1)) {
    const next: string[] = [];
    for (const base of bases) {
      if (segment === "*") {
        try {
          for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory()) next.push(path.join(base, entry.name));
          }
        } catch {
          /* 目录不存在就跳过 */
        }
      } else {
        next.push(path.join(base, segment));
      }
    }
    bases = next;
  }
  return [...new Set(bases.filter((candidate) => fs.existsSync(candidate)))];
}

export function publicDir(): string {
  if (process.platform === "win32") return process.env.PUBLIC ?? "C:\\Users\\Public";
  return "/Users/Shared";
}

export function appDataDir(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return path.join(os.homedir(), ".config");
}

/** 读 sidecar：返回 null 表示这个文件我们从没写过 */
export function readSidecar(file: string): Record<string, unknown> | null {
  const sidecar = `${file}${SIDECAR_SUFFIX}`;
  if (!fs.existsSync(sidecar)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sidecar, "utf-8").replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 写 sidecar（覆盖写） */
export function writeSidecar(file: string, payload: Record<string, unknown>): void {
  fs.writeFileSync(`${file}${SIDECAR_SUFFIX}`, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export function removeSidecar(file: string): void {
  fs.rmSync(`${file}${SIDECAR_SUFFIX}`, { force: true });
}

/** 备份：文件名带时间戳 + 原因，便于用户自己找回 */
export function backupFile(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const target = `${file}.bak_${stamp}_before-dobocache`;
  fs.copyFileSync(file, target);
  return target;
}

/** 原子写文本：先写 tmp 再 rename，避免客户端读到半个文件 */
export function writeTextAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

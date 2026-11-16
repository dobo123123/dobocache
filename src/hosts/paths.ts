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

/** 备份：文件名带时间戳（到毫秒）+ 原因，便于用户自己找回；绝不覆盖已有备份 */
export function backupFile(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 17);
  let target = `${file}.bak_${stamp}_before-dobocache`;
  // 同一毫秒内可能连做两次（接入后马上回滚），加序号避免把上一次的备份覆盖掉
  for (let i = 2; fs.existsSync(target); i += 1) {
    target = `${file}.bak_${stamp}-${i}_before-dobocache`;
  }
  fs.copyFileSync(file, target);
  return target;
}

/** 写入前预检结果（v0.8.1 新增） */
export interface WritableProbe {
  /** 是否允许写 */
  writable: boolean;
  /** 实际被探测的路径（文件本身，或最近的已存在父目录） */
  probePath: string;
  /** 不可写时的原因 */
  reason?: string;
}

function describeAccessError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "EACCES":
      return "权限不足 EACCES";
    case "EPERM":
      return "操作被系统拒绝 EPERM";
    case "EROFS":
      return "只读文件系统 EROFS";
    case "EBUSY":
      return "文件被占用 EBUSY";
    default:
      return code ? String(code) : "未知原因";
  }
}

/**
 * 写入前可写性预检（v0.8.1 新增）—— 只读探测，不创建、不修改任何文件。
 *
 * 判断顺序：
 *   1) 目标文件存在 → 看文件本身可不可写（只读属性 / ACL 拒绝在这里暴露）；
 *   2) 目标文件不存在 → 看它所在那一层目录可不可写
 *      （写盘是「同目录写 tmp 再 rename」，目录不可写就一定写不进去）；
 *      那一层目录本身也不存在 → 判为不可写（本工具不自动建目录，不猜）。
 *
 * 局限（如实写清，不夸大）：Windows 上 fs.access(W_OK) 主要看只读属性，
 * 极少部分被 ACL 拒绝的目录可能探测通过、真到写盘才报 EACCES；
 * 那种情况仍由写入侧的 try/catch 兜住，同样不会误伤原文件。
 */
export function probeWritable(file: string): WritableProbe {
  const mode = fs.constants.W_OK;
  if (fs.existsSync(file)) {
    try {
      fs.accessSync(file, mode);
      return { writable: true, probePath: file };
    } catch (err) {
      return {
        writable: false,
        probePath: file,
        reason: `${file} 不可写（${describeAccessError(err)}），常见原因是文件带只读属性，或所在磁盘/目录为只读`,
      };
    }
  }

  // 文件还不存在：只能看它所在的那一层目录。再往上的目录缺失时写盘不会自动 mkdir，
  // 所以直接判为不可写，而不是「猜着建目录」。
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    return {
      writable: false,
      probePath: file,
      reason: `上级目录不存在（${dir}），本工具不会自动创建目录`,
    };
  }
  try {
    fs.accessSync(dir, mode);
    return { writable: true, probePath: dir };
  } catch (err) {
    return {
      writable: false,
      probePath: dir,
      reason: `目录 ${dir} 不可写（${describeAccessError(err)}），没权限在里面创建/替换配置文件`,
    };
  }
}

/** 原子写文本：先写 tmp 再 rename，避免客户端读到半个文件 */
export function writeTextAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

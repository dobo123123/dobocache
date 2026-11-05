/**
 * 日志目录解析（跨机器可跑改造）
 *
 * 背景：MCP 客户端以子进程方式拉起 server 时，`cwd` 常常不是用户想的位置
 * （可能未定义、可能是安装目录、也可能是只读目录），基于 `process.cwd()`
 * 的相对路径会写错地方，甚至直接 ENOENT/EPERM 崩掉。这里统一改成
 * "平台标准可写目录"，并按明确的优先级逐级降级，任何一级失败都不抛错。
 *
 * 优先级：
 *   1. 环境变量 DOBOCACHE_LOG_DIR（兼容旧名 CACHEFORGE_LOG_DIR）
 *   2. 平台标准可写目录
 *        Windows      %LOCALAPPDATA%\DoboCache\logs
 *        macOS        ~/Library/Logs/DoboCache
 *        Linux/其他   $XDG_STATE_HOME/dobocache 或 ~/.local/state/dobocache
 *   3. <cwd>/data/logs（旧行为，作为回退）
 *   4. 全部失败 → 不写文件（由调用方降级为 stderr 提示），进程继续运行
 *
 * 全部路径用 path.join 拼接，避免手写分隔符。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 日志目录来源：环境变量 / 平台标准目录 / cwd 回退 / 已禁用落盘 */
export type LogDirSource = "env" | "platform" | "cwd" | "disabled";

export interface LogDirResolution {
  /** 最终采用的日志目录（disabled 时为最后尝试的目录，仅用于展示） */
  dir: string;
  source: LogDirSource;
  /** 面向人的降级说明（短句，可原样打到 stderr） */
  warnings: string[];
  /** 是否已经完全无法落盘（此时不应再写日志文件） */
  disabled: boolean;
}

/** 取当前工作目录；cwd 已被删除时 process.cwd() 会抛错，这里兜住 */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

/**
 * 平台标准可写目录（按平台规则计算，不做任何磁盘操作）。
 * 平台不支持或无法确定家目录时返回 undefined。
 */
export function platformLogDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | undefined {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) return path.join(localAppData, "DoboCache", "logs");
    return home ? path.join(home, "AppData", "Local", "DoboCache", "logs") : undefined;
  }
  if (platform === "darwin") {
    return home ? path.join(home, "Library", "Logs", "DoboCache") : undefined;
  }
  // Linux 及其他类 Unix：XDG_STATE_HOME 优先（仅接受绝对路径，符合 XDG 规范）
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome && path.isAbsolute(xdgStateHome)) {
    return path.join(xdgStateHome, "dobocache");
  }
  return home ? path.join(home, ".local", "state", "dobocache") : undefined;
}

/** 试建目录 + 写探针，确认"真的能写"（只读挂载时 mkdir 可能成功但写入失败） */
function tryPrepare(dir: string): { ok: boolean; reason?: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.dobocache-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, reason: code ?? "UNKNOWN" };
  }
}

/**
 * 解析日志目录。enabled=false（例如测试里关掉落盘）时不做任何磁盘探测，
 * 只给出"原本会用哪个目录"，保持零副作用。
 */
export function resolveLogDir(options: { explicitDir?: string; enabled?: boolean } = {}): LogDirResolution {
  const enabled = options.enabled ?? true;
  const explicit = options.explicitDir?.trim();
  const platform = platformLogDir();
  const cwdFallback = path.join(safeCwd(), "data", "logs");

  const preferred: { dir: string; source: LogDirSource } = explicit
    ? { dir: explicit, source: "env" }
    : platform
      ? { dir: platform, source: "platform" }
      : { dir: cwdFallback, source: "cwd" };

  if (!enabled) {
    return { dir: preferred.dir, source: preferred.source, warnings: [], disabled: false };
  }

  const warnings: string[] = [];
  const candidates: { dir: string; source: LogDirSource }[] = [];
  if (explicit) candidates.push({ dir: explicit, source: "env" });
  if (platform) candidates.push({ dir: platform, source: "platform" });
  candidates.push({ dir: cwdFallback, source: "cwd" });

  for (const candidate of candidates) {
    const prepared = tryPrepare(candidate.dir);
    if (prepared.ok) {
      if (candidate.source === "cwd" && candidates.length > 1) {
        warnings.push(`平台日志目录不可写，已回退到 ${candidate.dir}`);
      }
      return { dir: candidate.dir, source: candidate.source, warnings, disabled: false };
    }
    warnings.push(`日志目录不可写（${prepared.reason}）：${candidate.dir}`);
  }

  warnings.push("所有候选日志目录都不可写，本次运行不再写日志文件（缓存功能不受影响）");
  return { dir: cwdFallback, source: "disabled", warnings, disabled: true };
}

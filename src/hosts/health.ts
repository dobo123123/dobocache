/**
 * hosts/health.ts —— 接入体检（v0.7.3）
 *
 * 为什么需要它：v0.7.x 之后能自动写入的底座越来越多，但"写入成功"不等于"明天还能用"。
 * 常见的四类坏法都不报错：
 *   1) 用户后来在客户端里把 MCP 条目删了/改了名 —— 我们这边毫无感知；
 *   2) 配置文件被写坏（JSON 多了个逗号、YAML 缩进被编辑器改掉）—— 客户端静默不加载；
 *   3) 受管块的标记被覆盖掉 —— 下次 apply 会重复插入，或回滚找不到块；
 *   4) 接入时写的 bundle 路径已经不在了（包被挪走/清理了缓存）—— MCP 起不来。
 *
 * 体检只读不写：不修、不补、不改任何一个字节。要修是用户自己决定跑 attach --revert 或重跑 attach。
 */
import fs from "node:fs";

import { findBlock } from "./managedBlock.js";
import { readSidecar } from "./paths.js";
import type { HostDescriptor, JsonWriteSpec, ManagedBlockWriteSpec } from "./types.js";

export type HealthLevel = "ok" | "warn" | "broken";

export interface HealthCheck {
  name: string;
  level: HealthLevel;
  detail: string;
}

export interface FileHealth {
  file: string;
  level: HealthLevel;
  checks: HealthCheck[];
}

export interface HostHealth {
  hostId: string;
  label: string;
  attached: boolean;
  level: HealthLevel;
  files: FileHealth[];
}

export interface HealthOptions {
  /** 我们写进配置的 bundle 路径；给了就检查它是否还在盘上 */
  bundlePath?: string;
  /** 代理基址；给了就检查 MCP 条目里记的端口是否与当前一致 */
  proxyBase?: string;
}

const LEVEL_WEIGHT: Record<HealthLevel, number> = { ok: 0, warn: 1, broken: 2 };

function worst(levels: HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((acc, level) => (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[acc] ? level : acc), "ok");
}

function asDict(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 用 "a.b.dobocache" 这种路径取任意值（配置层级各家不同，统一走路径） */
function pickPath(root: unknown, keys: string[]): unknown {
  let node: unknown = root;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = asDict(node)[key];
  }
  return node;
}

function readJsonFile(file: string): { ok: true; data: unknown } | { ok: false; reason: string } {
  try {
    const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
    if (raw.trim() === "") return { ok: false, reason: "文件是空的" };
    return { ok: true, data: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 80) };
  }
}

/** JSON 形态：检查 mcp 条目在不在、指向的命令/参数对不对 */
function checkJsonEntry(
  spec: JsonWriteSpec,
  file: string,
  options: HealthOptions,
): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const parsed = readJsonFile(file);
  if (!parsed.ok) {
    checks.push({ name: "配置可解析", level: "broken", detail: `JSON 解析失败：${parsed.reason}（客户端会静默不加载）` });
    return checks;
  }
  checks.push({ name: "配置可解析", level: "ok", detail: "JSON 合法" });

  const keyPath = spec.mcpKeyPath ?? [];
  const entry = pickPath(parsed.data, [...keyPath, "dobocache"]);
  if (typeof entry !== "object" || entry === null) {
    checks.push({
      name: "MCP 条目",
      level: "warn",
      detail: `${keyPath.join(".")}.dobocache 不在文件里（可能被客户端删掉或改名了）`,
    });
  } else {
    const rec = asDict(entry);
    const command = typeof rec.command === "string" ? rec.command : "";
    if (command === "") {
      checks.push({ name: "MCP 条目", level: "warn", detail: "条目在，但没有 command 字段（客户端会拒载）" });
    } else {
      checks.push({ name: "MCP 条目", level: "ok", detail: `条目在：command = ${command}` });
    }
    const args = Array.isArray(rec.args) ? rec.args.filter((item): item is string => typeof item === "string") : [];
    const script = args.find((item) => item.endsWith(".js") || item.endsWith(".mjs") || item.endsWith(".cjs")) ?? "";
    if (script !== "") {
      const exists = fs.existsSync(script);
      checks.push({
        name: "启动脚本",
        level: exists ? "ok" : "broken",
        detail: exists ? `${script} 存在` : `${script} 不存在了（MCP 会起不来，重跑 attach 可改成新路径）`,
      });
    }
  }

  if (spec.baseURLPath && spec.baseURLPath.length > 0 && options.proxyBase) {
    const baseUrl = pickPath(parsed.data, spec.baseURLPath);
    if (typeof baseUrl === "string" && baseUrl !== "") {
      const samePort = baseUrl.startsWith(options.proxyBase);
      checks.push({
        name: "端点指向",
        level: samePort ? "ok" : "warn",
        detail: samePort ? `${spec.baseURLPath.join(".")} 指向本地代理` : `${spec.baseURLPath.join(".")} = ${baseUrl}，不是当前代理 ${options.proxyBase}`,
      });
    }
  }
  return checks;
}

/** 受管块形态：块在不在、块里写的脚本还在不在 */
function checkBlockEntry(spec: ManagedBlockWriteSpec, file: string, anchorUsed: string): HealthCheck[] {
  const checks: HealthCheck[] = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
  } catch (err) {
    checks.push({ name: "配置可读", level: "broken", detail: (err as Error).message.slice(0, 80) });
    return checks;
  }
  const block = findBlock(text.split(/\r?\n/));
  if (!block) {
    checks.push({ name: "受管块", level: "warn", detail: "dobocache 受管块不在了（可能被覆盖或手工删掉）" });
    return checks;
  }
  checks.push({ name: "受管块", level: "ok", detail: "标记完整（begin / end 都在）" });
  const lines = text.split(/\r?\n/);
  const inside = lines.slice(block.start + 1, block.end).join("\n");
  const script = inside.match(/[A-Za-z]:\\[^\s"']+\.js|~?\/[^\s"']+\.js/)?.[0] ?? "";
  if (script !== "") {
    const expanded = script.startsWith("~") ? script.replace(/^~/, process.env.USERPROFILE ?? "") : script;
    const exists = fs.existsSync(expanded);
    checks.push({
      name: "启动脚本",
      level: exists ? "ok" : "broken",
      detail: exists ? `${script} 存在` : `${script} 不存在了（MCP 会起不来，重跑 attach 可改成新路径）`,
    });
  }
  // 只有当初确实"插在锚点下"才校验锚点；追加到文件末尾的块，锚点本来就可能不存在
  if (anchorUsed !== "") {
    const hasAnchor = lines.some((line) => line.trim().startsWith(`${anchorUsed}:`) || line.trim() === `[${anchorUsed}]`);
    checks.push({
      name: "锚点",
      level: hasAnchor ? "ok" : "warn",
      detail: hasAnchor ? `${anchorUsed} 还在` : `${anchorUsed} 不见了（块可能已脱锚，建议重跑 attach 确认层级）`,
    });
  }
  return checks;
}

/** 单个文件体检：能否解析 + 条目在不在 + 是否与我们的接入记录对得上 */
export function checkHostFile(host: HostDescriptor, file: string, options: HealthOptions = {}): FileHealth {
  const checks: HealthCheck[] = [];
  const sidecar = readSidecar(file);
  if (sidecar) {
    checks.push({
      name: "接入记录",
      level: "ok",
      detail: `有（${String(sidecar.target ?? host.id)} 于 ${String(sidecar.savedAt ?? "未知时间").slice(0, 19)} 写入）`,
    });
    const backup = typeof sidecar.backup === "string" ? sidecar.backup : "";
    if (backup !== "") {
      const exists = fs.existsSync(backup);
      checks.push({
        name: "回滚备份",
        level: exists ? "ok" : "warn",
        detail: exists ? `${backup}` : `备份文件不在了（${backup}），--revert 仍可删块但拿不回原排版`,
      });
    }
  } else {
    checks.push({ name: "接入记录", level: "warn", detail: "没有接入记录（可能是老版本写的，或用户自己手工配的）" });
  }

  const write = host.write;
  if (write === null) {
    checks.push({ name: "写入方式", level: "warn", detail: "该底座只指路、不自动写盘，体检只看文件是否可读" });
  } else if (write.kind === "json") {
    checks.push(...checkJsonEntry(write, file, options));
  } else {
    const anchorUsed = typeof sidecar?.anchor === "string" ? sidecar.anchor : "";
    checks.push(...checkBlockEntry(write, file, anchorUsed));
  }

  if (options.bundlePath && options.bundlePath !== "") {
    const exists = fs.existsSync(options.bundlePath);
    checks.push({
      name: "本机包文件",
      level: exists ? "ok" : "warn",
      detail: exists ? `${options.bundlePath} 存在` : `${options.bundlePath} 不存在（当前调用方没装包？）`,
    });
  }

  return { file, level: worst(checks.map((check) => check.level)), checks };
}

/** 单个底座体检：没有配置文件就是"没装"，不算失败 */
export function checkHost(host: HostDescriptor, files: string[], options: HealthOptions = {}): HostHealth {
  const fileHealths = files.map((file) => checkHostFile(host, file, options));
  const attached = fileHealths.some((item) => item.checks.some((check) => check.name === "接入记录" && check.level === "ok"));
  return {
    hostId: host.id,
    label: host.label,
    attached,
    level: fileHealths.length === 0 ? "ok" : worst(fileHealths.map((item) => item.level)),
    files: fileHealths,
  };
}

export interface HealthSummary {
  ok: number;
  warn: number;
  broken: number;
  hosts: HostHealth[];
}

/** 批量体检（传进来的 hosts 一般只包含"本机存在配置文件"的那些） */
export function summarizeHealth(hosts: HostHealth[]): HealthSummary {
  return {
    ok: hosts.filter((host) => host.level === "ok").length,
    warn: hosts.filter((host) => host.level === "warn").length,
    broken: hosts.filter((host) => host.level === "broken").length,
    hosts,
  };
}

/**
 * hosts/registry.ts —— 底座描述符注册表（v0.7.0）
 *
 * 三来源合并，后者只做补充、不覆盖同名:
 *   1) 内置描述符（builtin.ts，按版本累积）
 *   2) 外部描述符目录（DOBOCACHE_ADAPTERS_DIR，默认 ~/.dobocache/adapters）
 *      外部描述符只允许"只指路"形态：写盘规则（write）不接受外部文件注入，
 *      避免有人塞一份错的写盘规则把用户配置写坏。
 *
 * 注册表只负责"有什么底座、长什么样"，不负责写盘（写盘在 engine.ts）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BUILTIN_HOSTS } from "./builtin.js";
import { hostAttached, locateHostFiles, type HostContext } from "./engine.js";
import type { HostDescriptor, HostDetection, HostLocation, HostPlan } from "./types.js";

export interface ExternalLoadResult {
  hosts: HostDescriptor[];
  warnings: string[];
}

/** 外部描述符目录 */
export function adaptersDir(): string {
  const fromEnv = process.env.DOBOCACHE_ADAPTERS_DIR;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return path.join(os.homedir(), ".dobocache", "adapters");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseExternal(raw: unknown, file: string): { host?: HostDescriptor; warning?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { warning: `${file}：顶层不是对象，已跳过` };
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const label = typeof obj.label === "string" ? obj.label.trim() : "";
  if (!id || !label) return { warning: `${file}：缺 id 或 label，已跳过` };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { warning: `${file}：id 只允许小写字母数字与短横线（${id}），已跳过` };

  const locationsRaw = Array.isArray(obj.locations) ? obj.locations : [];
  const locations: HostLocation[] = [];
  for (const item of locationsRaw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
    if (!pattern) continue;
    const role = rec.role === "mcp" || rec.role === "env" || rec.role === "both" ? rec.role : "both";
    locations.push({ pattern, role, note: typeof rec.note === "string" ? rec.note : undefined });
  }
  if (locations.length === 0) return { warning: `${file}：没有可用 locations，已跳过` };

  const planRaw = typeof obj.plan === "string" ? obj.plan.toUpperCase() : "P2";
  const plan: HostPlan = planRaw === "P0" || planRaw === "P1" ? planRaw : "P2";

  return {
    host: {
      id,
      label,
      plan,
      since: typeof obj.since === "string" ? obj.since : "external",
      platforms: ["win32", "darwin", "linux"],
      confidence: "unverified",
      source: typeof obj.source === "string" ? obj.source : `外部描述符 ${path.basename(file)}`,
      locations,
      // 外部描述符一律只指路
      write: null,
      guide: asStringArray(obj.guide),
    },
  };
}

/** 载入外部描述符（目录不存在 = 没有，不算错误） */
export function loadExternalHosts(): ExternalLoadResult {
  const dir = adaptersDir();
  const warnings: string[] = [];
  const hosts: HostDescriptor[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json"));
  } catch {
    return { hosts, warnings };
  }
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
      const parsed = parseExternal(raw, file);
      if (parsed.warning) warnings.push(parsed.warning);
      if (parsed.host) {
        // 与内置同 id 时内置优先：外部描述符不许冒充已内置的底座
        if (BUILTIN_HOSTS.some((host) => host.id === parsed.host?.id)) {
          warnings.push(`${file}：id 与内置底座 ${parsed.host.id} 重复，已跳过（内置优先）`);
        } else if (hosts.some((host) => host.id === parsed.host?.id)) {
          warnings.push(`${file}：id 与同目录其他描述符 ${parsed.host.id} 重复，已跳过`);
        } else {
          hosts.push(parsed.host);
        }
      }
    } catch (err) {
      warnings.push(`${file}：JSON 解析失败（${(err as Error).message.slice(0, 60)}），已跳过`);
    }
  }
  return { hosts, warnings };
}

/** 全部描述符（内置在前，外部在后；同 id 时内置优先） */
export function listHosts(): HostDescriptor[] {
  const builtinIds = new Set(BUILTIN_HOSTS.map((host) => host.id));
  const external = loadExternalHosts().hosts.filter((host) => !builtinIds.has(host.id));
  return [...BUILTIN_HOSTS, ...external];
}

export function getHost(id: string): HostDescriptor | undefined {
  return listHosts().find((host) => host.id === id);
}

/** 探测：哪些底座的配置文件真实存在（只读，不写盘） */
export function detectHosts(hosts: HostDescriptor[] = listHosts()): HostDetection[] {
  return hosts.map((host) => ({
    id: host.id,
    label: host.label,
    plan: host.plan,
    since: host.since,
    confidence: host.confidence,
    platforms: host.platforms,
    files: locateHostFiles(host),
    attached: hostAttached(host),
    guide: host.guide,
  }));
}

/** 只指路文案：把手写片段里的变量替换成真实值 */
export function renderGuide(host: HostDescriptor, ctx: HostContext): string[] {
  const lines = host.guide ?? [];
  if (lines.length === 0) {
    lines.push(`把 MCP 服务器填成：command = ${ctx.nodeExe}，args = ["${ctx.bundlePath}"]`, `模型 baseURL 指向 ${ctx.proxyBase}/<厂商前缀>`);
  }
  const head = host.write
    ? "该底座可自动写入；若想自己填，按下面这样写："
    : host.guide && host.guide.length > 0
      ? "该底座仅指路、不自动写盘："
      : "通用填写方式（该底座仅指路）：";
  return [head, ...lines.map((line) => `  ${line}`)];
}

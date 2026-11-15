/**
 * hosts/engine.ts —— 描述符执行引擎（v0.7.0）
 *
 * 职责边界：只做「按描述符找文件 → 写 MCP 条目 / baseURL → 记录 sidecar → 可回滚」，
 * 不理解代理、不理解缓存算法（内核零改红线）。
 *
 * 安全策略：
 *   - JSON 文件解析不了（含注释的 JSONC、语法错误）→ 拒绝写入，退回只指路。
 *     理由：重写会丢注释、丢格式，属于"看起来成功、实际误伤"。
 *   - 受管块写入冲突 / 锚点缺失 → 拒绝写入并给出原因。
 *   - 所有写入前先备份，写入用 tmp + rename 原子落盘。
 */
import fs from "node:fs";

import { removeBlock, upsertBlock } from "./managedBlock.js";
import { backupFile, expandGlob, readSidecar, removeSidecar, writeSidecar, writeTextAtomic } from "./paths.js";
import type {
  BlockRenderContext,
  HostDescriptor,
  HostLocation,
  HostResult,
  JsonWriteSpec,
  ManagedBlockWriteSpec,
} from "./types.js";

export interface HostContext {
  nodeExe: string;
  bundlePath: string;
  proxyBase: string;
  port: number;
  dryRun: boolean;
}

type Dict = { [key: string]: unknown };

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

/** 取子对象，不存在则创建 */
function ensureIn(root: Dict, keys: string[]): Dict {
  let cur: Dict = root;
  for (const key of keys) {
    if (!isDict(cur[key])) cur[key] = {};
    cur = cur[key] as Dict;
  }
  return cur;
}

/** 稳定序列化（键排序），用于幂等比较 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isDict(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function readJsonStrict(file: string): { ok: true; data: Dict } | { ok: false; reason: string } {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return { ok: false, reason: `读不了文件（${(err as NodeJS.ErrnoException).code ?? "UNKNOWN"}）` };
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isDict(parsed)) return { ok: false, reason: "文件顶层不是对象，已停止写入" };
    return { ok: true, data: parsed };
  } catch (err) {
    return {
      ok: false,
      reason: `不是严格 JSON（${(err as Error).message.slice(0, 60)}），可能含注释；重写会丢你的注释，已停止写入`,
    };
  }
}

/** 按描述符的 entryShape 生成 MCP 条目 */
export function buildMcpEntry(shape: JsonWriteSpec["entryShape"], ctx: HostContext): Dict {
  switch (shape) {
    case "opencode-local":
      return { type: "local", command: [ctx.nodeExe, ctx.bundlePath], enabled: true };
    case "stdio-type":
      return { type: "stdio", command: ctx.nodeExe, args: [ctx.bundlePath] };
    case "zed-context-server":
      return { command: { path: ctx.nodeExe, args: [ctx.bundlePath] }, settings: {} };
    case "command-args":
    default:
      return { command: ctx.nodeExe, args: [ctx.bundlePath] };
  }
}

function blockContext(ctx: HostContext): BlockRenderContext {
  return { nodeExe: ctx.nodeExe, bundlePath: ctx.bundlePath, proxyBase: ctx.proxyBase, port: ctx.port };
}

/** 应用一个文件的接入（JSON 或受管块） */
export function applyHostFile(descriptor: HostDescriptor, file: string, ctx: HostContext): HostResult {
  const base: Omit<HostResult, "status" | "changes"> = { target: descriptor.id, label: descriptor.label, configPath: file };
  if (!descriptor.write) {
    return { ...base, status: "skipped", changes: [], detail: "该底座只指路、不写盘（P2）" };
  }
  try {
    return descriptor.write.kind === "json"
      ? applyJson(descriptor, file, descriptor.write, ctx)
      : applyBlock(descriptor, file, descriptor.write, ctx);
  } catch (err) {
    return { ...base, status: "error", changes: [], detail: (err as Error)?.message ?? String(err) };
  }
}

/** 回滚一个文件的接入 */
export function revertHostFile(descriptor: HostDescriptor, file: string, ctx: HostContext): HostResult {
  const base: Omit<HostResult, "status" | "changes"> = { target: descriptor.id, label: descriptor.label, configPath: file };
  if (!descriptor.write) {
    return { ...base, status: "skipped", changes: [], detail: "该底座没有可回滚的写入" };
  }
  try {
    return descriptor.write.kind === "json" ? revertJson(descriptor, file, descriptor.write, ctx) : revertManagedBlock(descriptor, file, ctx);
  } catch (err) {
    return { ...base, status: "error", changes: [], detail: (err as Error)?.message ?? String(err) };
  }
}

function applyJson(descriptor: HostDescriptor, file: string, spec: JsonWriteSpec, ctx: HostContext): HostResult {
  const base: Omit<HostResult, "status" | "changes"> = { target: descriptor.id, label: descriptor.label, configPath: file };
  const read = readJsonStrict(file);
  if (!read.ok) return { ...base, status: "skipped", changes: [], detail: read.reason };

  const json = read.data;
  const changes: string[] = [];
  let baseURLBefore = "";
  /** 本次写入新建的父级键（回滚时一并摘掉空壳） */
  const createdParents: string[] = [];

  if (spec.baseURLPath && spec.baseURLPath.length > 0) {
    const parent = ensureIn(json, spec.baseURLPath.slice(0, -1));
    const leaf = spec.baseURLPath[spec.baseURLPath.length - 1] as string;
    const want = `${ctx.proxyBase}${spec.baseURLSuffix ?? ""}`;
    const before = typeof parent[leaf] === "string" ? (parent[leaf] as string) : "";
    if (before !== want) {
      baseURLBefore = before;
      parent[leaf] = want;
      changes.push(`${spec.baseURLPath.join(".")}: ${before || "（空）"} -> ${want}`);
    }
  }

  if (spec.mcpKeyPath && spec.mcpKeyPath.length > 0) {
    // 记录哪几层父级键是本次新建的：回滚时要把这些空壳一并摘掉，否则会留下 "mcpServers": {}
    let probe: Dict = json;
    for (const key of spec.mcpKeyPath) {
      if (!isDict(probe[key])) createdParents.push(key);
      probe = asDict(probe[key]);
    }
    const servers = ensureIn(json, spec.mcpKeyPath);
    const want = buildMcpEntry(spec.entryShape, ctx);
    const cur = servers.dobocache;
    if (stable(cur) !== stable(want)) {
      const existed = isDict(cur);
      servers.dobocache = want;
      changes.push(`${spec.mcpKeyPath.join(".")}.dobocache ${existed ? "-> 更新" : "-> 新增"}`);
    }
  }

  if (changes.length === 0) return { ...base, status: "skipped", changes: [], detail: "已是接入状态" };
  if (ctx.dryRun) return { ...base, status: "dry-run", changes };

  const backup = backupFile(file);
  writeTextAtomic(file, `${JSON.stringify(json, null, 2)}\n`);
  writeSidecar(file, {
    target: descriptor.id,
    configPath: file,
    savedAt: new Date().toISOString(),
    changes,
    ...(baseURLBefore ? { baseURLBefore } : {}),
    ...(createdParents.length > 0 ? { createdParents } : {}),
  });
  return { ...base, status: "applied", changes, backup };
}

function revertJson(descriptor: HostDescriptor, file: string, spec: JsonWriteSpec, ctx: HostContext): HostResult {
  const base: Omit<HostResult, "status" | "changes"> = { target: descriptor.id, label: descriptor.label, configPath: file };
  const sidecar = readSidecar(file);
  if (!sidecar) return { ...base, status: "skipped", changes: [], detail: "没有接入记录，未动" };
  const read = readJsonStrict(file);
  if (!read.ok) return { ...base, status: "skipped", changes: [], detail: read.reason };

  const json = read.data;
  const changes: string[] = [];

  if (spec.mcpKeyPath && spec.mcpKeyPath.length > 0) {
    const servers = spec.mcpKeyPath.reduce<Dict>((acc, key) => asDict(acc[key]), json);
    if (isDict(servers.dobocache)) {
      delete servers.dobocache;
      changes.push(`已移除 ${spec.mcpKeyPath.join(".")}.dobocache`);
      // 接入时新建的父级键，若已空掉就一并摘掉，保证回滚后文件与接入前一致
      const created = Array.isArray(sidecar.createdParents) ? (sidecar.createdParents as string[]) : [];
      for (const key of [...created].reverse()) {
        const parent = spec.mcpKeyPath.slice(0, spec.mcpKeyPath.indexOf(key)).reduce<Dict>((acc, k) => asDict(acc[k]), json);
        const node = parent[key];
        if (isDict(node) && Object.keys(node).length === 0) {
          delete parent[key];
          changes.push(`已清掉接入时新建的空 ${key} 段`);
        }
      }
    }
  }

  if (spec.baseURLPath && spec.baseURLPath.length > 0) {
    // 只下钻到父对象，最后一段是键名（否则会一路钻到字符串值里）
    const parent = spec.baseURLPath.slice(0, -1).reduce<Dict>((acc, key) => asDict(acc[key]), json);
    const leaf = spec.baseURLPath[spec.baseURLPath.length - 1] as string;
    const cur = parent[leaf];
    if (typeof cur === "string" && cur.startsWith(ctx.proxyBase)) {
      const before = typeof sidecar.baseURLBefore === "string" ? sidecar.baseURLBefore : "";
      if (before && !before.startsWith(ctx.proxyBase)) {
        parent[leaf] = before;
        changes.push(`${spec.baseURLPath.join(".")} 复原 -> ${before}（接入前的原值）`);
      } else {
        delete parent[leaf];
        changes.push(`已移除 ${spec.baseURLPath.join(".")}（回到客户端默认）`);
      }
    }
  }

  if (changes.length === 0) return { ...base, status: "skipped", changes: [], detail: "无需改动" };
  if (ctx.dryRun) return { ...base, status: "dry-run", changes };

  backupFile(file);
  writeTextAtomic(file, `${JSON.stringify(json, null, 2)}\n`);
  removeSidecar(file);
  return { ...base, status: "applied", changes };
}

function applyBlock(descriptor: HostDescriptor, file: string, spec: ManagedBlockWriteSpec, ctx: HostContext): HostResult {
  const base: Omit<HostResult, "status" | "changes"> = { target: descriptor.id, label: descriptor.label, configPath: file };
  const before = fs.readFileSync(file, "utf-8");
  const content = spec.render(blockContext(ctx));
  const result = upsertBlock(before, content, {
    anchor: spec.anchor,
    appendIfMissing: spec.appendIfMissing ?? false,
    conflictKey: spec.conflictKey ?? "dobocache",
    syntax: spec.syntax,
  });
  if (result.action === "refused") return { ...base, status: "skipped", changes: [], detail: result.reason };
  if (result.text === before) return { ...base, status: "skipped", changes: [], detail: "已是接入状态" };

  const changes = [result.action === "replaced" ? "受管块已更新（幂等替换）" : `新增受管块（${spec.syntax}，${result.action === "inserted-anchor" ? `插在 ${spec.anchor} 下` : "文件末尾"}）`];
  if (ctx.dryRun) return { ...base, status: "dry-run", changes };

  const backup = backupFile(file);
  writeTextAtomic(file, result.text);
  writeSidecar(file, { target: descriptor.id, configPath: file, savedAt: new Date().toISOString(), kind: "managed-block", changes });
  return { ...base, status: "applied", changes, backup, detail: descriptor.manualSteps?.[0] };
}

function revertManagedBlock(descriptor: HostDescriptor, file: string, ctx: HostContext): HostResult {
  const base: Omit<HostResult, "status" | "changes"> = { target: descriptor.id, label: descriptor.label, configPath: file };
  const before = fs.readFileSync(file, "utf-8");
  const result = removeBlock(before);
  if (!result.removed) return { ...base, status: "skipped", changes: [], detail: "文件里没有 dobocache 受管块，未动" };
  const changes = ["已删除 dobocache 受管块（其余内容未动）"];
  if (ctx.dryRun) return { ...base, status: "dry-run", changes };
  backupFile(file);
  writeTextAtomic(file, result.text);
  removeSidecar(file);
  return { ...base, status: "applied", changes };
}

/** 展开某个底座所有命中的真实文件（不写盘） */
export function locateHostFiles(descriptor: HostDescriptor): string[] {
  const files: string[] = [];
  for (const location of descriptor.locations) {
    files.push(...expandFiles(location));
  }
  return [...new Set(files)];
}

function expandFiles(location: HostLocation): string[] {
  return expandGlob(location.pattern);
}

/** 是否已写入过接入记录 */
export function hostAttached(descriptor: HostDescriptor): boolean {
  return locateHostFiles(descriptor).some((file) => readSidecar(file) !== null);
}

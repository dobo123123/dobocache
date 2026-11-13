/**
 * attach.ts —— 一条命令把 DoboCache 接进底座（v0.5.3「一装即自动」核心）
 *
 * 解决的真实痛点：
 *   用户装完不知道要改哪里：baseURL 在哪、MCP 怎么填、代理谁起。
 *   本模块把「找配置 → 备份 → 改 baseURL → 写 MCP 入口（指向 bundle，自带拉起代理）」
 *   全自动化，并对每个改动保留 sidecar 记录，随时可以 --revert 原样退回。
 *
 * 支持底座（v0.5.3）：
 *   loomy        Loomy 桌面端（opencode 配置内核，provider.imodel + mcp.dobocache）
 *   opencode     通用 opencode（只写 MCP；baseURL 因上游各异不代猜）
 *   claude-code  Claude Code（settings.json 的 ANTHROPIC_BASE_URL + ~/.claude.json 的 mcpServers）
 *   其他底座      打印一段可粘贴的配置片段（generic）
 *
 * 设计红线：
 *   - 一律"先备份再改"，改动失败立即回滚
 *   - 幂等：已经正确的配置不重写文件（不制造无谓 diff）
 *   - 不改用户其他 provider / 其他 MCP 条目
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT } from "./proxy/server.js";

export type Status = "applied" | "dry-run" | "skipped" | "error";

export interface AttachResult {
  target: string;
  label: string;
  configPath: string;
  status: Status;
  changes: string[];
  detail?: string;
  backup?: string;
}

export interface AttachContext {
  port: number;
  nodeExe: string;
  bundlePath: string;
  /** 代理根地址，如 http://127.0.0.1:27880 */
  proxyBase: string;
  dryRun: boolean;
}

type Dict = { [key: string]: unknown };

const SIDECAR_SUFFIX = ".dobocache-attach.json";

function here(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** 默认 MCP 入口：dist/bundle.js（编译产物与 src 同层级，注意 src 直跑场景回落 dist） */
export function defaultBundlePath(): string {
  const distCandidate = path.join(here(), "bundle.js");
  if (fs.existsSync(distCandidate)) return distCandidate;
  const srcCandidate = path.join(here(), "..", "dist", "bundle.js");
  return path.resolve(srcCandidate);
}

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDict(value: unknown): Dict {
  return isDict(value) ? value : {};
}

function getIn(root: Dict, keys: string[]): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    if (!isDict(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 取子对象，不存在则创建（父级非对象时覆盖为对象） */
function ensureIn(root: Dict, keys: string[]): Dict {
  let cur: Dict = root;
  for (const key of keys) {
    const next = cur[key];
    if (!isDict(next)) cur[key] = {};
    cur = cur[key] as Dict;
  }
  return cur;
}

function readJson(file: string): Dict {
  const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
  const parsed: unknown = JSON.parse(raw);
  return asDict(parsed);
}

function backup(file: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const target = `${file}.bak_${stamp}_before-dobocache`;
  fs.copyFileSync(file, target);
  return target;
}

/** 原子写：先写 tmp 再 rename，避免客户端读到半个文件 */
function writeJsonAtomic(file: string, data: Dict): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

function readSidecar(file: string): Dict | null {
  const sidecar = `${file}${SIDECAR_SUFFIX}`;
  if (!fs.existsSync(sidecar)) return null;
  try {
    return readJson(sidecar);
  } catch {
    return null;
  }
}

function writeSidecar(file: string, payload: Dict): void {
  fs.writeFileSync(`${file}${SIDECAR_SUFFIX}`, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

/** 展开 Windows/HOME 下的简单通配（只支持单层 *） */
function expandGlob(pattern: string): string[] {
  if (!pattern.includes("*")) return fs.existsSync(pattern) ? [pattern] : [];
  const segments = pattern.split(/[\\/]/);
  let bases = [segments[0].endsWith(":") ? `${segments[0]}${path.sep}` : segments[0]];
  for (const segment of segments.slice(1)) {
    const next: string[] = [];
    for (const base of bases) {
      if (segment === "*") {
        try {
          for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory()) next.push(path.join(base, entry.name));
          }
        } catch {
          /* 目录不存在 */
        }
      } else {
        next.push(path.join(base, segment));
      }
    }
    bases = next;
  }
  return bases.filter((candidate) => fs.existsSync(candidate));
}

function publicDir(): string {
  if (process.platform === "win32") return process.env.PUBLIC ?? "C:\\Users\\Public";
  return "/Users/Shared";
}

// ---------------------------------------------------------------- 各底座描述

export interface TargetDescriptor {
  id: string;
  label: string;
  /** 候选配置文件（返回已存在的绝对路径） */
  locate(): string[];
  /** 把配置改到接入状态 */
  sync(file: string, ctx: AttachContext): AttachResult;
  /** 退回接入前状态 */
  revert(file: string, ctx: AttachContext): AttachResult;
}

/** Loomy：provider.imodel.options.baseURL + mcp.dobocache */
const loomyTarget: TargetDescriptor = {
  id: "loomy",
  label: "Loomy 桌面端",
  locate() {
    const candidates: string[] = [];
    const fromEnv = process.env.LOOMY_OPENCODE_JSON;
    if (fromEnv) candidates.push(fromEnv);
    const roots = [
      path.join(publicDir(), "Loomy", "*", "opencode", "opencode.json"),
      path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Loomy", "*", "opencode", "opencode.json"),
      path.join(os.homedir(), "Library", "Application Support", "Loomy", "*", "opencode", "opencode.json"),
      path.join(os.homedir(), ".config", "Loomy", "*", "opencode", "opencode.json"),
    ];
    for (const pattern of roots) candidates.push(...expandGlob(pattern));
    return [...new Set(candidates.filter((file) => fs.existsSync(file)))];
  },
  sync(file, ctx) {
    return syncJsonTarget(file, ctx, {
      target: this.id,
      label: this.label,
      setBaseURL: (json) => {
        const options = ensureIn(json, ["provider", "imodel", "options"]);
        const want = `${ctx.proxyBase}/api/v1`;
        if (options.baseURL === want) return null;
        const before = typeof options.baseURL === "string" ? options.baseURL : "";
        options.baseURL = want;
        return `baseURL: ${before || "（空）"} -> ${want}`;
      },
    });
  },
  revert(file, ctx) {
    return revertJsonTarget(file, ctx, { target: this.id, label: this.label, baseURLKeys: ["provider", "imodel", "options", "baseURL"] });
  },
};

/** 通用 opencode：只写 MCP（上游各异，baseURL 不代猜） */
const opencodeTarget: TargetDescriptor = {
  id: "opencode",
  label: "opencode（通用）",
  locate() {
    const roots = [
      path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "opencode", "opencode.json"),
    ];
    return roots.filter((file) => fs.existsSync(file));
  },
  sync(file, ctx) {
    return syncJsonTarget(file, ctx, {
      target: this.id,
      label: this.label,
      setBaseURL: () => null,
      extraNote: "本底座只写 MCP；baseURL 请按你的上游手配到代理对应路由",
    });
  },
  revert(file, ctx) {
    return revertJsonTarget(file, ctx, { target: this.id, label: this.label, baseURLKeys: null });
  },
};

/** Claude Code：settings.json 的 env.ANTHROPIC_BASE_URL + ~/.claude.json 的 mcpServers */
const claudeCodeTarget: TargetDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  locate() {
    const roots = [
      path.join(os.homedir(), ".claude", "settings.json"),
      path.join(os.homedir(), ".claude.json"),
    ];
    return roots.filter((file) => fs.existsSync(file));
  },
  sync(file, ctx) {
    const isSettings = path.basename(file) === "settings.json";
    const json = readJson(file);
    const changes: string[] = [];

    if (isSettings) {
      const env = ensureIn(json, ["env"]);
      const want = `${ctx.proxyBase}/anthropic`;
      if (env.ANTHROPIC_BASE_URL !== want) {
        const before = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
        env.ANTHROPIC_BASE_URL = want;
        changes.push(`ANTHROPIC_BASE_URL: ${before || "（空）"} -> ${want}`);
      }
    } else {
      const servers = ensureIn(json, ["mcpServers"]);
      const want = { command: ctx.nodeExe, args: [ctx.bundlePath] };
      const cur = servers.dobocache;
      if (!isDict(cur) || cur.command !== want.command || JSON.stringify(cur.args) !== JSON.stringify(want.args)) {
        servers.dobocache = want;
        changes.push(`mcpServers.dobocache -> ${want.command} ${want.args.join(" ")}`);
      }
    }

    if (changes.length === 0) {
      return { target: this.id, label: this.label, configPath: file, status: "skipped", changes: [], detail: "已是接入状态" };
    }
    if (ctx.dryRun) {
      return { target: this.id, label: this.label, configPath: file, status: "dry-run", changes };
    }
    const bak = backup(file);
    writeJsonAtomic(file, json);
    writeSidecar(file, { target: this.id, configPath: file, savedAt: new Date().toISOString(), changes });
    return { target: this.id, label: this.label, configPath: file, status: "applied", changes, backup: bak };
  },
  revert(file, ctx) {
    const sidecar = readSidecar(file);
    if (!sidecar) {
      return { target: this.id, label: this.label, configPath: file, status: "skipped", changes: [], detail: "没有接入记录，未动" };
    }
    const json = readJson(file);
    const changes: string[] = [];

    if (path.basename(file) === "settings.json") {
      const env = ensureIn(json, ["env"]);
      if (typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL.startsWith(ctx.proxyBase)) {
        delete env.ANTHROPIC_BASE_URL;
        changes.push("已移除 env.ANTHROPIC_BASE_URL（回到官方默认）");
      }
    } else {
      const servers = asDict(json.mcpServers);
      if (isDict(servers.dobocache)) {
        delete servers.dobocache;
        changes.push("已移除 mcpServers.dobocache");
      }
    }

    if (changes.length === 0) {
      return { target: this.id, label: this.label, configPath: file, status: "skipped", changes: [], detail: "无需改动" };
    }
    if (ctx.dryRun) {
      return { target: this.id, label: this.label, configPath: file, status: "dry-run", changes };
    }
    backup(file);
    writeJsonAtomic(file, json);
    fs.rmSync(`${file}${SIDECAR_SUFFIX}`, { force: true });
    return { target: this.id, label: this.label, configPath: file, status: "applied", changes };
  },
};

interface SyncOptions {
  target: string;
  label: string;
  /** 返回 change 描述串；返回 null 表示无需改动 */
  setBaseURL: (json: Dict) => string | null;
  extraNote?: string;
}

function syncJsonTarget(file: string, ctx: AttachContext, opts: SyncOptions): AttachResult {
  const json = readJson(file);
  const changes: string[] = [];

  const baseChange = opts.setBaseURL(json);
  if (baseChange) changes.push(baseChange);

  const servers = ensureIn(json, ["mcp"]);
  const wantCommand = [ctx.nodeExe, ctx.bundlePath];
  const cur = servers.dobocache;
  const curCommand = isDict(cur) && Array.isArray(cur.command) ? (cur.command as unknown[]) : [];
  const sameCommand = curCommand.length === wantCommand.length && curCommand.every((part, i) => part === wantCommand[i]);
  if (!sameCommand) {
    servers.dobocache = { type: "local", command: wantCommand, enabled: true };
    changes.push(`mcp.dobocache -> ${wantCommand.join(" ")}`);
  } else if (isDict(cur) && cur.enabled !== true) {
    cur.enabled = true;
    changes.push("mcp.dobocache.enabled -> true");
  }

  if (changes.length === 0) {
    return { target: opts.target, label: opts.label, configPath: file, status: "skipped", changes: [], detail: "已是接入状态" };
  }
  if (ctx.dryRun) {
    return { target: opts.target, label: opts.label, configPath: file, status: "dry-run", changes, detail: opts.extraNote };
  }

  const bak = backup(file);
  writeJsonAtomic(file, json);
  writeSidecar(file, {
    target: opts.target,
    configPath: file,
    savedAt: new Date().toISOString(),
    baseURLBefore: getBeforeBaseURL(file, opts.label),
    changes,
  });
  return { target: opts.target, label: opts.label, configPath: file, status: "applied", changes, backup: bak, detail: opts.extraNote };
}

/** 备份文件里已经带旧值，这里返回一份便于回滚时参考（拿不到就空串） */
function getBeforeBaseURL(file: string, _label: string): string {
  try {
    const json = readJson(file);
    const options = asDict(asDict(asDict(json.provider).imodel).options);
    return typeof options.baseURL === "string" ? options.baseURL : "";
  } catch {
    return "";
  }
}

function revertJsonTarget(
  file: string,
  ctx: AttachContext,
  opts: { target: string; label: string; baseURLKeys: string[] | null },
): AttachResult {
  const sidecar = readSidecar(file);
  if (!sidecar) {
    return { target: opts.target, label: opts.label, configPath: file, status: "skipped", changes: [], detail: "没有接入记录，未动" };
  }
  const json = readJson(file);
  const changes: string[] = [];

  if (opts.baseURLKeys) {
    const before = typeof sidecar.baseURLBefore === "string" ? sidecar.baseURLBefore : "";
    if (before) {
      const parent = ensureIn(json, opts.baseURLKeys.slice(0, -1));
      const leaf = opts.baseURLKeys[opts.baseURLKeys.length - 1];
      if (parent[leaf] !== before) {
        parent[leaf] = before;
        changes.push(`baseURL 复原 -> ${before}`);
      }
    }
  }

  const mcp = asDict(json.mcp);
  if (isDict(mcp.dobocache)) {
    delete mcp.dobocache;
    changes.push("已移除 mcp.dobocache");
  }

  if (changes.length === 0) {
    return { target: opts.target, label: opts.label, configPath: file, status: "skipped", changes: [], detail: "无需改动" };
  }
  if (ctx.dryRun) {
    return { target: opts.target, label: opts.label, configPath: file, status: "dry-run", changes };
  }
  backup(file);
  writeJsonAtomic(file, json);
  fs.rmSync(`${file}${SIDECAR_SUFFIX}`, { force: true });
  return { target: opts.target, label: opts.label, configPath: file, status: "applied", changes };
}

export const TARGETS: TargetDescriptor[] = [loomyTarget, opencodeTarget, claudeCodeTarget];

export function findTargets(id?: string): TargetDescriptor[] {
  if (!id || id === "auto") return TARGETS;
  return TARGETS.filter((target) => target.id === id);
}

export function makeContext(port: number, dryRun: boolean): AttachContext {
  return {
    port,
    nodeExe: process.execPath,
    bundlePath: defaultBundlePath(),
    proxyBase: `http://127.0.0.1:${port}`,
    dryRun,
  };
}

/** 扫描所有底座，返回命中情况（不写盘） */
export function detect(): { id: string; label: string; files: string[] }[] {
  return TARGETS.map((target) => ({ id: target.id, label: target.label, files: target.locate() }));
}

/** 通用片段：任何底座都能照抄 */
export function renderGenericSnippet(ctx: AttachContext, routes: { prefix: string; baseUrl: string }[]): string {
  const lines: string[] = [];
  lines.push("把下面这段填进你的客户端配置（各家字段名略有差异，逻辑一致）：");
  lines.push("");
  lines.push("1) 模型 baseURL 指向本地代理（按你的上游选一条）：");
  for (const route of routes) {
    lines.push(`   ${route.baseUrl}  ->  ${ctx.proxyBase}${route.prefix}`);
  }
  lines.push("");
  lines.push("2) MCP 服务器（stdio）：");
  lines.push(`   command: ${ctx.nodeExe}`);
  lines.push(`   args:    ["${ctx.bundlePath}"]`);
  lines.push("");
  lines.push("3) 就这样——MCP 一被拉起，本地代理会自动跟着起来，不用另外起进程。");
  return lines.join("\n");
}

/** 端口上是否已有一个活着的 dobostitch 代理 */
export async function probeProxy(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/__dobostitch/health", method: "GET", timeout: 1200 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * 从客户端配置里把已经在用的本地端口挖出来。
 * 目的：用户之前手动接到某个端口（比如历史端口），attach 应该沿用而不是另起一个，
 * 否则会出现两个代理进程、缓存各算各的。
 */
export function collectLocalPorts(files: string[]): number[] {
  const ports = new Set<number>();
  const pattern = /https?:\/\/(?:127\.0\.0\.1|localhost)[:/](\d{2,5})/g;
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(pattern)) {
      const port = Number(match[1]);
      if (Number.isFinite(port) && port > 0 && port < 65536) ports.add(port);
    }
  }
  return [...ports];
}

/** 按优先级挑一个真正可用的端口：先看已在跑的，再看默认区间 */
export async function resolveAttachPort(files: string[]): Promise<{ port: number; reused: boolean }> {
  const known = collectLocalPorts(files);
  for (const port of known) {
    if (await probeProxy(port)) return { port, reused: true };
  }
  for (let port = DEFAULT_PORT; port <= DEFAULT_PORT + 9; port++) {
    if (await probeProxy(port)) return { port, reused: true };
  }
  return { port: DEFAULT_PORT, reused: false };
}

export function defaultPort(): number {
  return DEFAULT_PORT;
}

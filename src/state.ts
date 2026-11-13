/**
 * state.ts —— 记住"本机代理最终跑在哪个端口"
 *
 * 为什么需要：
 *   用户机器上代理端口不一定等于默认值（例如 attach 时沿用了已经在跑的 27950）。
 *   如果 bundle 只认默认端口，就会另起一个代理，导致"配置指向 A、缓存落在 B"。
 *   所以把最终端口记一份到 ~/.dobocache/state.json，所有入口（MCP bundle、
 *   开机自启、attach）都读它，保证全机只有一个端口口径。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PORT } from "./proxy/server.js";

export interface DobostitchState {
  port: number;
  updatedAt: string;
}

function stateFile(): string {
  return path.join(os.homedir(), ".dobocache", "state.json");
}

export function readState(): DobostitchState | null {
  try {
    const raw = fs.readFileSync(stateFile(), "utf-8");
    const data = JSON.parse(raw) as Partial<DobostitchState>;
    if (Number.isInteger(data.port) && (data.port as number) > 0 && (data.port as number) < 65536) {
      return { port: data.port as number, updatedAt: data.updatedAt ?? "" };
    }
  } catch {
    /* 没有就当作没记过 */
  }
  return null;
}

export function readLastPort(): number | null {
  return readState()?.port ?? null;
}

export function writeLastPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({ port, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
  } catch {
    /* 记不住也不能影响主流程 */
  }
}

/** 端口候选顺序：显式环境变量 > 上次记录的端口 > 默认端口（去重） */
export function portCandidates(explicitEnv?: string | number): number[] {
  const list: number[] = [];
  const rawEnv = typeof explicitEnv === "number" ? String(explicitEnv) : explicitEnv;
  const parsedEnv = rawEnv ? Number(rawEnv) : NaN;
  if (Number.isInteger(parsedEnv) && parsedEnv > 0 && parsedEnv < 65536) list.push(parsedEnv);
  const last = readLastPort();
  if (last) list.push(last);
  list.push(DEFAULT_PORT);
  return [...new Set(list)];
}

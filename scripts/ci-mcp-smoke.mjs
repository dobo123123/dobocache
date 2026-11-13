#!/usr/bin/env node
/**
 * CI 专用冒烟脚本（Linux / macOS 必跑，Windows 亦可本地跑）
 *
 * 覆盖两类只有"真实平台"才能证明的断言：
 *   1) MCP stdio 握手：initialize 返回 serverInfo{dobocache, <package version>}，
 *      tools/list 恰好 9 个工具（cf_ping + 8 个 cf_*）
 *   2) 日志目录解析：
 *        macOS  -> ~/Library/Logs/DoboCache
 *        Linux  -> $XDG_STATE_HOME/dobocache（本脚本显式注入 XDG_STATE_HOME）
 *        Windows-> %LOCALAPPDATA%\DoboCache\logs
 *      并要求 cf_report 返回的 logDirSource === "platform"（证明走平台分支，
 *      而不是 cwd 回退或 disabled），同时确认日志文件真的写出来了。
 *
 * 额外做一组纯函数断言（platformLogDir 三分支），使任一非 Windows runner
 * 都能顺带证明"另一平台"的路径规则未写错。
 *
 * 用法：node scripts/ci-mcp-smoke.mjs      （需要先 npm run build）
 * 退出码：0 全部通过；1 任一断言失败
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const ARTIFACT_DIR = path.join(REPO_ROOT, "ci-smoke-artifacts");

const EXPECTED_TOOLS = [
  "cf_ping",
  "cf_judge",
  "cf_tier",
  "cf_inject",
  "cf_meter",
  "cf_warmup",
  "cf_report",
  "cf_prune",
  "cf_normalize",
];

const failures = [];
const notes = [];

function ok(msg) {
  console.log(`  [PASS] ${msg}`);
}

function fail(msg, detail) {
  console.log(`  [FAIL] ${msg}`);
  if (detail !== undefined) {
    console.log(`         ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  failures.push(msg + (detail === undefined ? "" : ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`));
}

function assertEq(label, actual, expected) {
  if (actual === expected) ok(`${label} = ${expected}`);
  else fail(label, `期望 ${expected}，实际 ${actual}`);
}

/** 平台标准日志目录的期望值（与 src/utils/logDir.ts 的规则逐条对应，但独立书写，避免自证） */
function expectedPlatformLogDir({ env, platform, home }) {
  if (platform === "win32") {
    const localAppData = (env.LOCALAPPDATA ?? "").trim();
    const base = localAppData || path.join(home, "AppData", "Local");
    return path.join(base, "DoboCache", "logs");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Logs", "DoboCache");
  }
  const xdg = (env.XDG_STATE_HOME ?? "").trim();
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "dobocache");
  return path.join(home, ".local", "state", "dobocache");
}

class StdioClient {
  constructor(proc) {
    this.proc = proc;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.stdoutRaw = "";
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stdoutRaw += text;
      this.buffer += text;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 非 JSON-RPC 行（如 SDK 的调试输出）忽略
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(timer);
          if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result);
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

function dumpArtifacts(client) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, "stderr.txt"), client?.stderr ?? "", "utf-8");
    fs.writeFileSync(path.join(ARTIFACT_DIR, "stdout.jsonl"), client?.stdoutRaw ?? "", "utf-8");
    fs.writeFileSync(path.join(ARTIFACT_DIR, "failures.txt"), failures.join("\n"), "utf-8");
  } catch (err) {
    console.log(`（失败现场写入失败：${err.message}）`);
  }
}

async function main() {
  console.log(`== DoboCache CI 冒烟：platform=${process.platform} arch=${process.arch} node=${process.version} ==`);

  if (!fs.existsSync(SERVER_ENTRY)) {
    fail("服务端入口存在", `未找到 ${SERVER_ENTRY}，请先执行 npm run build`);
    return;
  }

  // ---------- 1. 纯函数分支断言（三分支路径规则） ----------
  console.log("\n[1/5] 日志目录路径规则（platformLogDir 三分支）");
  const logDirModule = await import(pathToFileURL(path.join(REPO_ROOT, "dist", "utils", "logDir.js")).href);
  const { platformLogDir } = logDirModule;
  // 期望值写成字面量（分隔符统一成 /），避免"用同一套 path.join 自证"
  const norm = (p) => String(p).replace(/\\/g, "/");
  assertEq("darwin(home=/Users/ci)", norm(platformLogDir({}, "darwin", "/Users/ci")), "/Users/ci/Library/Logs/DoboCache");
  assertEq(
    "linux(XDG_STATE_HOME=/tmp/xdg)",
    norm(platformLogDir({ XDG_STATE_HOME: "/tmp/xdg" }, "linux", "/home/ci")),
    "/tmp/xdg/dobocache",
  );
  assertEq(
    "linux(无 XDG → ~/.local/state)",
    norm(platformLogDir({}, "linux", "/home/ci")),
    "/home/ci/.local/state/dobocache",
  );
  assertEq(
    "win32(LOCALAPPDATA=C:\\Users\\ci\\AppData\\Local)",
    norm(platformLogDir({ LOCALAPPDATA: "C:\\Users\\ci\\AppData\\Local" }, "win32", "C:\\Users\\ci")),
    "C:/Users/ci/AppData/Local/DoboCache/logs",
  );

  // ---------- 2. 起真实进程（cwd 换到临时目录，排除 cwd 巧合） ----------
  console.log("\n[2/5] 启动 MCP Server（stdio）");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-ci-"));
  const env = { ...process.env };
  delete env.DOBOCACHE_LOG_DIR;
  delete env.CACHEFORGE_LOG_DIR;
  if (process.platform === "linux") {
    env.XDG_STATE_HOME = path.join(sandbox, "xdg-state");
  }
  const expectDir = expectedPlatformLogDir({ env, platform: process.platform, home: os.homedir() });
  notes.push(`cwd=${sandbox}`);
  notes.push(`期望日志目录=${expectDir}`);

  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: sandbox, env, stdio: ["pipe", "pipe", "pipe"] });
  const client = new StdioClient(proc);
  let exited = null;
  proc.on("exit", (code, signal) => {
    exited = { code, signal };
  });

  try {
    // ---------- 3. initialize + tools/list ----------
    console.log("\n[3/5] 握手：initialize / tools/list");
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "dobocache-ci-smoke", version: "1.0.0" },
    });
    const info = init?.serverInfo ?? {};
    assertEq("serverInfo.name", info.name, "dobocache");
    assertEq("serverInfo.version", info.version, pkg.version);
    if (typeof init?.protocolVersion === "string" && init.protocolVersion.length > 0) ok(`protocolVersion = ${init.protocolVersion}`);
    else fail("protocolVersion 存在", JSON.stringify(init));
    client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    const names = (listed?.tools ?? []).map((t) => t.name);
    assertEq("tools/list 数量", names.length, EXPECTED_TOOLS.length);
    const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));
    if (missing.length === 0 && extra.length === 0) ok(`9 个工具齐全：${names.join(", ")}`);
    else fail("工具集合与预期一致", `缺少=[${missing.join(",")}] 多出=[${extra.join(",")}]`);

    // ---------- 4. 真实写入一次日志再读 cf_report ----------
    console.log("\n[4/5] 工具调用：cf_judge（触发落盘）+ cf_report（读回日志目录）");
    await client.request("tools/call", {
      name: "cf_judge",
      arguments: {
        query: "CI 冒烟：把这段标准前缀复用到下一轮请求里",
        entries: [
          {
            id: "ci-smoke-entry",
            query: "把这段标准前缀复用到下一轮请求里",
            response: "已复用标准前缀",
            content: "把这段标准前缀复用到下一轮请求里\n已复用标准前缀",
          },
        ],
        threshold: 5,
        topK: 5,
      },
    });
    ok("cf_judge 调用返回");

    const reportRes = await client.request("tools/call", { name: "cf_report", arguments: { aggregateBy: "total" } });
    const text = (reportRes?.content ?? []).find((c) => c.type === "text")?.text ?? "";
    let report;
    try {
      report = JSON.parse(text);
    } catch {
      fail("cf_report 返回可解析 JSON", text.slice(0, 400));
    }
    if (report) {
      // ---------- 5. 日志目录断言 ----------
      console.log("\n[5/5] 日志目录解析断言");
      assertEq("cf_report.logDirSource", report.logDirSource, "platform");
      assertEq("cf_report.logDir", report.logDir, expectDir);
      if (typeof report.logFile === "string" && report.logFile.startsWith(report.logDir)) ok(`logFile 位于日志目录内：${path.basename(report.logFile)}`);
      else fail("logFile 位于日志目录内", String(report.logFile));
      if (fs.existsSync(report.logDir)) ok(`日志目录已创建：${report.logDir}`);
      else fail("日志目录已创建", report.logDir);
      if (report.logFile && fs.existsSync(report.logFile)) ok(`日志文件已写入：${path.basename(report.logFile)}`);
      else fail("日志文件已写入", String(report.logFile));
      // 断言每个平台的"另一分支"没有被误用
      if (process.platform === "darwin") {
        if (report.logDir.includes("Library/Logs/DoboCache")) ok("macOS 分支命中 ~/Library/Logs/DoboCache");
        else fail("macOS 分支命中 ~/Library/Logs/DoboCache", report.logDir);
        if (report.logDir.includes(path.join(".local", "state"))) fail("未误用 Linux 分支", report.logDir);
        else ok("未误用 Linux 分支");
      }
      if (process.platform === "linux") {
        const xdg = env.XDG_STATE_HOME;
        if (xdg && report.logDir === path.join(xdg, "dobocache")) ok(`Linux 分支命中 $XDG_STATE_HOME/dobocache（${xdg}）`);
        else fail("Linux 分支命中 $XDG_STATE_HOME/dobocache", report.logDir);
        if (report.logDir.includes("Library/Logs")) fail("未误用 macOS 分支", report.logDir);
        else ok("未误用 macOS 分支");
      }
    }
  } catch (err) {
    fail("冒烟执行异常", err?.message ?? String(err));
  } finally {
    try {
      proc.stdin.end();
    } catch {
      /* 忽略 */
    }
    proc.kill();
  }

  if (exited && exited.code !== 0 && exited.code !== null) {
    // 正常退出前 kill 掉，code 为 null/signal；非零退出视为服务端崩溃
    fail("服务端未异常退出", `code=${exited.code} signal=${exited.signal}`);
  }
  if (client.stderr.trim()) console.log(`\n服务端 stderr（前 500 字）：\n${client.stderr.trim().slice(0, 500)}`);

  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }

  console.log("\n== 汇总 ==");
  notes.forEach((n) => console.log(`  · ${n}`));
  if (failures.length > 0) {
    dumpArtifacts(client);
    console.log(`\n[FAILED] ${failures.length} 项断言失败（现场已写入 ci-smoke-artifacts/）`);
    process.exit(1);
  }
  console.log(`\n[OK] 全部断言通过（platform=${process.platform}）`);
}

main().catch((err) => {
  console.log(`[FAIL] 未捕获异常：${err?.stack ?? err}`);
  dumpArtifacts(null);
  process.exit(1);
});

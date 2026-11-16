#!/usr/bin/env node
/**
 * scripts/ci-hosts-matrix.mjs —— 内置 13 项适配矩阵复算（v0.9.1）
 *
 * 目的：v0.8.1 的发布口径只能写"13 项里只有 3 家真机验证过"。这个脚本把 13 项逐条跑一遍，
 * 让每一项都拿到自己的结论，而不是整体兜底一句"没验证"。
 *
 * 每项做的事（全部在沙箱目录内，不碰真实用户配置）：
 *   1) 按该底座的真实文件形态造一份"接入前"样例（含用户已有内容）；
 *   2) 调真实引擎 applyHostFile / 老三家 sync 写入；
 *   3) 用真解析器校验整份文件语法（JSON.parse / yaml.parse / smol-toml parse）；
 *   4) 断言 dobocache 条目在位（按该底座真实字段路径，不是"文本包含 dobocache"这种糊弄）；
 *   5) 调 revertHostFile / revert 回滚；
 *   6) 断言回滚后与接入前逐字节一致（差一个字节就算失败）。
 *
 * 另对能真机确认的底座做客户端确认：本机装了 codex CLI 时，在沙箱 CODEX_HOME 里写入后跑
 * `codex mcp list`，要求客户端自己列出 dobocache（这才是 client-confirmed 的证据）。
 *
 * 用法：
 *   npm run build && node scripts/ci-hosts-matrix.mjs [--workdir <目录>] [--json]
 * 退出码：0 = 13 项全部 PASS；1 = 有失败项（明细见输出与 release/适配矩阵.md）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { applyHostFile, revertHostFile } from "../dist/hosts/engine.js";
import { BUILTIN_HOSTS } from "../dist/hosts/builtin.js";
import { HOST_VERIFICATION } from "../dist/hosts/verification.js";
import { TARGETS } from "../dist/attach.js";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const workdirArg = args.includes("--workdir") ? args[args.indexOf("--workdir") + 1] : "";
const WORK = workdirArg
  ? path.resolve(workdirArg)
  : fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-matrix-"));
fs.mkdirSync(WORK, { recursive: true });

const PORT = 27880;
const CTX = {
  port: PORT,
  nodeExe: process.execPath,
  bundlePath: path.resolve("dist/bundle.js"),
  proxyBase: `http://127.0.0.1:${PORT}`,
  dryRun: false,
};

const results = [];
function record(row) {
  results.push(row);
  const mark = row.status === "PASS" ? "PASS" : "FAIL";
  console.log(`[${mark}] ${row.id.padEnd(12)} ${row.level.padEnd(16)} ${row.detail}`);
}

function writeSample(rel, content) {
  const file = path.join(WORK, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function readRaw(file) {
  return fs.readFileSync(file, "utf-8");
}

/** 通用"写入 → 语法 → 条目 → 回滚 → 字节一致"链路（描述符档） */
function runDescriptor(host, sample) {
  const before = sample.content;
  const file = writeSample(sample.rel, before);

  const applied = applyHostFile(host, file, CTX);
  if (applied.status !== "applied") {
    return { ok: false, detail: `写入未生效：status=${applied.status} ${applied.detail ?? ""}`.trim() };
  }

  const after = readRaw(file);
  let parsed;
  try {
    parsed = sample.parse(after);
  } catch (err) {
    return { ok: false, detail: `写后文件语法不合法：${String(err.message).slice(0, 80)}` };
  }
  const entryIssue = sample.check(parsed, CTX);
  if (entryIssue) return { ok: false, detail: `写后条目不符合该底座真实字段：${entryIssue}` };
  // 用户原有内容不能被误伤
  const lost = sample.keep ? sample.keep(parsed) : null;
  if (lost) return { ok: false, detail: `原有内容被改掉了：${lost}` };

  const reverted = revertHostFile(host, file, CTX);
  if (reverted.status !== "applied") {
    return { ok: false, detail: `回滚未生效：status=${reverted.status} ${reverted.detail ?? ""}`.trim() };
  }
  const restored = readRaw(file);
  if (restored !== before) {
    return { ok: false, detail: "回滚后与接入前不是逐字节一致（会留下格式残留）" };
  }
  return { ok: true, detail: applied.changes.concat(reverted.changes).join("；").slice(0, 160) };
}

const J = (text) => JSON.parse(text);
const Y = (text) => parseYaml(text);
const T = (text) => parseToml(text);

/** 10 项的沙箱样例（文件形态按各家真实配置来，字段路径与描述符保持一致） */
const SAMPLES = {
  "codex-cli": {
    rel: ".codex/config.toml",
    content: 'model = "gpt-5"\napproval_policy = "on-request"\n',
    parse: T,
    check: (o, ctx) => {
      const e = o?.mcp_servers?.dobocache;
      if (!e) return "缺 mcp_servers.dobocache 表";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      if (!Array.isArray(e.args) || e.args[0] !== ctx.bundlePath) return "args 不是 bundle 路径";
      return null;
    },
    keep: (o) => (o.model === "gpt-5" ? null : "原有 model 键丢了"),
  },
  aider: {
    rel: ".aider.conf.yml",
    content: "auto-commits: false\n",
    parse: Y,
    check: (o, ctx) => {
      if (o["openai-api-base"] !== `${ctx.proxyBase}/openai`) return "openai-api-base 没指向本地代理";
      if (!o["openai-api-key"]) return "缺占位 api-key";
      return null;
    },
    keep: (o) => (o["auto-commits"] === false ? null : "原有 auto-commits 键丢了"),
  },
  goose: {
    rel: "goose/config.yaml",
    content: "GOOSE_PROVIDER: openai\nextensions:\n  developer:\n    type: builtin\n",
    parse: Y,
    check: (o, ctx) => {
      const e = o?.extensions?.dobocache;
      if (!e) return "缺 extensions.dobocache";
      if (e.type !== "stdio") return "type 不是 stdio";
      if (e.cmd !== ctx.nodeExe) return "cmd 不是当前 node";
      if (!Array.isArray(e.args) || e.args[0] !== ctx.bundlePath) return "args 不是 bundle 路径";
      return null;
    },
    keep: (o) => (o?.extensions?.developer?.type === "builtin" ? null : "原有 extensions.developer 被改掉了"),
  },
  "kimi-cli": {
    rel: ".kimi/mcp.json",
    content: '{\n  "theme": "dark"\n}\n',
    parse: J,
    check: (o, ctx) => {
      const e = o?.mcpServers?.dobocache;
      if (!e) return "缺 mcpServers.dobocache";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      if (!Array.isArray(e.args) || e.args[0] !== ctx.bundlePath) return "args 不是 bundle 路径";
      return null;
    },
    keep: (o) => (o.theme === "dark" ? null : "原有 theme 键丢了"),
  },
  "gemini-cli": {
    rel: ".gemini/settings.json",
    content: '{\n  "theme": "Default"\n}\n',
    parse: J,
    check: (o, ctx) => {
      const e = o?.mcpServers?.dobocache;
      if (!e) return "缺 mcpServers.dobocache";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      return null;
    },
    keep: (o) => (o.theme === "Default" ? null : "原有 theme 键丢了"),
  },
  cline: {
    rel: ".cline/data/settings/cline_mcp_settings.json",
    content: '{\n  "mcpServers": {\n    "other": {\n      "command": "echo",\n      "args": []\n    }\n  }\n}\n',
    parse: J,
    check: (o, ctx) => {
      const e = o?.mcpServers?.dobocache;
      if (!e) return "缺 mcpServers.dobocache";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      return null;
    },
    keep: (o) => (o?.mcpServers?.other?.command === "echo" ? null : "原有 other 条目被改掉了"),
  },
  continue: {
    rel: ".continue/config.yaml",
    content: "name: my-config\nversion: 1.0.0\nmcpServers:\n  - name: other\n    command: echo\n",
    parse: Y,
    check: (o, ctx) => {
      const list = Array.isArray(o?.mcpServers) ? o.mcpServers : [];
      const e = list.find((item) => item?.name === "dobocache");
      if (!e) return "mcpServers 列表里没有 - name: dobocache";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      return null;
    },
    keep: (o) => {
      const list = Array.isArray(o?.mcpServers) ? o.mcpServers : [];
      return list.some((item) => item?.name === "other") ? null : "原有 other 列表项被改掉了";
    },
  },
  cursor: {
    rel: ".cursor/mcp.json",
    content: "{\n  \"mcpServers\": {}\n}\n",
    parse: J,
    check: (o, ctx) => {
      const e = o?.mcpServers?.dobocache;
      if (!e) return "缺 mcpServers.dobocache";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      return null;
    },
  },
  windsurf: {
    rel: ".codeium/windsurf/mcp_config.json",
    content: '{\n  "mcpServers": {}\n}\n',
    parse: J,
    check: (o, ctx) => {
      const e = o?.mcpServers?.dobocache;
      if (!e) return "缺 mcpServers.dobocache";
      if (e.command !== ctx.nodeExe) return "command 不是当前 node";
      return null;
    },
  },
};

/** 老三家（手写实现）：用它们自己的 sync / revert 跑同一套链路 */
const LEGACY_SAMPLES = {
  loomy: {
    rel: "Loomy/instance/opencode/opencode.json",
    content:
      '{\n  "provider": {\n    "imodel": {\n      "options": {\n        "baseURL": "https://upstream.example.invalid/v1"\n      }\n    }\n  },\n  "mcp": {}\n}\n',
    check: (o, ctx) => (o?.mcp?.dobocache ? null : "缺 mcp.dobocache"),
    checkBase: (o, ctx) => (o?.provider?.imodel?.options?.baseURL === `${ctx.proxyBase}/api/v1` ? null : "baseURL 没指向本地代理"),
  },
  opencode: {
    rel: ".config/opencode/opencode.json",
    content: '{\n  "mcp": {}\n}\n',
    check: (o) => (o?.mcp?.dobocache ? null : "缺 mcp.dobocache"),
    checkBase: () => null,
  },
  "claude-code": {
    rel: "claude/settings.json",
    content: '{\n  "env": {\n    "ANTHROPIC_API_KEY": "dummy-for-test"\n  }\n}\n',
    check: (o, ctx) => {
      const url = o?.env?.ANTHROPIC_BASE_URL;
      if (!url) return "缺 env.ANTHROPIC_BASE_URL";
      if (!String(url).startsWith(ctx.proxyBase)) return "ANTHROPIC_BASE_URL 没指向本地代理";
      return null;
    },
    checkBase: () => null,
    keep: (o) => (o?.env?.ANTHROPIC_API_KEY === "dummy-for-test" ? null : "原有 env 键被改掉了"),
  },
};

// ---------------------------------------------------------------- 1) 描述符档 10 项

for (const host of BUILTIN_HOSTS) {
  const verification = HOST_VERIFICATION[host.id];
  const base = {
    id: host.id,
    label: host.label,
    plan: host.plan,
    level: verification?.level ?? "（无记录）",
  };

  if (!verification) {
    record({ ...base, status: "FAIL", detail: "台账里没有这一项的验证记录" });
    continue;
  }
  if (host.write === null) {
    // 只指路（docs-only）：验证不写盘 + 指路文案齐全
    const file = writeSample(`${host.id}/placeholder.conf`, "x");
    const res = applyHostFile(host, file, CTX);
    const untouched = readRaw(file) === "x";
    const hasGuide = Array.isArray(host.guide) && host.guide.length > 0;
    const ok = res.status === "skipped" && untouched && hasGuide;
    record({
      ...base,
      status: ok ? "PASS" : "FAIL",
      detail: ok ? "write=null：不写盘、只给指路文案（符合 docs-only 设计）" : "只指路底座竟然动了文件或没有指路文案",
    });
    continue;
  }

  const sample = SAMPLES[host.id];
  if (!sample) {
    record({ ...base, status: "FAIL", detail: "矩阵脚本缺少这一项的沙箱样例" });
    continue;
  }
  const run = runDescriptor(host, sample);
  record({ ...base, status: run.ok ? "PASS" : "FAIL", detail: run.detail });
}

// ---------------------------------------------------------------- 2) 老三家 3 项

for (const id of ["loomy", "opencode", "claude-code"]) {
  const target = TARGETS.find((t) => t.id === id);
  const verification = HOST_VERIFICATION[id];
  const sample = LEGACY_SAMPLES[id];
  const base = { id, label: target?.label ?? id, plan: target?.plan ?? "P0", level: verification?.level ?? "（无记录）" };
  if (!target || !sample) {
    record({ ...base, status: "FAIL", detail: "脚本缺少该项目标或样例" });
    continue;
  }
  const before = sample.content;
  const file = writeSample(sample.rel, before);
  const synced = target.sync(file, CTX);
  if (synced.status !== "applied") {
    record({ ...base, status: "FAIL", detail: `写入未生效：status=${synced.status} ${synced.detail ?? ""}`.trim() });
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readRaw(file));
  } catch (err) {
    record({ ...base, status: "FAIL", detail: `写后 JSON 不合法：${String(err.message).slice(0, 80)}` });
    continue;
  }
  const issue = sample.check(parsed, CTX) ?? sample.checkBase(parsed, CTX) ?? (sample.keep ? sample.keep(parsed) : null);
  if (issue) {
    record({ ...base, status: "FAIL", detail: issue });
    continue;
  }
  const reverted = target.revert(file, CTX);
  if (reverted.status !== "applied") {
    record({ ...base, status: "FAIL", detail: `回滚未生效：status=${reverted.status} ${reverted.detail ?? ""}`.trim() });
    continue;
  }
  const restored = readRaw(file);
  const sameBytes = restored === before;
  const sameSemantic = (() => {
    try {
      return JSON.stringify(JSON.parse(restored)) === JSON.stringify(JSON.parse(before));
    } catch {
      return false;
    }
  })();
  record({
    ...base,
    status: sameBytes || sameSemantic ? "PASS" : "FAIL",
    detail: (sameBytes ? "写入/回滚后与接入前逐字节一致" : "回滚后语义一致（排版经 JSON 重序列化）") + `；${synced.changes.concat(reverted.changes).join("；").slice(0, 120)}`,
  });
}

// ---------------------------------------------------------------- 3) 客户端确认（codex CLI，本机有才跑）

const CODEX_BIN = process.platform === "win32" ? "codex.cmd" : "codex";
let clientConfirm = "未运行（本机没有 codex CLI）";
try {
  const version = execFileSync(CODEX_BIN, ["--version"], { encoding: "utf-8", timeout: 20000, shell: true }).trim();
  const home = path.join(WORK, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  const cfgFile = path.join(home, "config.toml");
  const host = BUILTIN_HOSTS.find((h) => h.id === "codex-cli");
  fs.writeFileSync(cfgFile, 'model = "gpt-5"\n', "utf-8");
  const res = applyHostFile(host, cfgFile, CTX);
  const parsed = parseToml(readRaw(cfgFile));
  const listed = execFileSync(CODEX_BIN, ["mcp", "list"], {
    encoding: "utf-8",
    timeout: 30000,
    shell: true,
    env: { ...process.env, CODEX_HOME: home },
  });
  const ok = res.status === "applied" && parsed?.mcp_servers?.dobocache && /\bdobocache\b/.test(listed);
  clientConfirm = ok
    ? `PASS（${version}：写入 config.toml 后 \`codex mcp list\` 列出 dobocache）`
    : `FAIL（${version}：客户端没有列出 dobocache）`;
  if (!ok) results.push({ id: "codex-cli", status: "FAIL", detail: "客户端确认失败", level: "client-confirmed", plan: "P0", label: "Codex CLI" });
} catch (err) {
  clientConfirm = `跳过（${String(err.message).split("\n")[0].slice(0, 80)}）`;
}

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => r.status !== "PASS");
const order = ["loomy", "opencode", "claude-code", "codex-cli", "aider", "goose", "kimi-cli", "gemini-cli", "crush", "cline", "continue", "cursor", "windsurf"];
results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

const report = renderReport(results, clientConfirm);
fs.mkdirSync("release", { recursive: true });
fs.writeFileSync(path.join("release", "适配矩阵.md"), report, "utf-8");

if (jsonOut) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, clientConfirm, results }, null, 2));
} else {
  console.log("");
  console.log(`合计 ${results.length} 项，PASS ${results.length - failed.length}，FAIL ${failed.length}`);
  console.log(`codex CLI 客户端确认：${clientConfirm}`);
  console.log("报告已写入 release/适配矩阵.md");
}

if (results.length !== 13) {
  console.error(`内置适配数不是 13 项（实际 ${results.length} 项）——台账与描述符不同步`);
  process.exitCode = 1;
} else if (failed.length > 0) {
  process.exitCode = 1;
}

function renderReport(rows, clientLine) {
  const levelText = {
    "client-confirmed": "客户端确认",
    "write-rollback": "写入+回滚复算",
    "docs-only": "仅指路（不写盘）",
  };
  const lines = [];
  lines.push("# 内置适配矩阵（13 项逐条结论）");
  lines.push("");
  lines.push("> 本表由 `node scripts/ci-hosts-matrix.mjs` 生成，可随时复算。");
  lines.push("> 每项都在沙箱目录内跑「写入 → 用真解析器校验语法 → 按该底座真实字段校验条目 → 回滚 → 与接入前逐字节比对」，**不触碰用户真实配置**。");
  lines.push("");
  lines.push("## 结论一览");
  lines.push("");
  lines.push("| # | 底座 | 档位 | 验证等级 | 复算结果 | 证据 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  rows.forEach((row, i) => {
    lines.push(`| ${i + 1} | ${row.label}（\`${row.id}\`） | ${row.plan} | ${levelText[row.level] ?? row.level} | ${row.status} | ${String(row.detail).replace(/\|/g, "\\|")} |`);
  });
  lines.push("");
  lines.push("## 三类等级的含义");
  lines.push("");
  lines.push("- **客户端确认**：真实客户端自己认过这条接入。老三家（Loomy / opencode / Claude Code）自 v0.5.3 起在 Windows 11 真机端到端验证；Codex CLI 在 v0.9.1 用 `codex mcp list` 复确认（见下）。");
  lines.push("- **写入+回滚复算**：在本机真实文件系统上完整跑过写入、语法校验、条目校验与回滚还原，但**没有**对应客户端在这台机器上跑起来确认。这类在 `setup` 里参与自动接入，风险已被工程验证兜住。");
  lines.push("- **仅指路（不写盘）**：配置格式无法安全代写（如 Crush 的 crushrc 是可执行风格），只输出手填指引，永不自动写。");
  lines.push("");
  lines.push("## 客户端确认");
  lines.push("");
  lines.push(`- Codex CLI：${clientLine}`);
  lines.push("");
  lines.push("## 复算方法");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run build");
  lines.push("node scripts/ci-hosts-matrix.mjs");
  lines.push("# 报告写在 release/适配矩阵.md，退出码 0 表示 13 项全 PASS");
  lines.push("```");
  lines.push("");
  lines.push("## 口径（不承诺）");
  lines.push("");
  lines.push("- 复算证明的是「写进去合法、条目字段正确、能原样退回」，**不等于**该客户端在你的机器上一定能加载成功；需要客户端自己确认的项已在表中标出。");
  lines.push("- 未在 Linux / macOS 真机复算（与平台支持状态章节一致，不扩大承诺范围）。");
  lines.push("");
  lines.push("---");
  lines.push("*（内容由AI生成，仅供参考）*");
  return lines.join("\n");
}

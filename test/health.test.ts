/**
 * hosts/health.test.ts —— v0.7.3 接入体检用例
 *
 * 体检的价值在于"错法能被认出来"，所以每个用例都故意造一种坏法：
 * 条目被删、JSON 写坏、脚本路径失效、受管块标记丢失。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyHostFile, revertHostFile } from "../src/hosts/engine.js";
import { checkHost, checkHostFile, summarizeHealth } from "../src/hosts/health.js";
import { getHost } from "../src/hosts/registry.js";
import { makeContext } from "../src/attach.js";

function ctxAt(port: number, bundlePath: string) {
  const ctx = makeContext(port, false);
  return { ...ctx, bundlePath };
}

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobostitch-health-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("体检 · JSON 底座", () => {
  it("正常接入后判为 ok", () => {
    const dir = tempDir();
    const file = path.join(dir, "mcp.json");
    const bundle = path.join(dir, "index.js");
    fs.writeFileSync(bundle, "// stub", "utf-8");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");

    const host = getHost("cline")!;
    const applied = applyHostFile(host, file, ctxAt(4321, bundle));
    expect(applied.status).toBe("applied");

    const health = checkHostFile(host, file, { bundlePath: bundle });
    expect(health.level).toBe("ok");
  });

  it("用户把条目删掉后判为提示（文件本身还能用）", () => {
    const dir = tempDir();
    const file = path.join(dir, "mcp.json");
    const bundle = path.join(dir, "index.js");
    fs.writeFileSync(bundle, "// stub", "utf-8");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");

    const host = getHost("cline")!;
    applyHostFile(host, file, ctxAt(4321, bundle));
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");

    const health = checkHostFile(host, file, { bundlePath: bundle });
    expect(health.level).toBe("warn");
    expect(health.checks.some((check) => check.name === "MCP 条目" && check.level === "warn")).toBe(true);
  });

  it("配置被写坏（JSON 不合法）判为 broken", () => {
    const dir = tempDir();
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, '{ "mcpServers": { "dobocache": { }, } }', "utf-8");
    const host = getHost("cline")!;
    const health = checkHostFile(host, file);
    expect(health.level).toBe("broken");
    expect(health.checks.some((check) => check.name === "配置可解析" && check.level === "broken")).toBe(true);
  });

  it("包文件被删后判为 broken（MCP 起不来）", () => {
    const dir = tempDir();
    const file = path.join(dir, "mcp.json");
    const bundle = path.join(dir, "index.js");
    fs.writeFileSync(bundle, "// stub", "utf-8");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");

    const host = getHost("cline")!;
    applyHostFile(host, file, ctxAt(4321, bundle));
    fs.rmSync(bundle);

    const health = checkHostFile(host, file);
    expect(health.level).toBe("broken");
    expect(health.checks.some((check) => check.name === "启动脚本" && check.level === "broken")).toBe(true);
  });
});

describe("体检 · 受管块底座", () => {
  it("回滚后受管块消失，体检报提示", () => {
    const dir = tempDir();
    const file = path.join(dir, "config.toml");
    const bundle = path.join(dir, "index.js");
    fs.writeFileSync(bundle, "// stub", "utf-8");
    fs.writeFileSync(file, 'model = "gpt-5"\n', "utf-8");

    const host = getHost("codex-cli")!;
    expect(applyHostFile(host, file, ctxAt(4321, bundle)).status).toBe("applied");
    expect(checkHostFile(host, file, { bundlePath: bundle }).level).toBe("ok");

    expect(revertHostFile(host, file, ctxAt(4321, bundle)).status).toBe("applied");
    const after = checkHostFile(host, file, { bundlePath: bundle });
    expect(after.level).toBe("warn");
    expect(after.checks.some((check) => check.name === "受管块" && check.level === "warn")).toBe(true);
  });
});

describe("体检 · 汇总", () => {
  it("没有底座时汇总为零，不报警", () => {
    expect(summarizeHealth([])).toMatchObject({ ok: 0, warn: 0, broken: 0 });
  });

  it("没有配置文件的底座返回 ok（未装不算坏）", () => {
    const host = getHost("cline")!;
    const health = checkHost(host, []);
    expect(health.level).toBe("ok");
    expect(health.attached).toBe(false);
  });
});

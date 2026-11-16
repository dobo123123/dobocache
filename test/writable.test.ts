/**
 * writable.test.ts —— v0.8.1 写入前权限预检
 *
 * 守一条：写不进去的时候，必须在动手之前就知道，而不是备份完、写到一半才失败。
 * 预检不通过 → 一个字节都不碰，交给用户手工粘片段（attach 会自动打出片段）。
 *
 * 预检本身是纯只读的：不创建、不修改任何文件，测试里也要把这条钉住。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyHostFile } from "../src/hosts/engine.js";
import { checkHostFile } from "../src/hosts/health.js";
import { probeWritable } from "../src/hosts/paths.js";
import { getHost } from "../src/hosts/registry.js";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-writable-"));
}

const CTX = {
  nodeExe: path.join("C:", "Program Files", "nodejs", "node.exe"),
  bundlePath: path.join("C:", "dobo", "dist", "bundle.js"),
  proxyBase: "http://127.0.0.1:27880",
  port: 27880,
  dryRun: false,
};

describe("写入前预检 probeWritable", () => {
  it("已存在且可写的文件判为可写", () => {
    const dir = scratch();
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, "{}\n", "utf-8");

    const probe = probeWritable(file);
    expect(probe.writable).toBe(true);
    expect(probe.probePath).toBe(file);
  });

  it("文件不存在但父目录在：判为可写，探的是父目录", () => {
    const dir = scratch();
    const file = path.join(dir, "not-created-yet.json");

    const probe = probeWritable(file);
    expect(probe.writable).toBe(true);
    expect(probe.probePath).toBe(dir);
    // 预检是只读的：探完了文件也不许出现
    expect(fs.existsSync(file)).toBe(false);
  });

  it("上级目录都不存在：判为不可写，且不顺手创建目录", () => {
    const dir = scratch();
    const file = path.join(dir, "no-such-sub", "deeper", "mcp.json");

    const probe = probeWritable(file);
    expect(probe.writable).toBe(false);
    expect(probe.reason).toBeTruthy();
    expect(fs.existsSync(path.join(dir, "no-such-sub"))).toBe(false);
  });

  it("文件带只读属性：判为不可写，原因里说清是不可写", () => {
    const dir = scratch();
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, "{}\n", "utf-8");
    fs.chmodSync(file, 0o444);
    try {
      const probe = probeWritable(file);
      // Windows 上 chmod 444 = 只读属性；以管理员身份运行时个别环境仍可写，
      // 那种情况只校验探针给出了明确结论，不把平台差异写成断言。
      if (probe.writable) {
        expect(probe.probePath).toBe(file);
      } else {
        expect(probe.probePath).toBe(file);
        expect(probe.reason).toContain("不可写");
      }
    } finally {
      fs.chmodSync(file, 0o666);
    }
  });
});

describe("预检接进写入引擎", () => {
  it("只读文件：直接跳过、标记 writeBlocked，文件内容一个字节不变", () => {
    const dir = scratch();
    const file = path.join(dir, "mcp.json");
    const before = '{ "mcpServers": {} }\n';
    fs.writeFileSync(file, before, "utf-8");
    fs.chmodSync(file, 0o444);
    try {
      const host = getHost("cline")!;
      const result = applyHostFile(host, file, CTX);
      expect(result.status).toBe("skipped");
      expect(result.writeBlocked).toBe(true);
      expect(result.detail).toContain("写入前预检未通过");
      // 最关键的一条：没写就没副作用
      expect(fs.readFileSync(file, "utf-8")).toBe(before);
      // 也不许留下备份文件
      const leftovers = fs.readdirSync(dir).filter((name) => name.includes("bak"));
      expect(leftovers).toEqual([]);
    } finally {
      fs.chmodSync(file, 0o666);
    }
  });

  it("目标路径的上级目录不存在：同样跳过并标记，不抛异常", () => {
    const dir = scratch();
    const file = path.join(dir, "missing-dir", "mcp.json");
    const host = getHost("cline")!;

    const result = applyHostFile(host, file, CTX);
    expect(result.status).toBe("skipped");
    expect(result.writeBlocked).toBe(true);
    expect(fs.existsSync(path.join(dir, "missing-dir"))).toBe(false);
  });
});

describe("预检接进体检", () => {
  it("只读文件的体检给出「可写性」提示，但不判 broken", () => {
    const dir = scratch();
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");
    fs.chmodSync(file, 0o444);
    try {
      const host = getHost("cline")!;
      const health = checkHostFile(host, file);
      const check = health.checks.find((item) => item.name === "可写性");
      expect(check).toBeTruthy();
      if (!probeWritable(file).writable) {
        expect(check!.level).toBe("warn");
        expect(health.level).not.toBe("broken");
      }
    } finally {
      fs.chmodSync(file, 0o666);
    }
  });
});

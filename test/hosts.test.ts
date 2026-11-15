/**
 * hosts.test.ts —— v0.7.0 描述符注册表 / 受管块写入 / 通用引擎的回归测试
 *
 * 重点守的三条：
 *   1) 幂等：同一份配置跑两遍，第二遍不许产生 diff
 *   2) 可回滚：--revert 之后文件必须和接入前一模一样（其余内容一个字不动）
 *   3) 宁可不写：解析不了 / 锚点缺失 / 键冲突时一律拒绝，不许"猜着写"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findBlock, removeBlock, upsertBlock } from "../src/hosts/managedBlock.js";
import { applyHostFile, buildMcpEntry, readJsonStrict, revertHostFile } from "../src/hosts/engine.js";
import { getHost, listHosts, loadExternalHosts } from "../src/hosts/registry.js";
import type { HostDescriptor } from "../src/hosts/types.js";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-hosts-"));
}

const CTX = {
  nodeExe: path.join("C:", "Program Files", "nodejs", "node.exe"),
  bundlePath: path.join("C:", "dobo", "dist", "bundle.js"),
  proxyBase: "http://127.0.0.1:27880",
  port: 27880,
  dryRun: false,
};

function blockText(text: string): string {
  const lines = text.split(/\r?\n/);
  const range = findBlock(lines);
  if (!range) return "";
  return lines.slice(range.start, range.end + 1).join("\n");
}

describe("受管块写入器 managedBlock", () => {
  it("首次插入 → 再次写入整段替换（幂等）→ 回滚后与原文件一致", () => {
    const original = "theme: dark\n";
    const first = upsertBlock(original, "dobocache:\n  type: stdio", { appendIfMissing: true });
    expect(first.action).toBe("appended");
    expect(blockText(first.text)).toContain("dobocache:");

    const again = upsertBlock(first.text, "dobocache:\n  type: stdio", { appendIfMissing: true });
    expect(again.action).toBe("replaced");
    expect(again.text).toBe(first.text);

    const back = removeBlock(first.text);
    expect(back.removed).toBe(true);
    expect(back.text).toBe(original);
  });

  it("锚点存在时插到锚点下一层，并跟随锚点缩进", () => {
    const original = ["extensions:", "  other:", "    enabled: true", ""].join("\n");
    const result = upsertBlock(original, "dobocache:\n  type: stdio", { anchor: "extensions" });
    expect(result.action).toBe("inserted-anchor");
    const lines = result.text.split("\n");
    const anchorIndex = lines.indexOf("extensions:");
    expect(lines[anchorIndex + 1]).toBe("# >>> dobocache managed block begin");
    expect(lines[anchorIndex + 2]).toBe("  dobocache:");
    expect(removeBlock(result.text).text).toBe(original);
  });

  it("锚点缺失且未允许追加 → 拒绝写入（不猜层级）", () => {
    const result = upsertBlock("a: 1\n", "dobocache:\n  type: stdio", { anchor: "extensions" });
    expect(result.action).toBe("refused");
    expect(result.reason).toContain("锚点");
    expect(result.text).toBe("a: 1\n");
  });

  it("文件里已有同名键 → 拒绝写入（避免重复键）", () => {
    const result = upsertBlock("openai-api-base: http://x\n", "openai-api-base: http://y\n", {
      conflictKey: "openai-api-base",
      appendIfMissing: true,
    });
    expect(result.action).toBe("refused");
    expect(result.reason).toContain("openai-api-base");
  });

  it("只有 begin 没有 end 的脏文件 → 拒绝写入", () => {
    const dirty = "# >>> dobocache managed block begin\nfoo: 1\n";
    const result = upsertBlock(dirty, "bar: 2", { appendIfMissing: true });
    expect(result.action).toBe("refused");
    expect(result.text).toBe(dirty);
  });

  it("保留 CRLF 文件原有换行风格", () => {
    const original = "a: 1\r\nb: 2\r\n";
    const result = upsertBlock(original, "dobocache:\n  x: 1", { appendIfMissing: true });
    expect(result.text).toContain("\r\n");
    expect(result.text.includes("\n\n")).toBe(false);
  });
});

describe("JSON 写入引擎", () => {
  const fake: HostDescriptor = {
    id: "fake-json",
    label: "Fake JSON 底座",
    plan: "P0",
    since: "test",
    platforms: ["win32", "darwin", "linux"],
    confidence: "unverified",
    source: "test",
    locations: [{ pattern: "unused", role: "both" }],
    write: {
      kind: "json",
      mcpKeyPath: ["mcp"],
      entryShape: "opencode-local",
      baseURLPath: ["provider", "imodel", "options", "baseURL"],
      baseURLSuffix: "/api/v1",
    },
  };

  it("写入 → 幂等 → 回滚还原（含 baseURL 原值）", () => {
    const dir = scratch();
    const file = path.join(dir, "opencode.json");
    const original = `${JSON.stringify({ provider: { imodel: { options: { baseURL: "https://upstream.example/api/v1" } } }, mcp: { other: { command: "x" } }, keep: 1 }, null, 2)}\n`;
    fs.writeFileSync(file, original, "utf-8");

    const applied = applyHostFile(fake, file, CTX);
    expect(applied.status).toBe("applied");
    const afterApply = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    expect(afterApply.mcp.dobocache).toEqual(buildMcpEntry("opencode-local", CTX));
    expect(afterApply.mcp.other).toEqual({ command: "x" });
    expect(afterApply.keep).toBe(1);
    expect(afterApply.provider.imodel.options.baseURL).toBe("http://127.0.0.1:27880/api/v1");
    expect(fs.existsSync(`${file}.dobocache-attach.json`)).toBe(true);

    const second = applyHostFile(fake, file, CTX);
    expect(second.status).toBe("skipped");
    expect(second.detail).toContain("已是接入状态");

    const reverted = revertHostFile(fake, file, CTX);
    expect(reverted.status).toBe("applied");
    const afterRevert = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, any>;
    expect(afterRevert.mcp.dobocache).toBeUndefined();
    expect(afterRevert.provider.imodel.options.baseURL).toBe("https://upstream.example/api/v1");
    expect(afterRevert.keep).toBe(1);
    expect(fs.existsSync(`${file}.dobocache-attach.json`)).toBe(false);
    expect(fs.readdirSync(dir).some((name) => name.includes("before-dobocache"))).toBe(true);
  });

  it("dry-run 只报变更、不动文件", () => {
    const dir = scratch();
    const file = path.join(dir, "c.json");
    const original = `${JSON.stringify({ mcp: {} }, null, 2)}\n`;
    fs.writeFileSync(file, original, "utf-8");
    const result = applyHostFile(fake, file, { ...CTX, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    expect(fs.existsSync(`${file}.dobocache-attach.json`)).toBe(false);
  });

  it("含注释的 JSONC → 拒绝写入并说明原因", () => {
    const dir = scratch();
    const file = path.join(dir, "settings.json");
    const original = '{\n  // 用户注释\n  "mcp": {}\n}\n';
    fs.writeFileSync(file, original, "utf-8");
    const result = applyHostFile(fake, file, CTX);
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("注释");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
    expect(readJsonStrict(file).ok).toBe(false);
  });
});

describe("受管块引擎（TOML / YAML 底座）", () => {
  it("Codex CLI 描述符：写 TOML 块 → 幂等 → 回滚", () => {
    const host = getHost("codex-cli");
    expect(host).toBeTruthy();
    const dir = scratch();
    const file = path.join(dir, "config.toml");
    const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(file, original, "utf-8");

    const applied = applyHostFile(host as HostDescriptor, file, CTX);
    expect(applied.status).toBe("applied");
    const text = fs.readFileSync(file, "utf-8");
    expect(text).toContain("[mcp_servers.dobocache]");
    expect(text).toContain(CTX.bundlePath.replace(/\\/g, "\\\\"));

    expect(applyHostFile(host as HostDescriptor, file, CTX).status).toBe("skipped");

    const reverted = revertHostFile(host as HostDescriptor, file, CTX);
    expect(reverted.status).toBe("applied");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });
});

// ---------------------------------------------------------------- v0.7.1

describe("v0.7.1 新底座", () => {
  it("Goose：写 extensions 下的 YAML 块 → 幂等 → 回滚", () => {
    const host = getHost("goose");
    expect(host).toBeTruthy();
    const dir = scratch();
    const file = path.join(dir, "config.yaml");
    const original = ["GOOSE_PROVIDER: openai", "extensions:", "  developer:", "    enabled: true", ""].join("\n");
    fs.writeFileSync(file, original, "utf-8");

    const applied = applyHostFile(host as HostDescriptor, file, CTX);
    expect(applied.status).toBe("applied");
    const text = fs.readFileSync(file, "utf-8");
    expect(text).toContain("  dobocache:");
    expect(text).toContain("  type: stdio");
    expect(text).toContain("    - " + CTX.bundlePath);
    // 原有扩展不许被动
    expect(text).toContain("  developer:");
    expect(text).toContain("    enabled: true");

    expect(applyHostFile(host as HostDescriptor, file, CTX).status).toBe("skipped");
    expect(revertHostFile(host as HostDescriptor, file, CTX).status).toBe("applied");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("Goose：没有 extensions 锚点时宁可不写", () => {
    const host = getHost("goose") as HostDescriptor;
    const dir = scratch();
    const file = path.join(dir, "config.yaml");
    const original = "GOOSE_PROVIDER: openai\n";
    fs.writeFileSync(file, original, "utf-8");
    const applied = applyHostFile(host, file, CTX);
    expect(applied.status).toBe("skipped");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("Kimi CLI / Gemini CLI：写 JSON 的 mcpServers → 幂等 → 回滚", () => {
    for (const id of ["kimi-cli", "gemini-cli"]) {
      const host = getHost(id) as HostDescriptor;
      expect(host, id).toBeTruthy();
      const dir = scratch();
      const file = path.join(dir, "settings.json");
      const original = '{\n  "theme": "dark"\n}\n';
      fs.writeFileSync(file, original, "utf-8");

      expect(applyHostFile(host, file, CTX).status, id).toBe("applied");
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      expect(Object.keys(parsed)).toContain("mcpServers");
      expect(JSON.stringify(parsed)).toContain(CTX.bundlePath.replace(/\\/g, "\\\\"));
      expect((parsed as { theme?: string }).theme).toBe("dark");

      expect(applyHostFile(host, file, CTX).status, id).toBe("skipped");
      expect(revertHostFile(host, file, CTX).status, id).toBe("applied");
      expect(fs.readFileSync(file, "utf-8"), id).toBe(original);
    }
  });

  it("Crush：只指路不写盘，且指路文案带可复制的 mcp add 命令", () => {
    const host = getHost("crush") as HostDescriptor;
    expect(host.write).toBeNull();
    expect((host.guide ?? []).join("\n")).toContain("mcp add dobocache");
  });

  it("Continue：mcpServers 是列表形态，写入为列表项、幂等、可回滚", () => {
    const host = getHost("continue") as HostDescriptor;
    const dir = scratch();
    const file = path.join(dir, "config.yaml");
    const original = "name: my-config\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: existing\n    command: npx\n";
    fs.writeFileSync(file, original, "utf-8");

    const first = applyHostFile(host, file, CTX);
    expect(first.status).toBe("applied");
    const after = fs.readFileSync(file, "utf-8");
    expect(after).toContain("  - name: dobocache");
    expect(after).toContain("mcpServers:");
    expect(after.indexOf("- name: dobocache")).toBeGreaterThan(after.indexOf("mcpServers:"));
    expect(after).toContain("- name: existing");

    // 第二次写入必须幂等：YAML 是缩进敏感格式，掉缩进会把列表项提到顶层
    expect(applyHostFile(host, file, CTX).status).toBe("skipped");
    expect(fs.readFileSync(file, "utf-8")).toBe(after);

    expect(revertHostFile(host, file, CTX).status).toBe("applied");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("Continue：用户自己已配了同名 dobocache 列表项时拒绝写入", () => {
    const host = getHost("continue") as HostDescriptor;
    const dir = scratch();
    const file = path.join(dir, "config.yaml");
    const original = "mcpServers:\n  - name: dobocache\n    command: /my/own/node\n";
    fs.writeFileSync(file, original, "utf-8");
    const result = applyHostFile(host, file, CTX);
    expect(result.status).toBe("skipped");
    expect(result.detail ?? "").toContain("已停止写入");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("编辑器档 JSON 底座（cline / cursor / windsurf）：写入-幂等-回滚逐字节一致", () => {
    for (const id of ["cline", "cursor", "windsurf"]) {
      const host = getHost(id) as HostDescriptor;
      const dir = scratch();
      const file = path.join(dir, "mcp.json");
      const original = '{\n  "mcpServers": {\n    "mine": { "command": "node" }\n  }\n}\n';
      fs.writeFileSync(file, original, "utf-8");

      expect(applyHostFile(host, file, CTX).status, id).toBe("applied");
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        mcpServers: Record<string, { command?: string; args?: string[] }>;
      };
      expect(parsed.mcpServers.dobocache?.command, id).toBe(CTX.nodeExe);
      expect(parsed.mcpServers.mine?.command, id).toBe("node");

      expect(applyHostFile(host, file, CTX).status, id).toBe("skipped");
      expect(revertHostFile(host, file, CTX).status, id).toBe("applied");
      expect(fs.readFileSync(file, "utf-8"), id).toBe(original);
    }
  });
});

describe("注册表 registry", () => {
  it("内置描述符含 v0.7.0 新增底座，且都带来源说明", () => {
    const ids = listHosts().map((host) => host.id);
    expect(ids).toContain("codex-cli");
    expect(ids).toContain("aider");
    for (const host of listHosts()) {
      expect(host.source.length).toBeGreaterThan(0);
      expect(["verified", "unverified"]).toContain(host.confidence);
    }
  });

  it("外部描述符目录：合法文件并入清单，非法文件只出警告且不覆盖内置", () => {
    const dir = scratch();
    fs.writeFileSync(
      path.join(dir, "custom.json"),
      JSON.stringify({ id: "my-host", label: "自研底座", locations: [{ pattern: "~/.myhost/config.json", role: "mcp" }] }),
      "utf-8",
    );
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json", "utf-8");
    fs.writeFileSync(path.join(dir, "dup.json"), JSON.stringify({ id: "codex-cli", label: "冒名", locations: [{ pattern: "~/x" }] }), "utf-8");

    const previous = process.env.DOBOCACHE_ADAPTERS_DIR;
    process.env.DOBOCACHE_ADAPTERS_DIR = dir;
    try {
      const loaded = loadExternalHosts();
      expect(loaded.hosts.map((host) => host.id)).toEqual(["my-host"]);
      expect(loaded.warnings.length).toBe(2);
      const hosts = listHosts();
      expect(hosts.filter((host) => host.id === "codex-cli").length).toBe(1);
      const mine = hosts.find((host) => host.id === "my-host");
      expect(mine?.write).toBeNull();
      expect(mine?.plan).toBe("P2");
    } finally {
      if (previous === undefined) delete process.env.DOBOCACHE_ADAPTERS_DIR;
      else process.env.DOBOCACHE_ADAPTERS_DIR = previous;
    }
  });
});

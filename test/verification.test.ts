/**
 * verification.test.ts —— v0.9.1「内置 13 项适配收尾」的回归测试
 *
 * 守的四条：
 *   1) 13 项每一项都有验证记录，且等级/日期/证据齐全（不允许再出现"整体一句没验证"）
 *   2) 描述符上的 verification 与台账一致（台账是唯一口径）
 *   3) 只指路（docs-only）的底座永远不参与自动接入，也不参与默认精确匹配
 *   4) 老三家回滚必须把 baseURL 退回接入前的原值（v0.9.1 修的真实缺陷：sidecar 记录时机写反）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TARGETS, findTargets } from "../src/attach.js";
import { BUILTIN_HOSTS } from "../src/hosts/builtin.js";
import { HOST_VERIFICATION, isAutoAttachEligible, levelRank, verificationOf } from "../src/hosts/verification.js";
import type { AttachContext } from "../src/attach.js";

const LEGACY_IDS = ["loomy", "opencode", "claude-code"];
const BUILTIN_IDS = BUILTIN_HOSTS.map((host) => host.id);

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dobocache-verify-"));
}

const CTX: AttachContext = {
  port: 27880,
  nodeExe: path.join("C:", "Program Files", "nodejs", "node.exe"),
  bundlePath: path.join("C:", "dobo", "dist", "bundle.js"),
  proxyBase: "http://127.0.0.1:27880",
  dryRun: false,
};

describe("验证台账：13 项逐条交代", () => {
  it("内置 10 项 + 老三家 3 项，一共 13 项，一项不少也没多", () => {
    const all = [...BUILTIN_IDS, ...LEGACY_IDS];
    expect(all).toHaveLength(13);
    expect(new Set(all).size).toBe(13);
    for (const id of all) {
      expect(HOST_VERIFICATION[id], `台账缺少 ${id}`).toBeTruthy();
    }
    expect(Object.keys(HOST_VERIFICATION).sort()).toEqual([...all].sort());
  });

  it("每一项都有合法等级、复核日期与可复算证据", () => {
    const levels = ["client-confirmed", "write-rollback", "docs-only"];
    for (const [id, record] of Object.entries(HOST_VERIFICATION)) {
      expect(levels, `${id} 等级非法`).toContain(record.level);
      expect(record.at, `${id} 日期格式`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(record.basis.length, `${id} 证据太短`).toBeGreaterThan(12);
    }
  });

  it("描述符上的 verification 与台账完全一致", () => {
    for (const host of BUILTIN_HOSTS) {
      expect(host.verification, `${host.id} 描述符没带 verification`).toEqual(HOST_VERIFICATION[host.id]);
    }
    for (const id of LEGACY_IDS) {
      const target = TARGETS.find((item) => item.id === id);
      expect(target?.verification, `${id} 目标没带 verification`).toEqual(HOST_VERIFICATION[id]);
    }
  });

  it("client-confirmed 的项都是 verified，docs-only 的项不参与自动接入", () => {
    for (const host of BUILTIN_HOSTS) {
      const record = verificationOf(host.id)!;
      if (record.level === "client-confirmed") expect(host.confidence).toBe("verified");
      if (record.level === "docs-only") {
        expect(isAutoAttachEligible(host.confidence, record)).toBe(false);
      }
    }
  });

  it("isAutoAttachEligible 三档判定", () => {
    expect(isAutoAttachEligible("verified", { level: "client-confirmed", at: "2026-11-16", basis: "x" })).toBe(true);
    expect(isAutoAttachEligible("verified", { level: "write-rollback", at: "2026-11-16", basis: "x" })).toBe(true);
    expect(isAutoAttachEligible("verified", { level: "docs-only", at: "2026-11-16", basis: "x" })).toBe(false);
    expect(isAutoAttachEligible("unverified", { level: "client-confirmed", at: "2026-11-16", basis: "x" })).toBe(false);
    expect(isAutoAttachEligible("verified", undefined)).toBe(true);
  });

  it("等级权重排序：客户端确认 > 写入回滚 > 仅指路", () => {
    expect(levelRank("client-confirmed")).toBeGreaterThan(levelRank("write-rollback"));
    expect(levelRank("write-rollback")).toBeGreaterThan(levelRank("docs-only"));
  });
});

describe("自动接入范围：只指路的一律不写", () => {
  it("auto 不含任何 docs-only 底座（Crush）", () => {
    const ids = findTargets("auto").map((target) => target.id);
    expect(ids).not.toContain("crush");
    for (const id of ids) {
      expect(verificationOf(id)?.level).not.toBe("docs-only");
    }
  });

  it("写盘验证过的 9 家都在自动接入范围里，老三家也还在", () => {
    const ids = findTargets("auto").map((target) => target.id);
    for (const id of ["codex-cli", "aider", "goose", "kimi-cli", "gemini-cli", "cline", "continue", "cursor", "windsurf"]) {
      expect(ids, `${id} 应该可自动接入`).toContain(id);
    }
    for (const id of LEGACY_IDS) expect(ids).toContain(id);
  });

  it("精确指定 docs-only 底座时默认不返回，显式 allowUnverified 才放行", () => {
    expect(findTargets("crush")).toHaveLength(0);
    expect(findTargets("crush", { allowUnverified: true })).toHaveLength(1);
  });
});

describe("老三家回滚：baseURL 必须退回接入前的原值", () => {
  it("Loomy：上游 baseURL 被改写后，--revert 能原样退回（v0.9.1 修的缺陷）", () => {
    const target = TARGETS.find((item) => item.id === "loomy")!;
    const dir = scratch();
    const file = path.join(dir, "opencode.json");
    const before = '{\n  "provider": {\n    "imodel": {\n      "options": {\n        "baseURL": "https://upstream.example.invalid/v1"\n      }\n    }\n  },\n  "mcp": {}\n}\n';
    fs.writeFileSync(file, before, "utf-8");

    const applied = target.sync(file, CTX);
    expect(applied.status).toBe("applied");
    const afterSync = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(afterSync.provider.imodel.options.baseURL).toBe("http://127.0.0.1:27880/api/v1");
    expect(afterSync.mcp.dobocache).toBeTruthy();

    const reverted = target.revert(file, CTX);
    expect(reverted.status).toBe("applied");
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  it("Loomy：接入前没有 baseURL 键时，回滚要把我们加的键删掉而不是留成空值", () => {
    const target = TARGETS.find((item) => item.id === "loomy")!;
    const dir = scratch();
    const file = path.join(dir, "opencode.json");
    const before = '{\n  "provider": {\n    "imodel": {\n      "options": {}\n    }\n  },\n  "mcp": {}\n}\n';
    fs.writeFileSync(file, before, "utf-8");

    expect(target.sync(file, CTX).status).toBe("applied");
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).provider.imodel.options.baseURL).toBe("http://127.0.0.1:27880/api/v1");
    expect(target.revert(file, CTX).status).toBe("applied");

    const after = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(Object.prototype.hasOwnProperty.call(after.provider.imodel.options, "baseURL")).toBe(false);
  });
});

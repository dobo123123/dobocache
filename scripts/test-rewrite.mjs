#!/usr/bin/env node
/**
 * test-rewrite.mjs —— 改写引擎自测（零依赖，直接跑编译产物）
 *
 * 前置：先 npm run build（本脚本 import 的是 dist/proxy/rewrite.js）
 * 运行：npm run test:rewrite
 *
 * 覆盖 6 个用例：首轮基线 / 健康追加 / 前缀被改 / 被裁剪 / observe 不改写 / anchor 锚定。
 *
 * 关于"被改"的一个硬约束（务必知晓）：
 *   会话 key = 上游 host + 首条 user 消息内容的 sha1 前 8 位。
 *   因此"改掉首条 user 消息"在语义上就是新会话（会报 first，不是 modified），
 *   用例 3 改为改"历史里的第 2 条消息"，用例 3b 单独验证"改首条 user = 新会话"。
 */

import { RewriteState, rewriteRequestBody, segmentPrefix, sessionKeyFor } from "../dist/proxy/rewrite.js";

const HOST = "api.deepseek.com";
const MODE = "stabilize";

let failures = 0;

/** 断言：一条用例一个 check，失败只记失败不中断（便于一次看全） */
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? `（${detail}）` : ""}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `（${detail}）` : ""}`);
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf-8");
}

/** 走一遍改写引擎（body 由 parsed 现场序列化，保证两者一致） */
function run(state, parsed, mode = MODE) {
  return rewriteRequestBody({ host: HOST, body: encode(parsed), parsed, mode, state });
}

function bodyOf(result) {
  return JSON.parse(result.body.toString("utf-8"));
}

// ---------------------------------------------------------------------------
console.log("[用例 1] 首轮基线：tools 乱序 + system 带时间");
const state = new RewriteState();

const M0 = { role: "user", content: "帮我看看缓存命中率为什么一直很低" };
const M1 = { role: "assistant", content: "先确认前缀是否稳定，再看是否被压缩过。" };
const M2 = { role: "assistant", content: "我复算了一轮：第 3 段开始变了。" };
const M3 = { role: "user", content: "那要怎么修？" };

const round1 = {
  model: "deepseek-chat",
  system: "你是缓存优化助手。当前时间 2026-11-12 14:23:07",
  tools: [
    { name: "b", description: "第二个工具" },
    { name: "a", description: "第一个工具" },
  ],
  messages: [M0, M1],
};

const r1 = run(state, round1);
check("divergenceKind === first", r1.report.divergenceKind === "first", `实际 ${r1.report.divergenceKind}`);
check("firstDivergenceIndex === null", r1.report.firstDivergenceIndex === null);
check("stabilizedTools === true", r1.report.stabilizedTools === true);
check("stabilizedKeys === true", r1.report.stabilizedKeys === true);
check("changed === true（真的改写了 body）", r1.report.changed === true);

const out1 = bodyOf(r1);
const toolOrder = out1.tools.map((tool) => tool.name).join(",");
check("输出 body 中 tools 顺序为 a,b", toolOrder === "a,b", `实际 ${toolOrder}`);
check("段数 = system + tools + 2 条消息 = 4", r1.report.segmentCount === 4, `实际 ${r1.report.segmentCount}`);
const key1 = sessionKeyFor(HOST, round1);
check("会话 key = host + 首条 user 哈希前 8 位", /^api\.deepseek\.com\|[0-9a-f]{8}$/.test(key1), key1);

// ---------------------------------------------------------------------------
console.log("[用例 2] 第二轮健康追加：尾部 append，前缀应当完好");
const round2 = {
  ...round1,
  // tools 顺序抖一次（真实客户端确实会抖），stabilize 应把它压回同一串字节
  tools: [
    { name: "a", description: "第一个工具" },
    { name: "b", description: "第二个工具" },
  ],
  messages: [M0, M1, M2, M3],
};
const r2 = run(state, round2);
check("divergenceKind === appended", r2.report.divergenceKind === "appended", `实际 ${r2.report.divergenceKind}`);
check("firstDivergenceIndex === null", r2.report.firstDivergenceIndex === null);
check("段数 = 6", r2.report.segmentCount === 6, `实际 ${r2.report.segmentCount}`);
check("本轮 tools 顺序已正确（stabilizedTools=false）", r2.report.stabilizedTools === false);
check("tools 抖动未造成分歧（appended 已证明 tools 段 hash 一致）", r2.report.divergenceKind === "appended");

// ---------------------------------------------------------------------------
console.log("[用例 3] 前缀被改：历史消息内容被改写（旧内容动了 → 命中率杀手）");
const round3 = {
  ...round1,
  messages: [M0, { role: "assistant", content: "（被重写）先确认前缀是否稳定，再看是否被压缩过。" }, M2, M3],
};
const r3 = run(state, round3);
check("divergenceKind === modified", r3.report.divergenceKind === "modified", `实际 ${r3.report.divergenceKind}`);
check("firstDivergenceIndex 指向被改那条（下标 3）", r3.report.firstDivergenceIndex === 3, `实际 ${r3.report.firstDivergenceIndex}`);

// ---------------------------------------------------------------------------
console.log("[用例 3b] 改首条 user = 新会话（会话 key 由首条 user 内容决定）");
const round3b = {
  ...round1,
  messages: [{ role: "user", content: "帮我看看缓存命中率为什么一直很低（改写版）" }, M1, M2, M3],
};
const r3b = run(state, round3b);
check("divergenceKind === first（新会话，不是 modified）", r3b.report.divergenceKind === "first", `实际 ${r3b.report.divergenceKind}`);

// ---------------------------------------------------------------------------
console.log("[用例 4] 被裁剪：尾部旧内容被裁掉 → 命中率必掉");
const round4 = {
  ...round1,
  messages: [M0, { role: "assistant", content: "（被重写）先确认前缀是否稳定，再看是否被压缩过。" }, M2],
};
const r4 = run(state, round4);
check("divergenceKind === shrunk", r4.report.divergenceKind === "shrunk", `实际 ${r4.report.divergenceKind}`);
check("shrunkBy === 1", r4.report.shrunkBy === 1, `实际 ${r4.report.shrunkBy}`);

// ---------------------------------------------------------------------------
console.log("[用例 5] observe 模式：只看不改，body 必须同一个引用");
const observeBody = encode(round1);
const r5 = rewriteRequestBody({ host: HOST, body: observeBody, parsed: round1, mode: "observe", state: new RewriteState() });
check("body 与入参是同一个 Buffer（Object.is）", Object.is(r5.body, observeBody));
check("changed === false", r5.report.changed === false);
check("observe 仍产出诊断（首轮 first）", r5.report.divergenceKind === "first", `实际 ${r5.report.divergenceKind}`);
check("observe 不做 key 规范化（stabilizedKeys FALSE）", r5.report.stabilizedKeys === false);

// ---------------------------------------------------------------------------
console.log("[用例 6] anchor 模式：两轮时间串不同，system 段 hash 必须相同");
const anchorState = new RewriteState();
const anchorRequest = (time) => ({
  model: "deepseek-chat",
  system: `你是缓存优化助手。当前时间 ${time}`,
  tools: [{ name: "a", description: "第一个工具" }],
  messages: [{ role: "user", content: "锚点测试：这条内容两轮完全一样" }],
});

const a1 = run(anchorState, anchorRequest("2026-11-12T14:23:07+09:00"), "anchor");
const a2 = run(anchorState, anchorRequest("2026-11-12T15:40:59+09:00"), "anchor");
check("第二轮 anchoredTimes > 0", a2.report.anchoredTimes > 0, `实际 ${a2.report.anchoredTimes}`);

const segA1 = segmentPrefix(bodyOf(a1), "openai");
const segA2 = segmentPrefix(bodyOf(a2), "openai");
check("两轮 system 段 kind 均为 system", segA1[0]?.kind === "system" && segA2[0]?.kind === "system");
check("两轮 system 段 hash 相同", segA1[0]?.hash === segA2[0]?.hash, `${segA1[0]?.hash} vs ${segA2[0]?.hash}`);
check("两轮 system 段 mismatched 时间已被抹平", !bodyOf(a2).system.includes("15:40:59"), bodyOf(a2).system);

// 附：非 JSON 请求体不该被碰
const rawBody = Buffer.from("not-a-json-body", "utf-8");
const rRaw = rewriteRequestBody({ host: HOST, body: rawBody, parsed: undefined, mode: "stabilize", state: new RewriteState() });
check("非 JSON 请求体：origin body 引用不变", Object.is(rRaw.body, rawBody));
check("非 JSON 请求体：reason 明确", rRaw.report.reason === "非 JSON 请求体", String(rRaw.report.reason));

// ---------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log("[test:rewrite] 全部通过。");
} else {
  console.log(`[test:rewrite] 失败 ${failures} 项。`);
  process.exit(1);
}

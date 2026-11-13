#!/usr/bin/env node
/**
 * test-inject-usage.mjs —— 流式 usage 注入自测（零依赖，跑 dist 产物）
 *
 * 覆盖两层：
 *   A. 纯函数层（inject.js）：注入/已设置/关闭/非流式/非 openai/形态不认识/回退快照/错误识别
 *   B. 端到端层（server.js + 假上游）：
 *      B1 注入真的发到了上游，且卡片写明"已注入"；
 *      B2 上游 4xx 说"不认识 stream_options"→ 去掉字段重试一次，客户端拿到 200；
 *      B3 --inject-usage off 时上游收不到该字段。
 *
 * 用法：node scripts/test-inject-usage.mjs
 */

import http from "node:http";
import { Buffer } from "node:buffer";

import {
  injectStreamUsage,
  isStreamRequest,
  isUnknownFieldError,
  shouldRetryWithoutInjection,
} from "../dist/proxy/inject.js";
import { startProxy } from "../dist/proxy/server.js";

let passed = 0;
let failed = 0;

function check(name, condition, extra = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ""}`);
  }
}

function makeBody(obj) {
  return Buffer.from(JSON.stringify(obj), "utf-8");
}

const OPENAI_STREAM = {
  model: "deepseek-chat",
  stream: true,
  messages: [{ role: "user", content: "你好" }],
};

console.log("[A] 纯函数层");

{
  const body = makeBody(OPENAI_STREAM);
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: true });
  const sent = JSON.parse(r.body.toString("utf-8"));
  check("A1 openai + stream=true 无 stream_options → 注入", r.status === "injected" && r.injected === true, r.status);
  check("A2 注入内容为 include_usage:true", sent.stream_options?.include_usage === true, JSON.stringify(sent.stream_options));
  check("A3 原有字段不被改动", sent.model === OPENAI_STREAM.model && sent.messages.length === 1 && sent.stream === true);
  check("A4 回退快照字节与注入前一致", r.previous?.body === body && r.previous?.parsed !== r.parsed);
}

{
  const body = makeBody({ ...OPENAI_STREAM, stream_options: { include_usage: false } });
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: true });
  check("A5 客户端显式 false → already-set 且不动", r.status === "already-set" && r.injected === false && r.body === body);
}

{
  const body = makeBody({ ...OPENAI_STREAM, stream_options: { include_usage: true } });
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: true });
  check("A6 客户端显式 true → already-set", r.status === "already-set" && r.body === body);
}

{
  const body = makeBody({ ...OPENAI_STREAM, stream_options: { chunk_size: 7 } });
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: true });
  const sent = JSON.parse(r.body.toString("utf-8"));
  check(
    "A7 已有其他 stream_options 子字段 → 合并保留",
    r.status === "injected" && sent.stream_options?.chunk_size === 7 && sent.stream_options?.include_usage === true,
    JSON.stringify(sent.stream_options),
  );
}

{
  const body = makeBody({ model: "x", stream: false, messages: [] });
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: true });
  check("A8 stream=false → not-applicable", r.status === "not-applicable" && r.body === body);
  check("A9 isStreamRequest 只认严格 true", isStreamRequest({ stream: "true" }) === false && isStreamRequest({ stream: true }) === true);
}

{
  const body = makeBody({ model: "claude", stream: true, system: "s", messages: [{ role: "user", content: "hi" }] });
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "anthropic", enabled: true });
  check("A10 anthropic 方言 → not-applicable", r.status === "not-applicable" && r.body === body);
}

{
  const body = makeBody(OPENAI_STREAM);
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: false });
  check("A11 开关 off → disabled 且不动", r.status === "disabled" && r.body === body);
}

{
  const body = makeBody(OPENAI_STREAM);
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "unknown", enabled: true });
  check("A12 路由未声明方言但体像 openai → 仍注入", r.status === "injected" && r.injected === true, r.status);
}

{
  const body = makeBody(OPENAI_STREAM);
  const r = injectStreamUsage({ body, parsed: undefined, vendor: "openai", enabled: true });
  check("A13 非 JSON 请求体 → not-applicable", r.status === "not-applicable" && r.body === body);
}

{
  const body = makeBody({ ...OPENAI_STREAM, stream_options: "yes" });
  const r = injectStreamUsage({ body, parsed: JSON.parse(body.toString()), vendor: "openai", enabled: true });
  check("A14 stream_options 形态不认识 → 不覆盖", r.status === "not-applicable" && r.body === body);
}

{
  const again = injectStreamUsage({
    body: makeBody(OPENAI_STREAM),
    parsed: OPENAI_STREAM,
    vendor: "openai",
    enabled: true,
  });
  const twice = injectStreamUsage({ body: again.body, parsed: again.parsed, vendor: "openai", enabled: true });
  check("A15 幂等：对注入结果再跑一次变成 already-set", twice.status === "already-set");
}

console.log("[A'] 4xx 未知字段识别");
{
  const hit = [
    '{"error":{"message":"Unrecognized request argument supplied: stream_options","type":"invalid_request_error"}}',
    '{"error":{"message":"unknown parameter: stream_options","type":"invalid_request_error"}}',
    '{"error":{"message":"不支持字段 stream_options"}}',
    '{"error":{"message":"Extra field `stream_options` is not allowed"}}',
  ];
  const miss = [
    '{"error":{"message":"Rate limit reached for requests","type":"requests"}}',
    '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}',
    '{"error":{"message":"Model Not Exist","code":"ModelNotFound"}}',
    "",
  ];
  check("A16 四类未知字段措辞均命中", hit.every((text) => isUnknownFieldError(text)));
  check("A17 限流/鉴权/模型不存在不误判", miss.every((text) => isUnknownFieldError(text) === false));
  check(
    "A18 只有 4xx + 注入过 + 明确未知字段才重试",
    shouldRetryWithoutInjection({ statusCode: 400, responseText: hit[0], injected: true }) === true &&
      shouldRetryWithoutInjection({ statusCode: 500, responseText: hit[0], injected: true }) === false &&
      shouldRetryWithoutInjection({ statusCode: 400, responseText: hit[0], injected: false }) === false &&
      shouldRetryWithoutInjection({ statusCode: 429, responseText: miss[0], injected: true }) === false,
  );
}

// ---------- B. 端到端：假上游 + 真代理 ----------

/** 起一个假上游：记录每次请求体；strict=true 时不认 stream_options 直接 400 */
function startFakeUpstream(options = {}) {
  const strict = options.strict === true;
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      received.push({ path: req.url, parsed, text });

      if (strict && parsed && parsed.stream_options !== undefined) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: { message: "Unrecognized request argument supplied: stream_options", type: "invalid_request_error" },
          }),
        );
        return;
      }

      // 正常流式回包：最后一帧带 usage
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":3200,"prompt_tokens_details":{"cached_tokens":2900},"completion_tokens":8}}\n\n',
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ port, received, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** 向代理发一次流式请求，返回 { text, headers } */
function callProxy(port, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/fake/v1/chat/completions",
        method: "POST",
        // 每个用例都换代理实例，强制短连接，避免复用上一个实例的 keep-alive 套接字
        agent: false,
        headers: { "content-type": "application/json", "content-length": payload.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function withProxy(upstreamPort, injectUsage, run, basePort = 27980) {
  const cards = [];
  const proxy = await startProxy({
    port: basePort,
    routes: [{ prefix: "/fake", baseUrl: `http://127.0.0.1:${upstreamPort}`, vendor: "openai", label: "Fake" }],
    injectUsage,
    rewriteMode: "off",
    handoffDir: `${process.env.TEMP ?? "."}\\dobostitch-test-handoff`,
    onCard: (card) => cards.push(card),
  });
  try {
    return await run({ port: proxy.port, cards });
  } finally {
    await proxy.close();
  }
}

console.log("[B] 端到端（真代理 + 假上游）");

// B1/B2：严格上游，第一次拒绝 stream_options，代理去掉字段重试
{
  const upstream = await startFakeUpstream({ strict: true });
  try {
    const result = await withProxy(upstream.port, true, async ({ port, cards }) => {
      const response = await callProxy(port, OPENAI_STREAM);
      return { response, cards };
    });
    const [first, second] = upstream.received;
    check("B1 第一次请求确实带上了 stream_options", first?.parsed?.stream_options?.include_usage === true, first?.text);
    check("B2 上游拒后自动重试，且重试请求体已去掉该字段", upstream.received.length === 2 && second?.parsed?.stream_options === undefined);
    check("B3 客户端最终拿到 200 与正常流", result.response.status === 200 && result.response.text.includes("[DONE]"));
    check("B4 卡片写明已去掉该字段重试", result.cards.some((card) => card.includes("已去掉该字段重试一次")));
  } finally {
    await upstream.close();
  }
}

// B5：正常上游，只发一次、带 usage、卡片写明"已注入"
{
  const upstream = await startFakeUpstream();
  try {
    const result = await withProxy(upstream.port, true, async ({ port, cards }) => {
      const response = await callProxy(port, OPENAI_STREAM);
      return { response, cards };
    }, 27990);
    check("B5 上游收到注入字段且只被请求一次", upstream.received.length === 1 && upstream.received[0].parsed.stream_options?.include_usage === true);
    check("B6 流末 usage 被解析进卡片（命中率有值）", result.cards.some((card) => card.includes("命中率") && !card.includes("未判定")));
    check("B7 卡片写明流式 usage 已注入", result.cards.some((card) => card.includes("流式 usage 已注入")));
  } finally {
    await upstream.close();
  }
}

// B8：开关 off
{
  const upstream = await startFakeUpstream();
  try {
    await withProxy(upstream.port, false, async ({ port }) => {
      const response = await callProxy(port, OPENAI_STREAM);
      return { response };
    }, 28000);
    check(
      "B8 --inject-usage off 时上游收不到该字段",
      upstream.received.length === 1 && upstream.received[0].parsed.stream_options === undefined,
      upstream.received[0]?.text,
    );
  } finally {
    await upstream.close();
  }
}

// B9：客户端自带 include_usage 时一个字节都不改
{
  const upstream = await startFakeUpstream({ strict: true });
  try {
    const body = { ...OPENAI_STREAM, stream_options: { include_usage: true } };
    const result = await withProxy(upstream.port, true, async ({ port, cards }) => {
      const response = await callProxy(port, body);
      return { response, cards };
    }, 28010);
    // 严格上游连客户端自己写的 stream_options 也不认：此时代理必须原样透传错误、不替客户端删字段
    check(
      "B9 客户端自带 include_usage → 只发一次、不替它删字段、4xx 原样透传",
      upstream.received.length === 1 && result.response.status === 400 && upstream.received[0].parsed.stream_options?.include_usage === true,
      `count=${upstream.received.length} status=${result.response.status}`,
    );
    check("B10 卡片写明客户端已自带", result.cards.some((card) => card.includes("客户端已自带")));
  } finally {
    await upstream.close();
  }
}

console.log("");
console.log(`断言合计：通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;

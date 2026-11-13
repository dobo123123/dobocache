#!/usr/bin/env node
/**
 * test-content-encoding.mjs —— 压缩响应下的 usage 旁路解析自测（零依赖，跑 dist 产物）
 *
 * 背景：真实客户端（如 DSH）会发 Accept-Encoding: gzip, deflate, br，
 * 上游随即用 brotli 压缩 SSE；代理若不解压就直接当文本解析，usage 永远抠不出来，
 * 体检卡显示"未判定"、交接单 inputTokensAtCapture 恒为 0。
 *
 * 覆盖：
 *   C1 brotli 压缩的 SSE → 命中率有值、卡片不出现"未判定"
 *   C2 gzip 压缩的 SSE   → 同上
 *   C3 deflate 压缩的 SSE → 同上
 *   C4 无压缩（identity） → 行为不变，照样有值
 *   C5 非 SSE 的压缩 JSON → 也能解压后解析 usage
 *   C6 不认识的编码（zstd）→ 不崩、不误判（标"未判定"）
 *   C7 解压结果无损：客户端收到的字节与上游压缩字节完全一致（透传不被改写）
 *   C8 交接单落盘的 inputTokensAtCapture 不再为 0
 *
 * 用法：node scripts/test-content-encoding.mjs
 */

import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { URL } from "node:url";

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

const SSE_TEXT =
  'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3200,"prompt_tokens_details":{"cached_tokens":2900},"completion_tokens":8}}\n\n' +
  "data: [DONE]\n\n";

const JSON_TEXT = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "hi" } }],
  usage: { prompt_tokens: 4096, prompt_tokens_details: { cached_tokens: 3584 }, completion_tokens: 5 },
});

const REQ_BODY = { model: "fake-model", stream: true, messages: [{ role: "user", content: "你好" }] };

/** 按编码压缩（identity = 原样） */
function encode(text, encoding) {
  const raw = Buffer.from(text, "utf-8");
  if (encoding === "identity") return raw;
  if (encoding === "br") return zlib.brotliCompressSync(raw);
  if (encoding === "gzip") return zlib.gzipSync(raw);
  if (encoding === "deflate") return zlib.deflateSync(raw);
  // 故意返回一段代理不认识的编码内容（模拟 zstd 等）
  return raw;
}

/** 假上游：按指定编码回包；同时记录最后一次收到的请求头（供 zstd 协商剥离用例断言） */
function startUpstream({ encoding = "identity", sse = true, sseText = null } = {}) {
  const state = { lastHeaders: null };
  const server = http.createServer((req, res) => {
    state.lastHeaders = { ...req.headers };
    req.on("data", () => {});
    req.on("end", () => {
      const text = sseText ?? (sse ? SSE_TEXT : JSON_TEXT);
      const body = encode(text, encoding);
      const headers = {
        "content-type": sse ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
        "content-length": body.length,
      };
      if (encoding !== "identity") headers["content-encoding"] = encoding;
      res.writeHead(200, headers);
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((d) => server.close(d)),
      });
    });
  });
}

/** 发一次请求到代理，收集原始字节与卡片 */
function callProxy(port, { acceptEncoding, path: reqPath = "/fake/v1/chat/completions" } = {}) {
  const payload = Buffer.from(JSON.stringify(REQ_BODY), "utf-8");
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "content-length": payload.length };
    if (acceptEncoding) headers["accept-encoding"] = acceptEncoding;
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: "POST", agent: false, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            contentEncoding: res.headers["content-encoding"] ?? "",
            raw: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

let portSeq = 28100;
async function runCase(name, { encoding, sse = true, acceptEncoding, sseText = null, path: reqPath = "/fake/v1/chat/completions" }) {
  const upstream = await startUpstream({ encoding, sse, sseText });
  const handoffDir = path.join(process.env.TEMP ?? ".", `dobostitch-test-handoff-${portSeq}`);
  const cards = [];
  const proxy = await startProxy({
    port: portSeq,
    routes: [{ prefix: "/fake", baseUrl: `http://127.0.0.1:${upstream.port}`, vendor: "openai", label: "Fake" }],
    injectUsage: true,
    rewriteMode: "off",
    handoffDir,
    onCard: (card) => cards.push(card),
  });
  portSeq += 1;
  try {
    const response = await callProxy(proxy.port, { acceptEncoding, path: reqPath });

    // 卡片与交接单是在响应收尾后异步产出的，轮询等它们落地（最多 3s）
    let card = "";
    let record = null;
    for (let i = 0; i < 60; i += 1) {
      card = cards.join("\n");
      const files = fs.existsSync(handoffDir) ? fs.readdirSync(handoffDir).filter((f) => f.endsWith(".json")) : [];
      if (files.length > 0) {
        try {
          record = JSON.parse(fs.readFileSync(path.join(handoffDir, files[0]), "utf-8"));
        } catch {
          record = null;
        }
      }
      if (card !== "" && record !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return { response, card, record, upstreamText: sseText ?? (sse ? SSE_TEXT : JSON_TEXT), encoding, upstreamHeaders: upstream.state.lastHeaders };
  } finally {
    await proxy.close();
    await upstream.close();
  }
}

console.log("[C] 压缩响应下的 usage 旁路解析");

for (const [caseName, encoding, label] of [
  ["C1", "br", "brotli 压缩 SSE"],
  ["C2", "gzip", "gzip 压缩 SSE"],
  ["C3", "deflate", "deflate 压缩 SSE"],
  ["C4", "identity", "无压缩 SSE"],
]) {
  const r = await runCase(caseName, { encoding, acceptEncoding: "gzip, deflate, br" });
  const hitRateShown = /命中率/.test(r.card) && !r.card.includes("未判定");
  check(`${caseName} ${label} → 卡片有命中率、不出现"未判定"`, hitRateShown, r.card.split("\n").slice(0, 3).join(" | "));
  check(
    `${caseName} 交接单 inputTokensAtCapture = 3200`,
    r.record?.inputTokensAtCapture === 3200,
    String(r.record?.inputTokensAtCapture),
  );
}

// C5：非 SSE 的压缩 JSON
{
  const r = await runCase("C5", { encoding: "br", sse: false, acceptEncoding: "br" });
  check("C5 非 SSE 的 brotli JSON → 解压后解析出 usage", r.record?.inputTokensAtCapture === 4096, String(r.record?.inputTokensAtCapture));
  check("C5 卡片有命中率", /命中率/.test(r.card) && !r.card.includes("未判定"));
}

// C6：不认识的编码（标 zstd 但内容其实是明文）→ 必须优雅降级，不崩
{
  const r = await runCase("C6", { encoding: "zstd", acceptEncoding: "zstd" });
  check("C6 不认识的编码 → 代理仍正常回包 200", r.response.status === 200, String(r.response.status));
  check("C6 不认识的编码 → 不误判，标未判定", r.card.includes("未判定") || r.record?.inputTokensAtCapture === 0);
}

// C7/C8：透传无损 + 交接单不再为 0（用 brotli 再核一次字节）
{
  const r = await runCase("C7", { encoding: "br", acceptEncoding: "br" });
  const expected = encode(SSE_TEXT, "br");
  check("C7 客户端收到的压缩字节与上游完全一致（透传未被改写）", r.response.raw.equals(expected), `${r.response.raw.length} vs ${expected.length}`);
  check("C7 响应头 content-encoding 原样带给客户端", r.response.contentEncoding === "br", r.response.contentEncoding);
  check("C8 交接单 inputTokensAtCapture 不再为 0", (r.record?.inputTokensAtCapture ?? 0) > 0, String(r.record?.inputTokensAtCapture));
}

// C9：运行时不支持 zstd 时，必须把 Accept-Encoding 里的 zstd 剥掉再转发
// （否则上游回 zstd，旧 Node 解不开 → 旁路采样整段失效）
// 运行时支持 zstd（Node ≥ 22.15 / 23.8）：保留协商项，靠解码器解压——两种行为都算正确
const ZSTD_AVAILABLE = (() => {
  try {
    return typeof zlib.zstdDecompressSync === "function";
  } catch {
    return false;
  }
})();
{
  const r = await runCase("C9", { encoding: "br", acceptEncoding: "gzip, deflate, br, zstd" });
  const forwarded = String(r.upstreamHeaders?.["accept-encoding"] ?? "");
  if (ZSTD_AVAILABLE) {
    check("C9 运行时支持 zstd → 保留 zstd 协商项（靠解码器解压）", /zstd/i.test(forwarded), forwarded);
  } else {
    check("C9 运行时不支持 zstd → 转发给上游的 accept-encoding 不含 zstd", !/zstd/i.test(forwarded), forwarded);
  }
  check("C9 其余协商项保留（gzip/br 还在）", /br/i.test(forwarded) && /gzip/i.test(forwarded), forwarded);
  check("C9 剥离后旁路采样仍正常（卡片有命中率）", /命中率/.test(r.card) && !r.card.includes("未判定"), r.card.split("\n").slice(0, 3).join(" | "));
}

// C10：OpenAI Responses 方言 —— usage 藏在 response.completed 帧的 response.usage 里
// （Codex CLI 0.141.0 只走这条路径；此前只认顶层 frame.usage，导致恒未判定）
{
  const responsesSse =
    'data: {"type":"response.output_text.delta","delta":"你好"}\n\n' +
    'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1208,"input_tokens_details":{"cached_tokens":1024},"output_tokens":9,"total_tokens":1217}}}\n\n';
  const r = await runCase("C10", { encoding: "identity", sseText: responsesSse, path: "/fake/v1/responses" });
  check("C10 Responses 嵌套 usage → 卡片有命中率、不出现未判定", /命中率/.test(r.card) && !r.card.includes("未判定"), r.card.split("\n").slice(0, 3).join(" | "));
  check("C10 Responses 交接单 inputTokensAtCapture = 1208", r.record?.inputTokensAtCapture === 1208, String(r.record?.inputTokensAtCapture));
  check("C10 Responses 命中率约 84.77%（1024/1208）", /84\.7|84\.8/.test(r.card), r.card.split("\n").slice(0, 3).join(" | "));
}

// C11：Anthropic 方言 —— usage 在 message_start 帧的 message.usage / message_delta 帧顶层
{
  const anthropicSse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":164,"cache_read_input_tokens":2048,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n';
  const r = await runCase("C11", { encoding: "identity", sseText: anthropicSse, path: "/fake/v1/messages" });
  check("C11 Anthropic 嵌套 usage → 卡片有命中率、不出现未判定", /命中率/.test(r.card) && !r.card.includes("未判定"), r.card.split("\n").slice(0, 3).join(" | "));
  check("C11 Anthropic 交接单 inputTokensAtCapture = 2212（input+cache_read）", r.record?.inputTokensAtCapture === 2212, String(r.record?.inputTokensAtCapture));
  check("C11 Anthropic 命中率约 92.58%", /92\.5|92\.6/.test(r.card), r.card.split("\n").slice(0, 3).join(" | "));
}

console.log("");
console.log(`断言合计：通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;

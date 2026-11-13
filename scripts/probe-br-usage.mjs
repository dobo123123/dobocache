#!/usr/bin/env node
/**
 * probe-br-usage.mjs —— 最小探针：向指定 dobostitch 端口发一次带 Accept-Encoding: br 的流式请求，
 * 用来验证"上游 br 压缩时代理侧能否解压并采到 inputTokens"。
 * 用法：node scripts/probe-br-usage.mjs <port> <handoffDir>
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const port = Number(process.argv[2] ?? "27880");
const handoffDir = process.argv[3] ?? "";
const key = process.env.DEEPSEEK_API_KEY ?? "";
if (!key) {
  console.error("缺少 DEEPSEEK_API_KEY");
  process.exit(1);
}

const body = JSON.stringify({
  model: "deepseek-chat",
  stream: true,
  max_tokens: 8,
  messages: [
    { role: "system", content: "你是探针，只回一个字。" },
    { role: "user", content: `探针请求，时间戳 ${Date.now()}，请只回复"好"。` },
  ],
});

const payload = Buffer.from(body, "utf-8");
const req = http.request(
  {
    host: "127.0.0.1",
    port,
    path: "/deepseek/v1/chat/completions",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": payload.length,
      authorization: `Bearer ${key}`,
      "accept-encoding": "gzip, deflate, br",
      accept: "text/event-stream",
    },
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const raw = Buffer.concat(chunks);
      console.log(`status=${res.statusCode} content-encoding=${res.headers["content-encoding"] ?? "(none)"} bytes=${raw.length}`);
      // 等交接单落盘
      let latest = null;
      for (let i = 0; i < 40; i += 1) {
        const files = fs.existsSync(handoffDir)
          ? fs.readdirSync(handoffDir).filter((f) => f.endsWith(".json"))
          : [];
        if (files.length > 0) {
          const withTime = files
            .map((f) => ({ f, t: fs.statSync(path.join(handoffDir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
          latest = path.join(handoffDir, withTime[0].f);
          break;
        }
        const wait = Date.now() + 150;
        while (Date.now() < wait) {
          /* 忙等，保持同步流程简单 */
        }
      }
      if (latest) {
        const json = JSON.parse(fs.readFileSync(latest, "utf-8"));
        console.log(`handoff=${path.basename(latest)} inputTokensAtCapture=${json.inputTokensAtCapture}`);
      } else {
        console.log("handoff=未找到");
      }
    });
  },
);
req.on("error", (e) => {
  console.error("探针失败:", e.message);
  process.exit(2);
});
req.end(payload);

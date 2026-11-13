#!/usr/bin/env node
/**
 * exp-cache-compare.mjs —— 直连 api.deepseek.com 与走 dobostitch 的缓存命中率对照实验
 *
 * 设计要点（保证可比）：
 *  - 两边用**同一份**系统提示 + 同一套工具定义，长度与结构完全一致；
 *  - 每个实验臂在提示最前面放一个"命名空间标记"（armA / armB），
 *    让两臂落在 DeepSeek 侧不同的缓存桶里，互不污染（比较的是命中率，不是绝对命中量）；
 *  - 同一场景两轮连发，第二轮才是有意义的观测点：
 *      S1 静态基线   ：两轮请求体字节完全相同 → 看基础缓存是否正常
 *      S2 时间戳抖动 ：两轮系统提示里的"当前时间"不同（真实客户端都这么干）→ 看 anchor 是否救回前缀
 *      S3 结构抖动   ：两轮语义相同但 JSON key 序 + tools 顺序不同 → 看 stabilize 是否救回前缀
 *  - 直连与走代理的两个请求，除 baseURL 外完全同源；流式 usage 注入在代理侧由代理完成，
 *    直连侧由脚本补同样的 stream_options.include_usage（两边上游拿到的字节一致）。
 *
 * 用法：node scripts/exp-cache-compare.mjs [--proxy-port 27885] [--out <json路径>]
 */

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const argv = process.argv.slice(2);
function arg(key, fallback) {
  const i = argv.indexOf(`--${key}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

const PROXY_PORT = Number(arg("proxy-port", "27885"));
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const ONLY = arg("only", "");
const TAG = arg("tag", "");
const OUT =
  arg("out", "") ||
  path.join(process.env.TEMP ?? ".", "dobostitch-exp", `cache-compare-${Date.now()}.json`);
if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
}

// ---------------- 请求体构造 ----------------

/** 长系统提示：规格条款正文（约 1.6 万字，够触发 DeepSeek 前缀缓存的最小单位 N 倍） */
function longSpec() {
  const lines = [];
  const topics = [
    "请求路由必须按前缀最长匹配，命中后剥离前缀再转发",
    "上游连接错误一律在写出任何响应字节之前 reject，保证可降级重试",
    "响应体旁路采样上限 512KB，超出即丢最旧字节，绝不影响主链路",
    "交接单只在采样成功后落盘，字段缺失写 null 而不是 0",
    "命中率 = 命中 token / 输入 token，分母为 0 时记未判定",
    "工具定义顺序不影响语义，可安全按工具名稳定排序",
    "对象 key 序不影响语义，可安全按字典序规范化",
    "时间字面量在同一会话内锚定为首次见到的原串",
    "改写档位分 off / observe / stabilize / anchor 四挡",
    "任何改写都必须保持返回体与入参同一个 Buffer 引用，除非真的改了",
    "流式 usage 注入只对 openai 方言且 stream 严格为 true 的请求生效",
    "上游回 4xx 且正文明确说不认识该字段时，才去掉注入字段重试一次",
    "客户端自带 stream_options 时一个字节都不动",
    "压缩响应必须先按 content-encoding 解压再解析，否则 usage 恒为空",
    "解压失败只影响旁路计数，绝不允许污染主链路响应字节",
    "同一进程内会话状态按 LRU 管理，默认上限 200 个会话",
    "前缀断点诊断区分 appended / modified / shrunk / none 四类",
    "所有日志禁止打印完整对话内容，只打印段 hash 前 16 位",
    "端口占用时先探测再启动，不要强杀别人的进程",
    "体检卡必须写明本次做了什么、建议如何继续",
  ];
  for (let i = 0; i < 320; i += 1) {
    const t = topics[i % topics.length];
    lines.push(`${String(i + 1).padStart(3, "0")}. 条款 ${String(i + 1).padStart(3, "0")}：${t}；本条款作用域为第 ${(i % 7) + 1} 组，优先级 ${(i % 5) + 1}。`);
  }
  return lines.join("\n");
}

/** 工具定义（12 个，含较详细 schema，贴近真实客户端） */
function toolDefs() {
  const names = [
    "read_file", "write_file", "search_file", "search_chunk", "shell_run", "python_run",
    "list_dir", "move_file", "delete_file", "fetch_url", "make_dir", "zip_dir",
  ];
  return names.map((name, i) => ({
    type: "function",
    function: {
      name,
      description: `工具 ${name}：第 ${i + 1} 号能力，负责本地文件系统或网络的第 ${i + 1} 类操作。调用前请确认路径存在，调用后请核对返回码。`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目标路径，绝对路径优先" },
          recursive: { type: "boolean", description: "是否递归处理子目录" },
          limit: { type: "integer", description: "返回条数上限，默认 100" },
        },
        required: ["path"],
      },
    },
  }));
}

/**
 * 造一次请求。
 * @param {{arm:string, volatileTime?:string, shuffle?:boolean}} opts
 */
function buildRequest(opts) {
  const { arm, volatileTime, shuffle } = opts;
  const header = [
    `【实验命名空间】${arm}`,
    volatileTime ? `当前时间：${volatileTime}` : null,
    "你是 DoboCache 实验用的执行助手，请严格遵守下列规格条款。",
  ]
    .filter((x) => x !== null)
    .join("\n");

  const system = `${header}\n\n## 规格条款\n${longSpec()}`;
  const tools = toolDefs();
  const userText = "按上述规范执行第 1 步。";

  const body = {
    model: "deepseek-chat",
    stream: true,
    temperature: 0,
    max_tokens: 32,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userText },
    ],
    tools,
  };

  if (shuffle) {
    // 语义等价、字节不同：顶层 key 顺序反转 + tools 顺序反转 + 工具内部 key 顺序反转
    const reversedTools = [...tools].reverse().map((tool) => ({
      function: {
        parameters: {
          required: tool.function.parameters.required,
          properties: Object.fromEntries(Object.entries(tool.function.parameters.properties).reverse()),
          type: tool.function.parameters.type,
        },
        description: tool.function.description,
        name: tool.function.name,
      },
      type: tool.type,
    }));
    const keys = Object.keys(body).reverse();
    const rebuilt = {};
    for (const key of keys) rebuilt[key] = key === "tools" ? reversedTools : body[key];
    return rebuilt;
  }
  return body;
}

// ---------------- 发请求 ----------------

/** 直连：补上与代理注入等价的 stream_options */
function directBody(body) {
  return { ...body, stream_options: { include_usage: true } };
}

function post(urlString, bodyObj, { useProxy }) {
  const payload = Buffer.from(JSON.stringify(bodyObj), "utf-8");
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          authorization: `Bearer ${API_KEY}`,
          "accept-encoding": "gzip, deflate, br",
          accept: "text/event-stream",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let raw = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          let decodeOk = true;
          try {
            if (enc === "br") raw = zlib.brotliDecompressSync(raw);
            else if (enc === "gzip") raw = zlib.gunzipSync(raw);
            else if (enc === "deflate") raw = zlib.unzipSync(raw);
          } catch {
            decodeOk = false;
          }
          resolve({
            status: res.statusCode,
            encoding: enc,
            decodeOk,
            text: decodeOk ? raw.toString("utf-8") : "",
            via: useProxy ? "proxy" : "direct",
          });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("请求超时")));
    req.end(payload);
  });
}

/** 从 SSE 文本里抠最后一条 usage */
function usageOf(text) {
  let usage = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && parsed.usage) usage = parsed.usage;
    } catch {
      /* 忽略非 JSON 帧 */
    }
  }
  return usage;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 主流程 ----------------

const DIRECT_URL = "https://api.deepseek.com/v1/chat/completions";
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/deepseek/v1/chat/completions`;

const SCENARIOS = [
  { id: "S1", name: "静态基线（两轮字节完全相同）", make: (arm, round) => buildRequest({ arm }) },
  {
    id: "S2",
    name: "时间戳抖动（系统提示里的当前时间每轮都变）",
    make: (arm, round) =>
      buildRequest({
        arm,
        volatileTime: round === 1 ? "2026-11-13T01:20:07+08:00" : "2026-11-13T01:23:41+08:00",
      }),
  },
  {
    id: "S3",
    name: "结构抖动（语义相同，key 序与 tools 顺序被打乱）",
    make: (arm, round) => buildRequest({ arm, shuffle: round === 2 }),
  },
];

const rows = [];

const SELECTED = ONLY ? SCENARIOS.filter((s) => s.id === ONLY) : SCENARIOS;
for (const scenario of SELECTED) {
  for (const arm of ["direct", "proxy"]) {
    for (const round of [1, 2]) {
      const body = scenario.make(arm === "direct" ? `armA${TAG}` : `armB${TAG}`, round);
      const outbound = arm === "direct" ? directBody(body) : body;
      const started = Date.now();
      const res = await post(arm === "direct" ? DIRECT_URL : PROXY_URL, outbound, { useProxy: arm === "proxy" });
      const usage = usageOf(res.text);
      const prompt = usage?.prompt_tokens ?? 0;
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      rows.push({
        scenario: scenario.id,
        scenarioName: scenario.name,
        arm,
        round,
        status: res.status,
        encoding: res.encoding,
        promptTokens: prompt,
        cachedTokens: cached,
        hitRate: prompt > 0 ? Number(((cached / prompt) * 100).toFixed(2)) : null,
        completionTokens: usage?.completion_tokens ?? 0,
        elapsedMs: Date.now() - started,
      });
      console.log(
        `${scenario.id} ${arm} round${round} status=${res.status} enc=${res.encoding} prompt=${prompt} cached=${cached} hit=${prompt > 0 ? ((cached / prompt) * 100).toFixed(2) : "n/a"}%`,
      );
      await sleep(1500);
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), proxyPort: PROXY_PORT, rows }, null, 2),
  "utf-8",
);
console.log(`结果已写入：${OUT}`);

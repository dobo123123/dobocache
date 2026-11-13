#!/usr/bin/env node
/**
 * 文档一致性校验（v0.4.6 起）
 *
 * 背景：v0.4.6 审计一次性抓到「12 处安装命令指向旧版 / 根 README 标题旧版 /
 * 版本说明写的是上一版改动 / FAQ 引用不存在的版本」四类同源问题 —— 根因是三份
 * README 各自手改、没有机器校验。本脚本把「对外文档必须与包版本一致」固化为
 * 可执行断言，发布前跑一次即可。
 *
 * 用法：npm run check:docs（或 node scripts/check-docs.mjs）
 * 退出码：0 通过；1 有 ERROR
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const V = pkg.version;                       // 例如 0.4.6
const V_TAG = `v${V}`;                       // 例如 v0.4.6

/** 对外文档清单（包内可分发的全部 .md） */
const DOCS = [
  'README.md',
  'release/README.zh.md',
  'release/README.en.md',
  'release/FAQ-使用须知.md',
  'release/零基础三分钟上手.md',
  'release/兼容性说明.md',
  'release/社区帖-中文.md',
  'release/社区帖-English.md',
];

/** 历史存在过的版本号（用于「引用了不存在的版本」检查） */
const KNOWN_VERSIONS = ['0.3.0', '0.4.0', '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.4.6', '0.4.7', '0.4.8', '0.4.9', '0.5.0', '0.5.1', '0.5.2'];

const errors = [];
const warns = [];

const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    errors.push(`[缺文件] ${rel} 不存在`);
    return '';
  }
};

const docs = new Map(DOCS.map((d) => [d, read(d)]));

/* ---------- 1. 三份主 README 标题必须等于 package.json version ---------- */
const MAIN_READMES = ['README.md', 'release/README.zh.md', 'release/README.en.md'];
for (const rel of MAIN_READMES) {
  const text = docs.get(rel) || '';
  const m = text.match(/^#\s*DoboCache\s+(v[\d.]+)/m);
  if (!m) {
    errors.push(`[标题] ${rel} 未找到「# DoboCache vX.Y.Z」标题`);
  } else if (m[1] !== V_TAG) {
    errors.push(`[标题] ${rel} 标题为 ${m[1]}，应为 ${V_TAG}`);
  }
}

/* ---------- 2. npm 安装命令与便携包名必须是当前版本 ---------- */
/** 历史叙述豁免（v0.5.2 起）：行内含这些字样时，引用旧版版本号属「讲清楚上一版错在哪」，
 *  降级为 WARN 而不阻塞发布；同理 `-p dobocache@<旧版>` 是官方给出的旧版兼容写法，也豁免。 */
const HISTORY_MARKERS = ['旧版', '历史', '的问题', '上一版'];
const isHistoricalRef = (text, index, pkgRef) => {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  if (HISTORY_MARKERS.some((k) => line.includes(k))) return true;
  const before = text.slice(Math.max(0, index - 8), index);
  return /-p\s+$/.test(before) || pkgRef.startsWith('-p ');
};
for (const [rel, text] of docs) {
  for (const m of text.matchAll(/dobocache@([\d.]+)/g)) {
    if (m[1] !== V) {
      const pkgRef = text.slice(Math.max(0, m.index - 8), m.index + m[0].length);
      if (isHistoricalRef(text, m.index, pkgRef)) {
        warns.push(`[安装命令·历史引用] ${rel} 提到 dobocache@${m[1]}（当前 ${V}），已豁免`);
      } else {
        errors.push(`[安装命令] ${rel} 出现 dobocache@${m[1]}，应为 @${V}`);
      }
    }
  }
  for (const m of text.matchAll(/dobocache-(v[\d.]+)-portable\.zip/g)) {
    if (m[1] !== V_TAG) errors.push(`[包名] ${rel} 引用 ${m[1]} 便携包，应为 ${V_TAG}`);
  }
  for (const m of text.matchAll(/解压\s*(v[\d.]+)\s*便携包/g)) {
    if (m[1] !== V_TAG) errors.push(`[解压表述] ${rel} 写「解压 ${m[1]} 便携包」，应为 ${V_TAG}`);
  }
}

/* ---------- 3. 不得引用从未发布过的版本（只看本项目 0.x 版本域，避免误伤 Node 版本） ---------- */
for (const [rel, text] of docs) {
  for (const m of text.matchAll(/\bv(0\.\d+\.\d+)\b/g)) {
    const ver = m[1];
    if (!KNOWN_VERSIONS.includes(ver)) {
      errors.push(`[版本不存在] ${rel} 引用了未发布版本 v${ver}（已知：${KNOWN_VERSIONS.join(' / ')}）`);
    }
  }
}

/* ---------- 4. 测试数与实际一致（只做残留旧值拦截） ---------- */
// 实际通过数由 npm test 输出决定，这里拦截已知过期写法，避免再次漂移。
const STALE_TEST = ['88 / 88', '88/88', '88 项'];
for (const [rel, text] of docs) {
  for (const s of STALE_TEST) {
    if (text.includes(s)) errors.push(`[测试数] ${rel} 含过期测试数写法「${s}」`);
  }
}

/* ---------- 5. v0.4.6 口径：日志示例 hitRate 未判定必须写 null ---------- */
for (const [rel, text] of docs) {
  if (/"hitRate"\s*:\s*0\b/.test(text)) {
    errors.push(`[hitRate 口径] ${rel} 日志示例出现 "hitRate": 0，未判定应为 null`);
  }
}

/* ---------- 6. 兼容性说明必须写明「当前包」的 serverInfo.version ---------- */
{
  const t = docs.get('release/兼容性说明.md') || '';
  if (!t.includes(`"version":"${V}"`)) {
    errors.push(`[兼容性说明] 未找到当前包 serverInfo '"version":"${V}"' 的实测记录`);
  }
  // 历史实测记录允许保留旧版本号，但须显式标注为「当时的包版本」，避免读者误以为当前包仍是旧版
  const legacy = [...t.matchAll(/serverInfo=\{name:"dobocache",version:"(0\.\d+\.\d+)"\}/g)]
    .map((m) => m[1]).filter((v) => v !== V);
  for (const v of legacy) {
    if (!t.includes('实测所用包版本')) {
      errors.push(`[兼容性说明] 含历史实测版本 ${v}，但未标注「实测所用包版本」，易被误读为当前版本`);
    }
  }
}

/* ---------- 7. server.json / package.json 同步 ---------- */
{
  try {
    const sj = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
    if (sj.version && sj.version !== V) errors.push(`[server.json] version=${sj.version}，应为 ${V}`);
    const pv = sj.packages?.[0]?.version;
    if (pv && pv !== V) errors.push(`[server.json] packages[0].version=${pv}，应为 ${V}`);
  } catch {
    warns.push('[server.json] 解析失败或不存在');
  }
}


/* ---------- 8. 对外文档不得夹带生成工具元数据标签 ---------- */
// 导出工具会在文件头注入一段 YAML 元数据（编号、追踪标识、校验串一类）。
// 复制粘贴内容时极易被整段带进来：对读者毫无意义，却能让文件被反查到具体产出环境，
// 属于发布前必须清掉的残留，一律不允许出现在对外文档里。
// 关键词拆成两段拼接：本脚本自身也会被发布包的自检脚本扫描，
// 常量里直接写出完整关键词会触发自检自指误报，拆开后功能不变、自检也不再误伤。
const WATERMARK = [
  'AI' + 'GC:', 'Content' + 'Producer', 'Content' + 'Propagator',
  'Produce' + 'ID:', 'Propagate' + 'ID', 'Reserved' + 'Code',
];
for (const [rel, text] of docs) {
  for (const w of WATERMARK) {
    if (text.includes(w)) errors.push(`[水印] ${rel} 含生成工具元数据标签「${w}」，须删除后再发布`);
  }
}

/* ---------- 9. 三份主 README 必须保留「官方入口声明」与新手入口 ---------- */
for (const rel of MAIN_READMES) {
  const t = (docs.get(rel) || '').toLowerCase();
  if (!/official source|官方入口声明/.test(t)) {
    errors.push(`[官方声明] ${rel} 缺少「官方入口声明」块（其他渠道同名项目泛滥，此块不可删）`);
  }
  if (!/零基础三分钟上手/.test(docs.get(rel) || '')) {
    errors.push(`[新手入口] ${rel} 缺少指向「零基础三分钟上手」的链接`);
  }
}

/* ---------- 10. FAQ 必须保留安装报错速查章节且有实质条目 ---------- */
{
  const t = docs.get('release/FAQ-使用须知.md') || '';
  if (!t.includes('安装报错速查')) {
    errors.push('[FAQ] 缺少「安装报错速查」章节（安装类提问占比最高，此章为降答疑主件）');
  } else {
    const seg = t.slice(t.indexOf('安装报错速查'));
    const n = (seg.match(/^### \d+\. /gm) || []).length;
    if (n < 10) errors.push(`[FAQ] 安装报错速查条目仅 ${n} 条，应不少于 10 条`);
  }
  // 渠道口径策略：文档不写死「是否已上架」，只要求给出「取不到时改用便携包」的条件回退指引。
  // 这样上架前后文案都成立，不必在上架当天改文档、也不必重打 zip 与 npm 包（已发布的包内容不可改）。
  //   'conditional' —— 默认，推荐：必须含 npx 写法 + 条件回退指引，且不得出现绝对状态断言
  //   'unpublished' —— 未上架期强限定口径（历史模式）
  //   'published'   —— 已上架口径
  const NPM_MODE = 'conditional';
  // 绝对状态断言：上架前后必有一边为假，一律禁止
  const ABSOLUTE_MARK = /尚未上架|not on npm yet|has not been published to the npm/;
  // 条件回退指引：上架前后都成立
  const FALLBACK_MARK = /取不到|尚未同步|尚未发布|返回 `404`|returns `404`|not published yet|has not synced|use Mode A/;
  for (const rel of MAIN_READMES) {
    const text = docs.get(rel) || '';
    const hasNpx = /npx/.test(text);
    const hasAbsolute = ABSOLUTE_MARK.test(text);
    const hasFallback = FALLBACK_MARK.test(text);
    if (NPM_MODE === 'conditional') {
      if (!hasNpx) errors.push(`[npm 状态] ${rel} 缺少 npx 一次性运行写法`);
      if (!hasFallback) errors.push(`[npm 状态] ${rel} 含 npx 但缺少「取不到时改用便携包」的条件回退指引`);
      if (hasAbsolute) errors.push(`[npm 状态] ${rel} 含「尚未上架」类绝对状态断言，应改为条件表述（上架后会失真）`);
    } else if (NPM_MODE === 'unpublished') {
      // 未上架期间：出现 npx 必须同时标注限定，防止新手照抄失败
      if (hasNpx && !hasAbsolute) {
        errors.push(`[npm 状态] ${rel} 含 npx 写法但未标注「npm 未上架」限定`);
      }
    } else {
      // 已上架：不得残留未上架表述，且必须给出 npx 一次性运行写法
      if (hasAbsolute) errors.push(`[npm 状态] ${rel} 已上架，但仍含「未上架」表述，需清理`);
      if (!hasNpx) errors.push(`[npm 状态] ${rel} 已上架，但缺少 npx 一次性运行写法`);
    }
  }
}

/* ---------- 11. npx 命令写法必须与入口实现匹配（v0.5.2 起，P0 回归守卫） ---------- */
// 背景：`npx <包名> <参数...>` 只会执行与包同名的那个 bin（dobocache），
// 只有 `npx -p <包名> <bin>` 才能真正指定别的 bin。v0.5.1 首屏命令写成
// `npx -y dobocache@0.5.1 dobostitch start`，实际启动的是 MCP server：stdin 开着就
// 静默挂死、stdin 关了就地退出，用户永远走不到代理。
// v0.5.2 在 src/index.ts 增加了子命令转发（forwardToProxyIfNeeded），该写法才重新成立。
// 本检查把「文档写法 ↔ 入口实现」的对应关系固化成断言，两边不一致就报错：
//   · 入口有转发   → 允许 `npx -y dobocache@X dobostitch ...`
//   · 入口没转发   → 必须写 `npx -y -p dobocache@X dobostitch ...`
const SUBCOMMANDS = ['start', 'status', 'resume', 'doctor'];
let forwardingEnabled = false;
try {
  const entrySrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  forwardingEnabled = /forwardToProxyIfNeeded/.test(entrySrc) && /PROXY_SUBCOMMANDS/.test(entrySrc);
} catch {
  errors.push('[入口转发] 读不到 src/index.ts，无法判定 npx 写法是否成立');
}

for (const [rel, text] of docs) {
  for (const line of text.split(/\r?\n/)) {
    if (!/npx\b/.test(line)) continue;
    // 只看「包名 + 子命令/bin 名」混写的命令
    if (!/dobocache@[\d.]+/.test(line) || !/dobostitch/.test(line)) continue;
    const hasPackageFlag = /(^|\s)(-p|--package)(=|\s)/.test(line);
    if (!hasPackageFlag && !forwardingEnabled) {
      errors.push(
        `[npx 写法] ${rel} 用了「npx <包名> dobostitch ...」但入口未实现子命令转发，` +
          `该命令实际启动的是 MCP server（会挂死）。请改为「npx -y -p dobocache@X dobostitch ...」，或在 src/index.ts 补转发。`,
      );
    }
  }
}

/* 子命令名必须与入口转发白名单一致，防止文档写 start 而入口只认 run */
if (forwardingEnabled) {
  const entrySrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  const m = entrySrc.match(/PROXY_SUBCOMMANDS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (m) {
    const whitelist = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    for (const sub of SUBCOMMANDS) {
      if (!whitelist.includes(sub)) {
        warns.push(`[子命令] 文档/备忘里的「${sub}」不在入口转发白名单（${whitelist.join('/')}）中`);
      }
    }
  }
}

/* ---------- 输出 ---------- */
console.log(`DoboCache 文档一致性校验 · 目标版本 ${V_TAG}`);
console.log(`受检文档 ${DOCS.length} 份\n`);
for (const w of warns) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`\n结果：${errors.length} ERROR / ${warns.length} WARN`);
process.exit(errors.length ? 1 : 0);

/**
 * DoboCache hitJudge — 命中判定引擎
 * 迁移自旧插件 FilterEngine 的设计理念：
 *   1) 负向过滤：先剔除排除词/黑名单命中的条目
 *   2) 关键词分层分类：实体锚词（高权重）、意图修饰词（低权重）、语气虚词剔除
 *   3) 综合评分 = 锚词/意图命中分 × 时效衰减系数
 *   4) 交叉关联召回：从初筛高分条目中提取实体，二次召回关联条目
 * 目标：判定"当前请求能否命中既有缓存上下文"，并给出可解释证据。
 */

export interface CacheEntry {
  id: string;
  query: string;
  response?: string;
  content?: string;
  category?: string;
  keywords?: string[];
  timestamp: number;
  hitCount?: number;
  tier?: "A" | "B" | "C";
}

export interface HitContext {
  blacklist?: string[];
  threshold?: number;
  topK?: number;
  now?: number;
}

export interface HitResult {
  hit: boolean;
  score: number;
  threshold: number;
  matched: Array<{ entry: CacheEntry; score: number; round: 1 | 2 }>;
  evidence: string[];
  stats: {
    candidates: number;
    afterNegative: number;
    primary: number;
    cross: number;
  };
}

const FILLER_WORDS = new Set([
  "帮我", "请问", "能否", "麻烦", "能不能", "可以", "请", "能", "吧", "怎么", "如何",
  "什么", "为什么", "怎样", "吗", "呢", "哈", "呀", "嗯", "哦", "噢", "这个", "那个",
  "然后", "其实", "不过", "但是", "就是", "还是", "或者", "因为", "所以", "如果",
  "虽然", "当然", "真的", "非常", "很", "太", "挺", "蛮",
]);

const INTENT_WORDS = new Set([
  "境界", "突破", "修复", "编写", "调整", "优化", "修改", "增加", "创建", "实现",
  "删除", "重构", "测试", "部署", "运行", "提交", "合并", "发布", "开发", "设计",
  "处理", "配置", "设置", "更新", "升级", "迁移", "集成", "对接", "调用", "安装",
  "启动", "停止", "重启", "备份", "恢复", "构建", "打包", "转换", "生成", "分析",
  "计算", "导入", "导出", "查询", "检索", "搜索", "过滤", "筛选", "排序", "统计",
  "命中", "判定", "调节", "默认", "启用", "禁用", "打开", "关闭", "执行", "完成",
]);

const NEGATIVE_MARKERS = ["不要", "不提", "忽略", "排除", "不用", "放弃", "删掉", "避开", "跳过", "去掉"];

/** 实体锚词强形态：反引号包裹 / 版本号 / 大写常量 / 英文标识符 / 文件与域名 */
const STRONG_ENTITY_PATTERNS: RegExp[] = [
  /^`([^`]{2,60})`$/,
  /^(\d+\.\d+\.\d+[-.\w]*)$/,
  /^([A-Z][A-Z_0-9]{2,30})$/,
  /^([A-Za-z][A-Za-z0-9_]{1,40})$/,
  /^([\w-]+\.[\w]{1,10})$/,
];

const STOP_WORDS = new Set([
  "的", "了", "是", "在", "有", "和", "与", "或", "但", "这", "那", "以及", "并且",
  "然后", "就是", "因为", "所以", "如果", "虽然", "但是", "还是", "或者", "关于",
  "对于", "进行", "一下", "一个", "这个", "那个", "这些", "那些", "我们", "你们",
  "他们", "咱们", "怎么", "如何", "什么", "为什么", "多少",
]);

/** 中文切分词典 = 虚词 + 停用词 + 意图词 */
const CJK_DICT = new Set<string>([...FILLER_WORDS, ...STOP_WORDS, ...INTENT_WORDS]);

/** 单字停用词：不参与实体，切分时直接剥离 */
const STOP_WORDS_1CHAR = new Set(["的", "了", "是", "在", "有", "和", "与", "或", "但", "这", "那"]);

/**
 * 中文串按词典贪心切分：输出意图词段与非词块（实体候选）。
 * 虚词/停用词段直接丢弃，单字停用词剥离，意图词段保留供意图识别。
 */
function splitCjkPhrases(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (let len = Math.min(4, text.length - i); len >= 2; len--) {
      const w = text.slice(i, i + len);
      if (CJK_DICT.has(w)) {
        if (buf) {
          out.push(buf);
          buf = "";
        }
        if (INTENT_WORDS.has(w)) out.push(w);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const ch = text[i];
      if (STOP_WORDS_1CHAR.has(ch)) {
        if (buf) {
          out.push(buf);
          buf = "";
        }
      } else {
        buf += ch;
      }
      i++;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 单个 token 切分：强实体优先，否则中文切分，否则按意图词包含判定 */
function splitToken(token: string): { entities: string[]; intents: string[] } {
  const entities: string[] = [];
  const intents: string[] = [];

  for (const pattern of STRONG_ENTITY_PATTERNS) {
    const m = token.match(pattern);
    if (m) {
      entities.push((m[1] ?? m[0]) as string);
      return { entities, intents };
    }
  }

  if (/[\u4e00-\u9fff]/.test(token)) {
    for (const seg of splitCjkPhrases(token)) {
      if (seg.length < 2) continue;
      if ([...INTENT_WORDS].some((w) => seg.includes(w))) intents.push(seg);
      else entities.push(seg);
    }
    return { entities, intents };
  }

  if ([...INTENT_WORDS].some((w) => token.includes(w))) intents.push(token);
  else if (token.length >= 2) entities.push(token);
  return { entities, intents };
}

export interface ClassifiedTokens {
  entities: string[];
  intents: string[];
  all: string[];
}

/** 关键词分层分类：实体锚词、意图修饰词、虚词剔除 */
export function classifyTokens(query: string): ClassifiedTokens {
  if (!query) return { entities: [], intents: [], all: [] };

  const raw = query.split(/\s+/).filter((t) => t.length > 0);
  const entities = new Set<string>();
  const intents = new Set<string>();
  const all = new Set<string>();

  for (const t of raw) {
    if (t.length <= 1) continue;
    const { entities: e, intents: i } = splitToken(t);
    for (const x of e) entities.add(x);
    for (const x of i) intents.add(x);
  }

  const backticks = query.match(/`([^`]{2,60})`/g);
  if (backticks) {
    for (const m of backticks) entities.add(m.replace(/`/g, ""));
  }

  const keyval = query.match(/([\w-]+)\s*[:=]\s*["']?([\w\u4e00-\u9fff]{2,30})["']?/);
  if (keyval) entities.add(keyval[1]);

  for (const x of entities) all.add(x);
  for (const x of intents) all.add(x);

  return { entities: [...entities], intents: [...intents], all: [...all] };
}

/** 负向短语可剥离的动词前缀 */
const NEGATIVE_VERB_STRIP = /^(提及|提到|涉及|包含|考虑|讲|说|谈|讨论|聊|使用|采用|选择)/;

/** 从问句中提取否定排除目标词 */
export function extractNegativeTerms(query: string): string[] {
  if (!query) return [];
  const exclusions = new Set<string>();
  for (const marker of NEGATIVE_MARKERS) {
    const idx = query.indexOf(marker);
    if (idx === -1) continue;
    const after = query.substring(idx + marker.length).trim();
    const phrase = after.match(/^[\u4e00-\u9fff\uA000-\uFFFF]{2,10}/);
    if (phrase) {
      const cleaned = phrase[0].replace(NEGATIVE_VERB_STRIP, "");
      if (cleaned.length >= 2) exclusions.add(cleaned);
    }
  }
  return [...exclusions];
}

/** 时效衰减系数：1 天内 1.0，1~7 天 0.7，7 天以上 0.4 */
export function timeDecay(timestamp: number, now = Date.now()): number {
  if (!timestamp || typeof timestamp !== "number") return 0.7;
  const days = (now - timestamp) / (24 * 60 * 60 * 1000);
  if (days <= 1) return 1.0;
  if (days <= 7) return 0.7;
  return 0.4;
}

/** 负向过滤：剔除包含排除词或黑名单词（支持 /regex/ 形式）的条目 */
export function applyNegativeFilter(
  entries: CacheEntry[],
  negativeTerms: string[],
  blacklist: string[] = [],
): CacheEntry[] {
  const terms: Array<string | RegExp> = [...negativeTerms];
  for (const entry of blacklist) {
    if (entry.startsWith("/") && entry.endsWith("/") && entry.length > 2) {
      try {
        terms.push(new RegExp(entry.slice(1, -1), "i"));
      } catch {
        /* 非法正则按字符串处理 */
        terms.push(entry);
      }
    } else {
      terms.push(entry);
    }
  }
  if (terms.length === 0) return entries;

  return entries.filter((e) => {
    const content = `${e.content ?? ""} ${e.query}`.toLowerCase();
    return !terms.some((term) => {
      if (!term) return false;
      if (term instanceof RegExp) return term.test(content);
      return content.includes(String(term).toLowerCase());
    });
  });
}

/** 单项综合评分：锚词×4/3/2 + 意图×2/1/1，乘以时效衰减，加少量历史命中激励 */
export function scoreEntry(query: string, entry: CacheEntry, now = Date.now()): number {
  const { entities, intents } = classifyTokens(query);
  if (entities.length === 0 && intents.length === 0) return 0;

  const q = (entry.query || "").toLowerCase();
  const r = (entry.response || "").toLowerCase();
  const c = (entry.content || "").toLowerCase();

  let score = 0;
  for (const term of entities) {
    const t = term.toLowerCase();
    if (q.includes(t)) score += 4;
    else if (r.includes(t)) score += 3;
    else if (c.includes(t)) score += 2;
  }
  for (const term of intents) {
    const t = term.toLowerCase();
    if (q.includes(t)) score += 2;
    else if (r.includes(t)) score += 1;
    else if (c.includes(t)) score += 1;
  }

  const decay = timeDecay(entry.timestamp, now);
  const boost = Math.min(1, (entry.hitCount ?? 0) * 0.1);
  return Math.round((score * decay + boost) * 10) / 10;
}

/** 交叉关联召回：从初筛高分条目提取实体，二次搜索关联条目 */
export function crossReference(
  query: string,
  primary: Array<{ entry: CacheEntry; score: number }>,
  all: CacheEntry[],
  now = Date.now(),
): Array<{ entry: CacheEntry; score: number; round: 2 }> {
  const entityTerms = new Set<string>();
  for (const { entry } of primary) {
    const { entities } = classifyTokens(entry.query || "");
    for (const e of entities) {
      const t = e.toLowerCase();
      if (t.length >= 2) entityTerms.add(t);
    }
  }

  const primaryIds = new Set(primary.map((p) => p.entry.id));
  const queryEntities = classifyTokens(query).entities.map((e) => e.toLowerCase());
  for (const e of queryEntities) entityTerms.delete(e);
  if (entityTerms.size === 0) return [];

  const results: Array<{ entry: CacheEntry; score: number; round: 2 }> = [];
  for (const m of all) {
    if (primaryIds.has(m.id)) continue;
    const content = (m.content || "").toLowerCase();
    const queryText = (m.query || "").toLowerCase();
    let matchScore = 0;
    for (const entity of entityTerms) {
      if (queryText.includes(entity)) matchScore += 2;
      else if (content.includes(entity)) matchScore += 1;
    }
    if (matchScore > 0) {
      const finalScore = Math.round(matchScore * 0.6 * timeDecay(m.timestamp, now) * 10) / 10;
      results.push({ entry: m, score: finalScore, round: 2 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/** 主入口：负向过滤 → 评分排序 → 阈值判定 → 交叉关联 */
export function judgeHit(
  query: string,
  entries: CacheEntry[],
  ctx: HitContext = {},
): HitResult {
  const now = ctx.now ?? Date.now();
  const threshold = ctx.threshold ?? 5;
  const topK = ctx.topK ?? 5;

  const negativeTerms = extractNegativeTerms(query);
  const afterNegative = applyNegativeFilter(entries, negativeTerms, ctx.blacklist ?? []);

  const scored = afterNegative
    .map((entry) => ({ entry, score: scoreEntry(query, entry, now) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const primary: Array<{ entry: CacheEntry; score: number; round: 1 }> = scored
    .slice(0, topK)
    .map((s) => ({ ...s, round: 1 as const }));
  const cross = crossReference(query, primary, afterNegative, now);

  const combined = [...primary, ...cross].sort((a, b) => b.score - a.score);
  const matched = combined.slice(0, topK);

  const bestScore = matched.length > 0 ? matched[0].score : 0;
  const hit = bestScore >= threshold;

  const evidence: string[] = [];
  if (negativeTerms.length > 0) evidence.push(`负向过滤 ${negativeTerms.length} 个排除词`);
  if (hit) {
    evidence.push(`最高分 ${bestScore} 达到阈值 ${threshold}`);
    for (const { entry, score } of matched.slice(0, 3)) {
      evidence.push(`条目[${entry.id}] 得分 ${score}（${entry.category ?? "未分类"}）`);
    }
  } else if (matched.length > 0) {
    evidence.push(`最高分 ${bestScore} 未达阈值 ${threshold}`);
  } else {
    evidence.push("无评分命中条目");
  }

  return {
    hit,
    score: bestScore,
    threshold,
    matched,
    evidence,
    stats: {
      candidates: entries.length,
      afterNegative: afterNegative.length,
      primary: primary.length,
      cross: cross.length,
    },
  };
}

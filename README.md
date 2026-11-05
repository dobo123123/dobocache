**[简体中文](README.md) · [English](release/README.en.md)**

---

# DoboCache v0.4.7

> **命中缓存 + 白盒报告 —— 装上 token 就是少，每一步看得见。**

DoboCache 是一个以 **stdio 方式挂载的 MCP Server**，作用是在你已有的编码 CLI / Agent 客户端和模型厂商 API 之间，把每一次请求的上下文整理成**稳定、可复用、过长会自动补足**的前缀，从而让厂商的**前缀缓存（prompt caching）**真正命中；命中与否、命中多少、哪一步做了调整，全部写进本地白盒日志并可随时查询。

---

> **官方入口声明**
> DoboCache 的官方代码仓库只有 <https://github.com/dobo123123/dobocache> 一处，官方发布物只在它的 Releases 页面。
> 在其他渠道看到同名项目、同名服务或付费版本，均非官方出品。本项目免费，不通过任何第三方平台售卖。

> **第一次用？请先看 [零基础三分钟上手](release/零基础三分钟上手.md)** —— 从装 Node 到验证成功，六步走完，不用懂原理。
> 装的过程中报错，直接翻 [FAQ 的「安装报错速查」](release/FAQ-使用须知.md#安装报错速查装不上先看这一章)，按报错原文查。
>
> 装不上、配不通、不知道怎么写配置？先看上面的 FAQ；还不行就到 [Discussions](https://github.com/dobo123123/dobocache/discussions) 提问（安装类问题不用开 Issue）。


## 平台支持状态（装之前先看这一节）

DoboCache 是纯 JavaScript 的 stdio MCP Server，包内**不含任何原生二进制**（`.node` / `.exe` / `.dll` 数量均为 0），因此不存在 ABI 层面的平台锁定。但"**能跑**"和"**验证过**"是两件事，本版按实际验证程度如实标注：

| 平台 | 状态 | 验证到什么程度 |
|---|---|---|
| **Windows 10 / 11（x64）** | ✅ **主打平台，已真机验证** | 真机端到端跑通：本组实验 20 次连续请求对照（含真实 MCP 客户端挂载 + 厂商 usage 校验）、便携包解压即跑冒烟、全量 **94 项**测试通过、日志落盘实测 `%LOCALAPPDATA%\DoboCache\logs` |
| **Linux（x86_64）** | 🟡 **容器环境已实测**（非桌面真机） | 2026-11-04 在 Docker `linux/amd64` + Node 官方 Linux 镜像内对发布包做真实运行：解压即跑、`initialize`/`tools/list` 返回合法、9 个工具全在、`cf_judge` 命中、`cf_inject` 返回 `prefixReady=true`、日志按 `~/.local/state/dobocache` 落盘、`XDG_STATE_HOME` 生效、`DOBOCACHE_LOG_DIR` 优先级最高、只读目录降级不崩溃、Node 16 自检 `exit 1`。**桌面 Linux 真机 + 图形客户端挂载、arm64 仍未验证**（细节见 [`兼容性说明.md`](release/兼容性说明.md) 附录 A） |
| **macOS（Intel / Apple Silicon）** | ⚠️ **未真机验证**（预期可用） | 仅有**单元测试覆盖**：`~/Library/Logs/DoboCache` 路径解析及上述同批用例。**没有在真实 Mac 上跑过完整链路** |

**我们把边界说清楚**：

1. Windows 是主打平台，也是**唯一**做过真机端到端验证（真实客户端挂载 + 厂商 usage 回读）的平台；
2. Linux 已在 `linux/amd64` 容器环境做过真实运行验证（协议链路 + 日志 + 只读降级 + Node 版本自检），但**桌面发行版的图形客户端挂载、arm64 仍未验证**；macOS **从未在真机运行过**。因此 macOS 只写"未验证"，Linux 只写"容器已实测"，都不写"完整支持"；成功率我们没有真实数据，不做任何百分比承诺；
3. **欢迎反馈后修**：在 Linux / macOS 上跑通或跑挂，都请反馈。我们不把这些平台当作"理论上没问题所以不用管"。

**反馈渠道**

| 渠道 | 怎么用 |
|---|---|
| GitHub Issues（推荐） | 标题带 `[platform: macOS]` 或 `[platform: linux]`；正文附 `node -v`、`uname -a`（macOS 用 `sw_vers`）、`cf_report` 返回的 `logDir` / `logDirSource`、完整报错原文 |
| 私下联系（非公开） | 安全类问题请走 [`SECURITY.md`](SECURITY.md) 的私下上报渠道（GitHub Security Advisories），**不要**在公开 issue 中披露；一般问题走 Issues 即可。本项目当前不公开电子邮件地址，以避免维护者个人邮箱被骚扰、撞库或用于社工攻击 |
| 自查（反馈前先看） | `release/FAQ-使用须知.md` §三（日志在哪）与 §七（`prefixReady=false` 怎么办），可解决大部分"看起来没生效"的问题 |

> **反馈时不要把提问原文粘进 issue**：日志已脱敏（`req-<hash>` / `sid-<hash>`），贴日志片段足够定位问题。

---

## 一、它解决什么问题

现代厂商 API 都提供前缀缓存：请求开头部分如果与上一次完全一致，这部分 token 按缓存价计费，不再全价重算。但真实对话里前缀经常"差一点点"：

- 系统提示词顺序不稳定、拼接顺序每次不同；
- 历史消息被裁剪后长度对不齐缓存块边界（常见是 128 token 对齐）；
- 前缀长度小于厂商的最小缓存门槛，压根不进入缓存；
- 重复指令、重复文档块让前缀越来越长却越来越脏。

任何一处不一致，缓存就整个失效——**你以为在用缓存，其实一直在全价重算**。DoboCache 就是把这些"差一点点"逐条修掉，并且**把每一步的调整原因写清楚**，让你能自己核对而不是只看一个漂亮数字。

## 二、九个可调用的工具（8 个业务工具 + 1 个 `ping` 健康检查）

server 共暴露 **8 个业务工具 + 1 个健康检查（`ping`）**，均为 stdio 本地调用，不联网、不上传：

| 工具 | 作用 | 是否写盘 |
|---|---|---|
| `cf_judge` | **命中判定**：关键词分层（实体锚词/意图修饰词）→ 三层匹配 → 时效衰减 → 负向过滤，输出可解释证据（`hit` / `score` / `evidence` / `matched`） | 记白盒日志 |
| `cf_tier` | **价值分级准入**：提纯去噪 → A/B/C 分级 → 按预算从高到低填充，输出准入列表与丢弃明细 | 否 |
| `cf_inject` | **记忆提纯注入**：把上下文整理成稳定前缀（去重 → 128 token 对齐 → 过门槛补足），返回可直接发送的 `prefix` / `tail` | 记白盒日志、冻结会话前缀（内存） |
| `cf_warmup` | **预热**：正式请求前显式调用一次，用冻结前缀构造最小占位请求，触发厂商前缀缓存建立（会产生少量计费，需自行发一次 LLM 请求） | 否 |
| `cf_report` | 白盒累计统计：累计命中率、原始/优化 token、按会话聚合（`per_session`），并回传日志实际落点 `logDir` / `logDirSource`；加 `source="disk"` 时改为**从本地日志重新聚合**（跨进程、跨天累计，客户端重启不清零），`days=<n>` 限定只读最近 n 天 | 否（读日志） |
| `cf_meter` | 请求计量快照（token 计数与计价相对值，不含任何请求正文） | 否 |
| `cf_prune` | 工具输出确定性修剪：去重行、压缩空白、行数/字符数双上限，返回修剪前后体积比 | 否 |
| `cf_normalize` | 结构化结果归一：字段裁剪 + 稳定排序，返回不含原文的键值（`nk-<16 位 hash>`） | 否 |

典型参数：`cf_inject(reset=true, sessionId=<你的会话标识>, minPrefixTokens=<目标厂商门槛>)`。

> 参数在协议层做类型与范围校验（如 `threshold ≥ 0`、`topK ≥ 1`、`maxChars ≥ 1`、`maxTokens > 0`），越界会返回标准 `-32602` 校验错误并指明字段，不会静默生效。

## 三、版本说明（请先读这一节）

**v0.4.7 = 日志有了边界 + 统计能跨重启 + 一个说清的工具。日志自动轮转与保留期、`cf_report` 支持 `source="disk"` 读盘聚合、`cf_prune` 描述纠正；缓存核心算法零改动，命中行为与 v0.4.4 逐字节一致。**

| 项目 | 说明 |
|---|---|
| 承接 | v0.4.4 的 `minPrefixTokens` 修复（v0.4.3 补的那一行）与日志隐私脱敏（`requestId` → `req-<8 位 hash>`；`sessionId` → `sid-<8 位 hash>`；`cf_normalize` 键 → `nk-<16 位 hash>`）全部保留 |
| 本版新增 | ① **日志有了边界**：单文件到 10MB 滚动为 `.1`、最多 3 份副本，超 7 天的旧日志在当天首次写盘时清理（`DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS` 可调）；清理只认本模块命名，同目录你自己的文件一个都不动，失败静默跳过，`cf_report` 的 `logPolicy` / `logMaintenance` 可自查；② **`cf_report` 支持 `source="disk"`**：改为从本地日志重新聚合（`days=<n>` 限定窗口），MCP 客户端重启后历史数据不再归零；口径与内存态一致（`hitRate` 只对已判定行求均值，无判定仍返回 `null`），坏行计入 `skippedLines` 不中断聚合；③ **`cf_prune` 说清**：它只修剪调用时传入的 `text`，不读取、不删除磁盘上任何文件，尤其不会删白盒日志 |
| 命中相关代码 | 缓存核心（前缀冻结 / 对齐 / 分级准入 / 判定逻辑）与 v0.4.4 一致，本版不动算法；默认档位下 `cf_judge` / `cf_inject` 返回**只有一段 JSON、不含卡片** |
| 冒烟验证 | MCP stdio 冒烟通过：`serverInfo.version = 0.4.7`、9 工具齐全、默认档位无卡片、`once` 仅首次附卡、`always` 每次附卡、`cf_report.cardMode` 与设置一致 |
| 测试 | **94 / 94 通过**；`tsc --noEmit` 零报错；`eslint src test` 零告警 |
| 平台验证 | **Windows 真机端到端已验证**；**Linux 已在 `linux/amd64` 容器内实测运行**（协议链路 / 9 工具 / 日志分支 / 只读降级 / Node 版本自检，见「平台支持状态」与 `release/兼容性说明.md`）；macOS 仅单元测试覆盖，**未真机运行** |
| **不宣称** | 本版**不是性能提升版**。命中率与 v0.4.4 相同，请勿把本文任何数字读成「新版本更高」 |

> 为什么会有 v0.4.3：v0.4.2 正式包里，`injectIncremental` 第 4 步 `topUpPrefixToMin(...)` 之后缺少 `prefix = topUp.prefix;`，导致补足结果没有接回、参数形同虚设。厂商 D 系默认门槛低（295），正常前缀本就够长，所以一直没暴露；厂商 G 系真实门槛 1806+，必须靠补足才能过线，一补不上立刻露馅——这就是回归用厂商 G 的原因。v0.4.3 补上了这一行。

## 四、实测数据（20 次连续请求对照）

本组实测：同一套 20 次递进式连续话题。请求端为「某常见编码 CLI 工具」接入（模型来自厂商 G），白盒引擎以 stdio MCP 挂载 DoboCache；同一台机器、同一模型、同一套参数，只区分"挂载 / 不挂载"。

> **先说两个读表约定**：① 「厂商 D」「厂商 G」是匿名代号，「某常见编码 CLI 工具」指某一商业化编码客户端，匿名是为了不把第三方产品的实测表现绑进本文；② 表中只报**命中率与相对比例**，不报任何金额，成本相关字段按 README §六 的计价系数折算相对值。

![对照组 vs 实验组 命中率对照](assets/hitrate-comparison.png)

| 指标 | 对照组（不挂载） | 实验组（挂载 DoboCache） |
|---|---|---|
| 20 次请求命中率均值 | **0.00%**（20/20 次全为 0） | **98.59%** |
| 区间 | — | **96.08% – 99.79%** |
| 零命中请求数 | 20 / 20 | **0 / 20** |
| 前缀就绪（`prefixReady=true`） | — | **20 / 20** |
| 实际生效门槛 `effectiveMinPrefixTokens` | — | **3450**（= 3000 × 1.15，配置已生效） |

关键读法，请连同三条一起看：

1. **对照组每次都注入了不同的随机噪音**制造前缀漂移，所以 20 次全 0——这不是"对照组很差"，而是"前缀一变，厂商前缀缓存就整段失效"的真实写照；
2. **实验组 20 次全部命中**，前缀 `prefixTokens` 稳定落在 3456–4480，每一次 `prefixReady` 均为 true；
3. **命中率是单次请求输入内部的缓存命中占比，不是绝对 token 节省量**。两组输入量本就不同（对照组输入随请求次数从 39 累积到 2738 tokens，实验组稳定在"前缀 + 尾部"），因此不可跨组直接换算成绝对 token 数，也不要在不同实验之间横向混比。

**把视角拉高一层：不挂载并不总是 0%。** 命中率不是只由"挂不挂"决定，请求端自己怎么构造请求，决定了对照组的起点。同一套挂载逻辑换到三种请求端形态各跑 20 次：

![三种请求端形态对照：不挂载 vs 挂载](assets/hitrate-comparison-platforms.png)

| 请求端形态 | 版本 · 实验来源 | 对照组（不挂载） | 实验组（挂载） | 说明 |
|---|---|---|---|---|
| A 白盒引擎直连 | v0.4.0 · 实验 031 | 0.00% | 93.09% | 请求端不提供任何原生前缀复用 |
| A 白盒引擎直连 | v0.4.2 · 实验 032 | 0.00% | 91.89% | 同上 |
| B 官方 Harness headless | v0.4.0 · 实验 033 | 66.00% | 96.85% | 请求端自带约 2,560 tokens 全局系统前缀缓存；对照组随噪音累积由 84.27% 劣化到 54.54% |
| B 官方 Harness headless | v0.4.2 · 实验 034 | 68.09% | 95.91% | 同批对照组基线同样来自厂商系统前缀缓存；实验组每轮未命中压至 135–426 tokens |
| C 常见编码 CLI（厂商 G） | v0.4.2 候选修复构建 · 组 7 | 9.87% | 90.58% | 对照组 18/20 次为 0，R10/R20 因长历史前缀自然命中 |
| C 常见编码 CLI（厂商 G） | v0.4.3 · 组 8 | 0.00% | 98.59% | 即上表本组主数据 |

三条读法：

1. **形态 B 的 66%–68% 不是 DoboCache 的功劳，也不是"提升幅度小"**——那是请求端自己就挂了全局系统前缀缓存，对照组天生占便宜；而它随噪音累积一路劣化（84.27% → 54.54%），恰恰说明这种请求端的缓存同样脆弱；
2. **三种形态的对照组起点从 0% 到 68%，差别全在请求端怎么构造请求，跨形态的对照值不可互比**；唯一可比的是同一形态内部的"挂 vs 不挂"；
3. **挂载后三种形态都落在 90%–98%**，说明"静态前缀复用"这件事与请求端形态无关，不是某一家请求端的特例。
4. **口径提醒（比数字本身更要紧）**：形态 A / B 是「20 次请求累计口径」（累计命中 tokens ÷ 累计 prompt tokens），形态 C 是「20 次逐次请求命中率的均值」——两种统计算法不同，跨形态只能看量级，不能拿百分比互相加减；同一形态内部的「挂 vs 不挂」才是同口径对比。

统一口径：**不挂载约 0%–68%（随请求端形态浮动），挂载后 90%–98%**。表中每一行都能落到实验档案的实测记录上（实验 031 / 032 / 033 / 034 与组 7 / 组 8），并与汇总 CSV 的 `source_exp` / `recompute_file` 字段一一对应：`release/testdata/hitrate-multi-platform-summary-20261105.csv`——形态 A / B 的分子分母以 token 列同表落盘，形态 C 为逐次均值、逐次数据在同目录，任一行都可自行复算。逐次曲线与重绘图脚本见 `release/scripts/hitrate-comparison.py`。本表不含任何估算值或取整凑数。

### 关于测试规模：一句实话

这套数据来自 8 组对照实验，正式组每组 20 次连续请求，另有两组 5 次、10 次的前期门槛探测。

但要先把边界讲清楚：**这些测试的单次请求体量都很小**——每轮输入是同一份 AI 资讯盘点话题，前缀几百到数千 tokens，任务原文与逐次 usage 都在 `release/testdata/`，谁都能自己算一遍。

**我们没有测「特别长的长任务」**：单轮上万 tokens 的长文档问答、整个代码库的分析、几十轮的超长会话，都不在样本里。缓存前缀复用在这种体量下是否一样成立，我们没测过，也不打算替它下结论。

如果你手上正好有这类长任务，欢迎自己挂上去跑一遍再回来说话——把逐次 usage 记下来，比我们的任何承诺都有用。这也正是我们把逐次数据、任务原文、复跑步骤全部放进包里的原因：**让你能自己验证，而不是只能信我们。**

## 五、白盒报告：每一步都看得见

每次 `cf_judge` / `cf_inject` 之后，白盒日志会记录这一步做了什么、为什么做、效果如何。下面是一条按当前口径（v0.4.7）输出的记录示例：

```json
{
  "requestId": "req-1b0ff98f",
  "ts": 1793709231484,
  "reqIndex": 2,
  "promptChars": 36,
  "rawTokens": 201,
  "optimizedTokens": 4096,
  "hitRate": null,
  "savedTokens": 0,
  "savedPct": 0,
  "changes": [
    {"kind": "align128", "label": "前缀 128-token 对齐：减少尾部部分命中", "detail": "追加 98 个对齐块"},
    {"kind": "topup",    "label": "前缀过门槛补充：达到最小有效缓存长度", "detail": "补充 63 块（高价值片段/文档块）"},
    {"kind": "scenario", "label": "首条请求或缓存为空：轻量约束放行自由回答"}
  ],
  "note": "cf_inject：原始 201 tokens → 优化后 4096 tokens（前缀 4096 + tail）；实际门槛 3450 tokens。",
  "sessionId": "sid-b6ca1662",
  "scenario": "first",
  "mode": "rebuild",
  "alignBlocks": 98,
  "prefixTokens": 4096
}
```

三类常用对照能力都在：**第几次请求**（`reqIndex`）、**是否同一提问**（`req-...` 相同即同一提问）、**每一步动了什么**（`changes[]` + `note`）。内容本身不落盘。

> 记录里 `hitRate` 为 `null` 表示**本次请求未判定**：`cf_inject` 处在注入阶段、请求尚未发出，且调用方没有把厂商返回的缓存 `usage` 回传给 DoboCache，本机就无法得知真实命中率——此时如实记 `null`（未判定），**不再写 0**。看到 `null` 不要读成"命中率 0%"：要得到可判定的命中率，请在 `cf_judge` / `cf_inject` 里带上 `hitTokens` / `missTokens`（取自厂商 `usage` 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）。累计统计用 `cf_report` 查看。详见 [`FAQ-使用须知.md`](release/FAQ-使用须知.md) 第一节。

### 白盒报告默认关闭（v0.4.6）

白盒报告卡片是**给你看的**，但它写进对话上下文就要**占 token**（每张约 300+ tokens，每次工具调用都可能带一张）。因此从 v0.4.6 起：

- **默认（`quiet`）**：报告只写本地日志，**不随工具返回**，不占对话 token；
- **想看累计数据**：随时调 `cf_report`，它读本机日志、**不产生额外 token**；
- **想看每次的详情**：设环境变量 `DOBOCACHE_WHITEBOX`：
  - `once` —— 下一次调用返回一次详情，之后自动回落 `quiet`（适合临时排查一次）；
  - `always` —— 每次调用都带详情（适合正在做对照实验，代价就是每张卡的 token）；
  - `quiet` —— 关闭（默认值，等价于不设）；
- **首次运行提示**：本机第一次跑时会给一条一次性提示（告诉你白盒在哪、怎么开），之后永不再出。

| 档位 | 是否随调用返回报告 | 占用对话 token | 适用 |
|---|---|:---:|---|
| `quiet`（默认） | 否，只写本地日志 | 无 | 日常使用 |
| `once` | 只返回一次，随后自动回落 `quiet` | 一次性 | 排查"到底有没有生效" |
| `always` | 每次都返回 | 每次约 300+ tokens | 做对照实验、需要逐次读数时 |

> 一句话：**平时不用管它；需要证据时用 `cf_report`（不花 token），需要看单次细节时再开 `once` / `always`。**

## 六、安装与挂载（三种启动写法）

1. 从 [Releases](https://github.com/dobo123123/dobocache/releases/latest) 下载 `dobocache-v0.4.7-portable.zip` 并解压（内含 `dist` 与**仅生产依赖**的 `node_modules`，无需 `npm install`；包内不含任何原生 `.node` 二进制，换机器换平台不会因 ABI 不匹配崩掉）；**不想下载也可以用下文写法 B / C 从 npm 装**；
2. 在你所用客户端的 MCP 配置里加一个 **stdio** server（下面三种写法任选其一）；
3. 重启客户端，确认工具列表里出现 **9 个**（`ping` + `cf_judge` / `cf_tier` / `cf_inject` / `cf_warmup` / `cf_report` / `cf_meter` / `cf_prune` / `cf_normalize`）。少任何一个都说明 server 没起来，先看客户端日志里的 stderr。

> **前置条件**：Node.js **18 或更高**。进程启动时会自检，版本过低会直接打印一句中文提示然后退出（不会静默失效）。
> **通用建议**：配置里的路径一律填**绝对路径**——客户端拉起 server 时不继承你 shell 的当前目录与 PATH，只写 `node` 或相对路径是最常见的翻车原因。

### 写法 A：绝对路径 `node` + 入口 js（推荐）

Windows：

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\<解压目录>\\dist\\index.js"]
    }
  }
}
```

macOS / Linux：

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/<你>/dobocache/dist/index.js"]
    }
  }
}
```

- **适用**：便携包解压即用、内网/离线机器、客户端以非登录用户或非常规工作目录拉起。
- **怎么找 node 路径**：Windows `where node`；macOS / Linux `which node`（Homebrew 常见 `/opt/homebrew/bin/node`、`/usr/local/bin/node`；用 nvm 的请填具体版本目录下的绝对路径）。
- 该写法不需要 `npm`、不联网，跨机器最稳。

### 写法 B：`npx -y` 一次性运行（⚠️ npm 目前尚未上架，现在请用写法 A）

> ⚠️ **npm 渠道尚未上架**：`dobocache` 目前未发布到 npm registry（`npm view dobocache` 返回 `404`）。写法 B / C 属预留写法，**上架前请一律用写法 A（便携包）**，否则安装必然失败。
>
> 关于仓库内的 `server.json`：它是**提交给 MCP Registry 的条目描述文件**，其中 `packages[].registryType` 只有 `npm` / `pypi` / `oci` 等固定取值（schema 不存在"便携包"这个类型），因此 `identifier` / `version` 指的是**上架 npm 之后**的发布目标，不代表 npm 上当前已有该包。本文件在 npm 实际上架后才提交给 Registry；在 npm 上架之前，一律以上面这条警示为准。

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "npx",
      "args": ["-y", "dobocache@0.4.7"]
    }
  }
}
```

- ⚠️ **Windows 上必须写 `npx.cmd`**（`"command": "npx.cmd"`）。npm 在 Windows 上只安装 `npx.cmd`，没有 `npx.exe`，客户端 `spawn("npx")` 会直接报 `ENOENT`——这是 MCP 客户端在 Windows 上最高频的报错。
- macOS / Linux 保持 `npx` 即可；若客户端用非登录 shell 拉起且 PATH 里没有 node，可写死绝对路径（如 `/usr/local/bin/npx`）。
- **适用**：希望自动跟随版本、机器可联网、不想手工解压。
- **前提**：该版本已发布到 npm；**未发布前请用写法 A**。另外 `npx` 有本地缓存，升级后行为仍是旧的时，执行 `npm cache clean --force` 或改用写法 C。

### 写法 C：全局安装后直接调命令

```bash
npm install -g dobocache@0.4.7
```

```json
{
  "mcpServers": {
    "dobocache": {
      "command": "dobocache"
    }
  }
}
```

- ⚠️ **Windows 上同样注意扩展名**：写 `"command": "dobocache.cmd"`；若客户端仍找不到命令，直接填全局安装目录下的绝对路径（`npm root -g` 显示的目录的上一级里的 `dobocache.cmd`）。
- **macOS / Linux 权限报错时**：`npm install -g dobocache@0.4.7 --prefix ~/.npm-global`，配置里填 `/Users/<你>/.npm-global/bin/dobocache` 绝对路径。
- **适用**：一台机器长期固定使用、不想每次下载。升级时重跑 `npm install -g dobocache@<新版本>` 并重启客户端。

三种写法对照：

| 写法 | 需要联网 | 需要 npm | 路径可控性 | 升级方式 | 适用场景 |
|---|:---:|:---:|---|---|---|
| A 绝对路径 node | 否 | 否 | 最高（自己写死） | 换包目录/改配置 | **推荐**：便携包、离线、内网 |
| B `npx -y` | 是 | 是 | 中（缓存位置由 npm 决定） | 改版本号或自动 | 试用、跟随升级 |
| C 全局安装 | 安装时是 | 是 | 中 | 重跑 install | 单机长期使用 |

> **要跑 `npm test` / `npm run lint`？** 便携包只带生产依赖，先在该包目录执行一次 `npm install` 补齐开发依赖（需要网络），再运行脚本。

**日志目录**（v0.4.4 起不再依赖进程"当前目录"，客户端用任意 cwd 拉起都能写对位置）：

| 平台 | 默认日志目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\DoboCache\logs`（例：`C:\Users\<你>\AppData\Local\DoboCache\logs`） |
| macOS | `~/Library/Logs/DoboCache` |
| Linux | `$XDG_STATE_HOME/dobocache`（未设置则为 `~/.local/state/dobocache`） |

优先级：环境变量 `DOBOCACHE_LOG_DIR` > 平台默认目录 > `<cwd>/data/logs`（回退）> 都不可写则不落盘、只在 stderr 提醒一句，进程继续运行。实际使用的目录可在 `cf_report` 返回的 `logDir` / `logFile` 里看到。

**日志不会无限长大**（默认即生效，不需要你配置）：

- 单个日志文件到 **10MB** 就滚动成 `.1`，最多保留 **3** 份副本（即单日最坏情况约 40MB 上限）；
- 超过 **7 天** 的旧日志会在当天首次写盘时被清理；
- 清理只认本模块自己的命名（`dobocache-YYYY-MM-DD.log.jsonl` 与其 `.1`/`.2`/`.3`），**同目录下你自己的文件一个都不会动**；
- 清理失败（权限、文件被占用等）一律静默跳过，不影响写日志，更不影响缓存主流程；
- 想放宽或收紧，用下面的 `DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS`；当前策略与实际维护结果可在 `cf_report` 返回的 `logPolicy` / `logMaintenance` 里看到。

目标厂商门槛明显高于默认值时（部分厂商需要 1806+），在 `cf_inject` 里指定 `minPrefixTokens`，例如 `minPrefixTokens=3000`；实际生效门槛为该值 × 1.15（安全余量）。

**全部环境变量**（都可省略，省略即用默认值）：

| 变量 | 作用 | 默认 | 说明 |
|---|---|---|---|
| `DOBOCACHE_LOG_DIR` | 白盒日志目录 | 平台标准目录（见上表） | **请填绝对路径**；填相对路径按 server 进程 cwd 解析，结果不可预期 |
| `DOBOCACHE_HIT_PRICE_PER_M` | 命中计价系数 | `0.014` | 用于 `cf_meter` / `cf_report` 的成本相对值换算，**必须 ≥ 0 的有限数字**；填错（如 `abc`、`-1`）会回退默认值并在 stderr 提示一句 |
| `DOBOCACHE_MISS_PRICE_PER_M` | 未命中计价系数 | `0.5` | 同上 |
| `DOBOCACHE_WHITEBOX` | 白盒报告卡片档位 | `quiet` | `quiet`（只写日志不出卡）/ `once`（出一次后自动回落）/ `always`（每次都出，约 300+ tokens/次）；填其它值会忽略并在 stderr 提示一句 |
| `DOBOCACHE_LOG_MAX_MB` | 单个日志文件上限（MB） | `10` | 超过即滚动为 `.1`，最多 3 份副本；必须是 1–1024 的整数，填错回退默认值并在 stderr 提示一句 |
| `DOBOCACHE_LOG_KEEP_DAYS` | 日志保留天数（含今天） | `7` | 超期日志在当天首次写盘时清理，只处理本模块命名的日志文件；必须是 1–365 的整数，填错回退默认值 |
| `CACHEFORGE_LOG_DIR` / `CACHEFORGE_HIT_PRICE_PER_M` / `CACHEFORGE_MISS_PRICE_PER_M` / `CACHEFORGE_WHITEBOX` | 旧名兼容别名 | — | 改名前的变量名仍可用；同名时 `DOBOCACHE_*` 优先 |

> **计价系数请自行改为你的实际合同系数**：随包默认值只用于「命中 vs 未命中」的**相对值对比**（例如 1:36 的差异），不是任何厂商的真实报价，`savedUsd` / `cumSavedUsd` 等字段名里的 `Usd` 只是历史命名，数值含义是"按当前计价系数折算的相对成本"。改系数后统计曲线整体等比缩放，命中率不受影响。

## 七、隐私：日志里没有你的提问原文

从 **v0.4.4** 起：

- `requestId` 只存 `req-<8 位 hash>`（固定盐 + 64bit 指纹），**同文恒同值，不可反推原文**；
- `sessionId` 只存 `sid-<8 位 hash>`；
- `cf_normalize` 的返回键只存 `nk-<16 位 hash>`；
- 新增 `round`（请求序号，v0.4.6 起日志字段更名为 `reqIndex`，含义是"本机第几次请求"，与对话阶段无关）与 `promptChars`（字符数）两个纯数字字段，保留"可对照"能力但不含内容；
- 落盘走字段白名单，后续即使新增字段携带正文，也不会写进日志；
- **日志只存本地，不上传任何服务器**；默认落在系统标准日志位置（Windows `%LOCALAPPDATA%\DoboCache\logs`，macOS `~/Library/Logs/DoboCache`，Linux `~/.local/state/dobocache`），该目录不随包分发。

前后对照（同一条记录）：

| 字段 | v0.4.3 及以前 | v0.4.4 |
|---|---|---|
| `requestId` | `请综述 2026 年 10 月 AI 领域的主要动态，按厂商和方向分类。::1793718183368` | `req-ec142df8` |
| `sessionId` | `sample-2026Q4-alpha` | `sid-8a0a11e6` |
| `reqIndex` / `promptChars` | 无 | `1` / `36` |
| 其余数值字段 | 原值 | **完全相同** |

> ⚠️ **历史日志仍需你自行清理**：v0.4.4 无法追溯修改旧版本已生成的文件。若你的机器上存在 v0.4.3 及以前产生的 `data/logs/*.jsonl`（旧版本默认写在"启动时的当前目录"下），其中 `requestId` 仍是提问原文，请按需删除或归档。

## 八、客户端兼容性

结论只写有官方文档或明确来源支撑的内容；证据不足的写"未确认"，不做推测。

| 客户端 | stdio MCP | 自定义 OpenAI 兼容 `base_url` | 是否强制私有协议 | 缓存 usage 字段可观测性 |
|---|:---:|:---:|---|---|
| Claude Desktop | ✅ 支持（JSON 配置） | 未确认（文档中无端点配置项） | 走厂商自有 API 协议 | 未确认 |
| Cursor | ✅ 支持（`.cursor/mcp.json`） | ❌ 不支持：只能填官方厂商 Key，**没有 `base_url` 字段** | 无强制，但实际只能用官方端点 | 未确认 |
| Cline | ✅ 支持 | ✅ 支持（Base URL + API Key + Model ID） | 否（`/v1/chat/completions`） | 未确认 |
| Continue | ✅ 支持（yaml / json） | ✅ 支持（`provider: openai` + `apiBase`） | 否 | 未确认 |
| Codex CLI | ✅ 支持（`~/.codex/config.toml`） | ✅ 支持（`[model_providers]` 的 `base_url` / `env_key` / `wire_api`） | 可选：`wire_api` 分 `chat` 与 `responses` | ✅ 遥测含 `cached_token_count`（仅 `responses`） |
| Gemini CLI | ✅ 支持 | 未确认（Gemini / Vertex 体系） | 是（Gemini 协议） | ✅ `/stats` 可看 cached tokens（限 API Key / Vertex） |
| Cherry Studio | ✅ 支持（界面添加 stdio/SSE/HTTP） | ✅ 支持（自定义服务商：密钥 + 端点） | 否（可选 OpenAI 兼容） | 未确认 |
| Trae | ✅ 支持（界面填 JSON 或项目级 `.trae/mcp.json`） | ✅ 支持（OpenAI Chat Completions + 自定义请求地址） | 否 | 未确认 |
| Windsurf | 未确认 | 未确认 | 未确认 | 未确认 |

怎么读这张表：

- **挂载（stdio MCP）**：上表 8 家中 7 家有官方文档明确写 stdio 配置；Windsurf 无法取证，暂不列入支持清单。
- **请求能否导向你的 OpenAI 兼容端点**：明确支持 5 家（Cline / Continue / Codex CLI / Cherry Studio / Trae）；**Cursor 不能自定义端点**；**Claude Desktop、Gemini CLI 的文档中未见兼容端点入口**。
- **缓存命中数据在哪看**：只有 2 家有文档级证据，且**都不是"客户端面板里直接显示缓存命中率"**——Codex CLI 是 OTel 遥测字段，Gemini CLI 是 `/stats`。因此本文**不宣称"客户端面板直接显示缓存命中率"**。准确表述是：**DoboCache 在服务端读取厂商 API 返回的 usage 缓存字段并记录、回传**；客户端侧可视化需逐个实测。

完整版（含每个客户端的配置文件路径、格式与 18 条来源链接、未确认清单）见 [`兼容性说明.md`](release/兼容性说明.md)。

## 九、如何复现

本文所有数字都放在 `release/testdata/` 里，可自行核对与重跑：

| 文件 | 用途 |
|---|---|
| `release/testdata/hitrate-regression-report-20261103.md` | 本组回归报告：设置、20 次逐次结果、判读标准逐条对照 |
| `release/testdata/hitrate-task-inventory-20261103.md` | 20 次请求任务原文、8 组实验参数、复跑说明 |
| `release/testdata/hitrate-testdata-20261103.csv` | 20 次逐次数据（`round,text_type,raw_tokens,opt_tokens,hit_rate,saved_tokens,platform`；`round` 为列名，语义即"第几次请求"） |
| `release/testdata/复跑说明.md` | 复跑步骤、验收标准、四个常见踩坑 |
| `release/scripts/hitrate-comparison.py` | 用上面三份 CSV 重跑两张对照图的脚本（`python release/scripts/hitrate-comparison.py`）：`hitrate-comparison.png`（同形态逐次曲线）+ `hitrate-comparison-platforms.png`（跨请求端形态汇总） |

最短复现路径：

1. 解压 v0.4.7 便携包，MCP 指向 `<解压目录>\dist\index.js`；
2. 实验组：`cf_inject(reset=true, sessionId=<新会话>, minPrefixTokens=<厂商门槛>)`，按 20 次任务清单逐次发送；
3. 对照组：同样任务文本，但**每次头部注入不同随机噪音**（这是关键，见下）；
4. 每次取**第二遍**请求的厂商 usage（第一遍建缓存，第二遍才是命中读数）；
5. 验收：日志 `prefixReady=true`、`effectiveMinPrefixTokens = 配置门槛 × 1.15`；实验组命中率应稳定在 90% 以上，对照组以 0 为主。

> ⚠️ **复跑必读**：对照组若不给每次前缀注入随机噪音，厂商的自动前缀缓存会让对照组**也命中**，对照就失去意义。这是本套实验最容易做错的一步。

## 十、已知限制与不承诺项

装在机器上之前，请先把这一节读完。以下每一条都是**能力边界**，不是待办事项。

**1. 命中前提是前缀逐字节稳定，本工具无法替你保证**

缓存命中取决于请求前缀（系统提示、工具列表、历史消息顺序、头部字段）是否与上一次完全一致。只要客户端在头部注入时间戳、随机 ID、动态工具集，或历史消息顺序变化，命中就会下降。`cf_inject` 只能把可控部分整理成稳定形态，**不能阻止客户端改动前缀**，也无法在客户端已经改动后强行命中。

**2. 服务商必须支持前缀缓存并已开启**

各家对"最小可缓存前缀长度"有各自门槛（本项目实测口径取"配置门槛 × 1.15"作为有效门槛）。若所用端点不支持前缀缓存、或账号侧未开启，命中率就是 0，**本工具不修改服务商行为，也无法在不支持的服务商上凭空产生命中**。

**3. 只读服务商已经回传的 usage 字段，不做推算**

命中相关数字来自厂商 API 返回的 usage 缓存字段。**客户端或服务商不回传该字段时，报告里就没有这个数**——本项目选择显示"未判定"而不是用字符数估算一个好看的数字。

**4. `savedUsd` / `cumSavedUsd` 是相对值，不是账单**

随包默认计价系数只用于"命中 vs 未命中"的相对对比，不是任何厂商的真实报价，字段名里的 `Usd` 只是历史命名。真实金额请换成你自己的合同系数后自行折算，命中率不受系数影响。

**5. 不做语义缓存，不跨会话复用内容**

本工具不代理、不转发、不存储你的提问正文，也不做相似度/语义层面的复用。相同问题换个说法不会被"当成命中"。

**6. 传输形态仅 stdio MCP**

当前包只提供 stdio 挂载。HTTP / SSE 形态未提供；客户端兼容性表中标"未确认"的项（含 Windsurf）没有官方文档取证，**不列入支持清单，也不做效果承诺**。

**7. 实测规模有限，不是基准测试**

第四节数据为 20 次连续请求的对照实验（同形态 + 跨 4 种请求形态），可复现，但**不等于你所在场景的预期表现**。样本量说明见「关于测试规模：一句实话」。

**8. 明确不承诺的事项**

不做以下任何承诺：特定命中率数值、特定节省比例或金额、在任意服务商/客户端组合上的效果、与其他缓存方案对比的优势幅度、以及上线后的业务收益。能否命中取决于你的请求形态与服务商策略，**本工具提供的是可控的稳定前缀、准入判断和可核对的测量，不是效果担保**。

**9. 升级或换客户端后需要重新观察**

更换客户端、升级版本、修改系统提示或工具列表后，此前建立的缓存前缀即失效，需重新按第九节方式观察。**旧版本产生的历史日志不会被自动改写或删除**，需自行清理。

## 十一、常见问题

`hitRate` 是 `null` 是不是没生效？第一次请求为什么没命中？日志在哪、怎么读？换机器后要不要清日志？——见 [`FAQ-使用须知.md`](release/FAQ-使用须知.md)。

---

## 口径声明

本 README 及其同批文档遵循同一份对外口径约定：

1. **宿主匿名**：被测宿主统一称"某常见编码 CLI 工具"，不出现具体产品名；
2. **不报金额**：只报命中率与相对比例，不含任何费用数字；
3. **不宣称提升**：v0.4.7 是"日志有边界 + 统计可回溯"版本，缓存核心与 v0.4.4 一致，对外表述为"命中行为与 v0.4.4 一致"，不写"更高/更快/更强"；
4. **不混比**：不同实验、不同接入方式、不同厂商的数字不横向混比。


---


---

## 许可证

DoboCache 采用 **Apache License 2.0** 发布，全文见仓库根目录的 [LICENSE](LICENSE)，标准文本也可在 <https://www.apache.org/licenses/LICENSE-2.0> 查阅。

这意味着：

- **允许商用**。你可以在公司内部、商业产品或对外服务中使用、修改、再分发 DoboCache，无需付费、无需授权申请、无需向我们报备。
- **允许闭源衍生物**。你可以把它集成进闭源产品，但需保留版权与许可声明，并对你修改过的文件保留变更说明。
- **提供专利许可**。Apache-2.0 第 3 条包含对贡献者的明示专利授权，对使用者更友好。
- **无担保**。软件按"现状"提供，不附带任何明示或默示担保；使用风险由你自行承担。
- **保留商标与名称**。许可证**不授予** "DoboCache" 名称、项目名及相关标识的使用权（见 Apache-2.0 第 6 条）。你可以基于本项目做二次开发与分发，但请勿让用户误以为你的分支、服务或产品就是 DoboCache 官方版本，或声称获得我们的背书。注明"基于 DoboCache"是允许且受欢迎的。

## 关于收费

DoboCache 是免费的开源项目，**没有付费版本、没有订阅、没有商业授权门槛，也没有任何形式的收费计划**。

如果你有**商业合作、定制开发或企业级支持**的需求，欢迎通过仓库 Issues 联系作者洽谈；这类合作是独立服务，不会改变你在 Apache-2.0 下已经获得的任何权利。

## 第三方组件

本项目依赖若干第三方开源包，其许可证与声明保留在各自的包目录中（例如 `node_modules/<package>/LICENSE`）。这些许可证**不受**本项目 Apache-2.0 协议的替换或覆盖，再分发时请一并保留。

---

### 版权与声明文件

- `LICENSE`：Apache License 2.0 标准全文（未做任何修改）
- `NOTICE`：项目名称、版权年与商标声明（Apache-2.0 第 4(d) 条要求随分发保留）

**关于衍生版本的命名**：Apache-2.0 **不授予商标使用权**，因此任何基于本项目的分支或二次开发，**不得使用「DoboCache」作为其产品名或服务名**，也不得暗示获得官方背书。注明「基于 DoboCache」是允许且欢迎的。

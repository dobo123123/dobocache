# DoboCache Changelog

## v0.4.7（2026-11-05）— 白盒日志有了边界、`cf_report` 可跨重启读盘聚合、`cf_prune` 口径说清

> 目标：v0.4.6 把「报告输出方式」修好了，但日志本身还有三处没兜住——一是文件只增不减，长期挂载会无声吃掉磁盘；二是统计只在进程内存里，MCP 客户端一重启就归零，用户看到 0 会误判白盒没工作；三是 `cf_prune` 名字听起来像清理日志，实际只修剪传入的文本。本版补这三处。**缓存核心算法未改动**（前缀冻结、对齐、分级准入、判定逻辑与 v0.4.4 一致）。

### 日志有了边界（自动维护，无需配置）
1. 新增 `WhiteboxLogger.runLogMaintenance()`：单文件达上限即滚动为 `.1`，最多保留 3 份副本（默认单文件 10MB，`DOBOCACHE_LOG_MAX_MB` 可调，取值 1–1024）。
2. 超过保留天数（默认 7 天，`DOBOCACHE_LOG_KEEP_DAYS` 可调，取值 1–365）的日志在当天首次写盘时清理；过期清理每天最多扫一次目录（门闩机制），避免频繁 IO。
3. 维护**只处理本模块命名**的 `dobocache-YYYY-MM-DD.log.jsonl[.N]`，同目录下其它文件一律不碰；任何失败（权限、占用等）都吞掉并记入 `errors`，不影响写日志与缓存主流程。
4. `cf_report` 新增 `logPolicy` / `logMaintenance` 字段，可直接自查当前生效策略与实际维护结果，便于估算磁盘占用。
5. 两个新环境变量填错（非整数或越界）时回退默认值，并在 stderr 提示一句，不中断运行。

### `cf_report` 支持读盘聚合（跨进程、跨天）
6. 新增 `aggregateFromDisk()`，`cf_report` 增加 `source` 参数：`source="disk"` 时改为从本地日志文件重新聚合，进程重启后历史数据不再归零。
7. 新增 `days` 参数：`source="disk"` 时限定回溯的自然日数，默认等于日志保留天数（通常 7 天）。
8. 口径与内存态**严格一致，不新造指标**：`hitRate` 只对 `hitRate !== null` 的行求均值；一行都无法判定时仍返回 `null`，不伪造 0%。
9. 坏行计入 `skippedLines` 而不中断聚合；纯本地只读，不联网、不上报。

### `cf_prune` 口径澄清（行为未改）
10. `cf_prune` 本就是确定的纯函数，未参与日志清理。本版只把描述写清：它**仅修剪调用时传入的 `text`**，不读取、不删除磁盘上任何文件，尤其不会删白盒日志；日志体积由服务端自动维护，无需该工具介入。

### 文档与工程
11. 主 README / `release/README.zh.md` / `release/README.en.md` 三处同步：工具表补 `cf_report` 的 `source` / `days` 说明，环境变量表补两行新变量，日志章节新增「日志不会无限长大」四条。
12. FAQ 旧口径「旧日志自己清」改为「自动维护」。
13. 新增仓库健康文件：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、Issue / PR 模板、`dependabot.yml`；`ci.yml` 非阻塞补丁。
14. 补齐答疑材料（对外零支持负担导向）：FAQ 置顶新增「安装报错速查」13 条，按报错原文索引，覆盖 node 缺失、`spawn ENOENT`、`Cannot find module`、配置被忽略、假重启、权限、中文路径、PowerShell 执行策略、杀软拦截、`npm` 未上架、Node 版本过低、伪故障、卸载；FAQ 末尾新增「提问与求助」（三步自查 + 四项必备信息 + 问题分流）。
15. 新增 `release/零基础三分钟上手.md`：六步安装 + 第 7 步「装成没成」对照表，用真实自检输出替代界面截图作为成功参照。
16. 三份 README 顶部补官方入口声明（仅一处官方源）与新手入口；明确标注 npm 尚未上架；商标条款补「衍生版本不得以 DoboCache 命名」，并留商业合作入口（Apache-2.0 不变）。
17. `check-docs` 新增第 9/10 条校验：官方声明与新手入口不得被删、FAQ 速查章不少于 10 条、README 出现 `npx` 必须带未上架限定；`release/零基础三分钟上手.md` 纳入受检清单。
18. 清除三处示例配置里的本机绝对路径；`package-lock.json` 同步 SDK 版本范围。
19. `check-docs` 新增第 8 条校验：对外文档不得夹带非内容性元数据标签（编号、追踪标识、校验串一类）；发布包自检脚本加入同一规则，避免复制粘贴时被整段带入。
20. `package.json` 的 `files` 白名单补齐 `scripts/ci-mcp-smoke.mjs`：此前便携包含该冒烟脚本、npm 包内缺失，从 registry 安装的用户拿不到自检手段。
21. 统一术语与命名口径：全仓表述中性化，实验材料使用语义化文件名与记录编号；打包自检脚本同步扩展扫描规则，避免同类命名回流。
22. 随附对照图升级为多形态：新增跨请求端形态汇总 CSV `release/testdata/hitrate-multi-platform-summary-20261105.csv` 与组 7 逐次数据 `release/testdata/hitrate-testdata-glm-v042-20261103.csv`（含对照组逐次值）；`release/scripts/hitrate-comparison.py` 改为输出两张图——`hitrate-comparison.png`（同形态两版本逐次曲线，含两条对照组）与 `hitrate-comparison-platforms.png`（白盒直连 / 官方 Harness headless / 编码 CLI 三种形态汇总）；三份 README、两版社区帖、回归报告与 testdata 说明同步补入「不挂载并不总是 0%（约 0%–68%，随请求端形态浮动），挂载后 90%–98%」的实测表格，并明确跨形态对照值不可互比。

### 验收
23. 单元测试 **95 / 95 通过**（89 → 95，新增 6 条：轮转与副本上限、保留期清理与「非本模块文件不动」、清理门闩与 `force`、读盘聚合（跨文件 / 已判定口径 / 坏行）、空目录不伪造 0%、报告署名行位置与版本一致）。
24. `tsc --noEmit` 零报错；`eslint src test` 零告警；`check-docs` 8 份文档 0 ERROR / 0 WARN（十项校验）。
25. MCP stdio 冒烟通过：`serverInfo.version = 0.4.7`、9 工具齐全、默认档位 `cf_judge` / `cf_inject` 返回只有一段 JSON 不含卡、`once` 仅首次附卡、`always` 每次附卡。
26. 发布物复核：便携包与 npm tarball 各自独立全量扫描（凭据形态、本机路径、敏感用语、生成工具元数据、业务线索、地理与公司信息、会话标识）零命中；npm tarball 内 `scripts/check-docs.mjs` 与 `scripts/ci-mcp-smoke.mjs` 均存在。
27. 发布物复核（补充）：对照图两张与新增两份 CSV 随包齐备，三份 README 引用的图片路径均存在（`assets/hitrate-comparison-platforms.png`、`release/hitrate-comparison-platforms.png`）；逐次数据可重绘复现，跨形态汇总值与实验档案一致。

### 白盒报告署名（同版本追加）
- 报告卡片（`formatReportCard`）末尾固定追加一行：`DoboCache v0.4.7 · 全本地生成 · github.com/dobo123123/dobocache`，让用户把报告贴到群里 / 贴进 issue 时出处与仓库地址跟着走。
- 版本号由 `package.json` 用 `createRequire` 动态读取，升级版本无需再改代码；读取失败（非常规安装形态）静默回退常量，不抛错、不影响出卡。
- 边界：只在对话里多一行（约 15 tokens/张，且卡片默认 `quiet` 不出），**不写入 JSONL 日志**、不联网、不上报，统计口径与缓存行为零变化；`cf_report` 返回结构未改。
- 单测新增 1 条回归（署名固定在最后一行、与其上一条分隔线相邻、版本与 `package.json` 一致）。

## v0.4.6（2026-11-04）— 白盒报告改为默认关闭、命中率「未判定」语义修正、序号字段更名

> 目标：白盒报告此前会随每次工具返回附带一张约 300 tokens 的卡片写入对话上下文，长期使用会白白推高成本；同时日志里的命中率字段在「未拿到厂商 usage」时会写成 0，容易被人读成「命中率 0%」。本版把这两处都改成了如实表达。**缓存核心算法未改动**（前缀冻结、对齐、分级准入、判定逻辑与 v0.4.4 一致）。

### 白盒报告档位（默认关闭）
1. 新增环境变量 `DOBOCACHE_WHITEBOX`，三档：`quiet`（默认）不在工具返回里加任何卡片、只写本地日志；`once` 下一次调用附一张卡随后自动回落 `quiet`；`always` 每次都附卡。
2. 卡片本身要占对话 token，因此默认档位为 `quiet`；累计数据随时可用 `cf_report` 查看，不产生额外 token。
3. 本机首次运行会出一次「引入提示」卡片，说明卡片可关、怎么开、怎么查累计，之后不再重复（标记文件 `.welcomed` 落在日志目录内，随日志同存亡）。
4. `cf_report` 返回新增 `cardMode` 字段，便于自查当前档位；环境变量取到无法识别的值时回落 `quiet` 并在 `cf_report` 的 `logWarnings` 里给出提示。

### 命中率「未判定」语义
5. 日志字段 `hitRate` 在该次请求没有可判定的厂商 usage 数据时写 `null`（此前写 0），避免把「没数据」误读成「命中率 0%」。
6. `cf_report` 的 `hitRate` 与新增的 `judgedCalls` 同步该语义：`judgedCalls` 为 0 时 `hitRate` 为 `null`；只有确实拿到 usage 的请求才计入命中率均值。

### 字段与文案
7. 日志字段 `round` 更名为 `reqIndex`，含义为「本进程内第几次请求」的自增序号；此前的名字容易被读成「对话轮次」，实际二者无关。`cf_judge` 返回 `matched[]` 内的同名字段一并更名。
8. 全部文档中「轮」相关表述统一为「次请求」，避免歧义。

### 日志兼容与读取端注意
9. **不新增日志文件格式**，只改字段名与取空值语义：`round` → `reqIndex`（读取端若仍按 `round` 取值会拿到 `undefined`）；`hitRate` 由 `0` 改为 `null`，读取端请按「`null` = 未判定」处理，**不要再把 0 当基线**。历史日志文件无需迁移，旧记录里仍是 `round` + `hitRate:0`。

### 文档一致性（同批修正）
10. 三份 README（根 / `release/README.zh.md` / `release/README.en.md`）的版本说明表、安装命令与便携包名统一为 v0.4.6（此前仍是 v0.4.4，属对外死穴）；FAQ 移除不存在的「v0.4.5」引用；`兼容性说明.md` 冒烟期望版本改为 `0.4.6`；证据图脚本注释口径同步为「次请求」。

### 验收
11. 单元测试 **89/89 通过**；`tsc --noEmit` 零报错；`eslint src test` 零告警。
12. MCP stdio 冒烟通过：`serverInfo.version = 0.4.6`、9 工具齐全、默认档位下 `cf_judge` / `cf_inject` 返回**只有一段 JSON、不含卡片**、`DOBOCACHE_WHITEBOX=once` 时仅首次附卡、`always` 时每次附卡、`cf_report.cardMode` 与设置一致。

## v0.4.4 修订 r6（2026-11-04）— 便携包文档补全与公开材料整理（核心代码零改动）

> 目标：让「只下载了便携包的人」不必回仓库也能读到完整说明与证据。`dist/` 与 r5 包**逐文件 SHA256 相同**，`src/` 未改动。

### 便携包
1. 包内 `release/`（此前为空目录）补齐为完整文档集：`README.zh.md` / `README.en.md` / `FAQ-使用须知.md` / `兼容性说明.md` / `hitrate-comparison.png` / `testdata/` / `scripts/`。
2. 包内根 `README.md` 同步为对外版本（此前为开发版且带 AIGC 水印）；新增 `assets/hitrate-comparison.png`，首页对照图开箱即可显示。
3. 包内 `package.json` 的 `files` 白名单与实际内容对齐：补 `assets/`、`release/testdata/`、`release/scripts/`、`release/hitrate-comparison.png`。
4. 发行包文件名 `dobocache-v0.4.4-portable.zip`，解压后为同名顶层目录；文件指纹随 Release 页面与发布记录公布（不写死在仓库文档里，避免文档与包互为循环依赖）。

### 元数据与文档修正
5. `server.json` 中 `DOBOCACHE_LOG_DIR` 描述由过时的 `<cwd>/data/logs` 更正为 v0.4.4 实际的平台目录（Windows `%LOCALAPPDATA%\DoboCache\logs` / macOS `~/Library/Logs/DoboCache` / Linux `$XDG_STATE_HOME/dobocache`）。
6. 移除 `release/兼容性说明.md` 的 AIGC front matter（`SECURITY.md` 同类水印此前已清除）。
7. `release/README.zh.md` / `README.en.md` 的 `LICENSE` 相对链接修正为 `../LICENSE`——两文件位于 `release/` 子目录，原链接在仓库与包内均为死链。
8. 仓库只保留发布所需文件。

### 验收
9. 单元测试 **79/79 通过**；`tsc --noEmit` 零报错。
10. 便携包解压后跑 CI 冒烟：MCP stdio 握手成功、`serverInfo.version = 0.4.4`、9 工具齐全（`ping` + 8 个 `cf_*`）、`cf_report.logDirSource = platform`、日志真实落盘，全部通过。

## v0.4.4 修订 r4（2026-11-04）— 协议切换 Apache-2.0 / 发布元数据（核心代码零改动）

> 目标：把项目协议从 MIT 切到 **Apache License 2.0**（含明示专利授权、商标保留与 NOTICE 声明），并补齐 MCP 发布所需元数据与仓库前置。**改动只落在协议文件、发布元数据与文档**；`src/` 与 `dist/` 的核心缓存逻辑未改动。

### 协议
1. `package.json` 的 `license` 字段由 `MIT` 改为 `Apache-2.0`。
2. `LICENSE` 全文替换为 Apache License 2.0 标准文本（未做任何修改，MD5 `86D3F3A95C324C9479BD8986968F4327`）；新增 `NOTICE`（项目名称、版权年、商标声明），按 Apache-2.0 第 4(d) 条随分发保留。
3. 新增 `SECURITY.md`：漏洞报告渠道、支持版本范围、披露流程。
4. `README.md`（根 / `release/README.zh.md` / `release/README.en.md`）新增「许可证 / License」「关于收费」「第三方组件」「版权与声明文件」四段；明确 Apache-2.0 第 6 条不授予 "DoboCache" 名称与标识使用权。
5. 旧 `LICENSE`（MIT）已备份于仓库内，便于追溯历史协议。

### 发布元数据
6. `package.json` 新增 `keywords`（`mcp-server` 等）、`publishConfig.access=public`；`files` 白名单扩为 `dist` / `src` / `README` / `CHANGELOG` / `LICENSE` / `NOTICE` / `SECURITY.md` / `server.json` / `release`。
7. 新增 `server.json`（MCP registry 描述文件）。**`mcpName` 与 `repository` 待公开仓库地址确定后补齐**——硬约束：`mcpName` 必须早于首次 `npm publish` 写入，发布后无法补。
8. 仓库建立 git 版本库（供 GitHub Actions 读取 `.github/workflows/ci.yml` 并触发三平台 CI），`.gitignore` 增补 `*.zip` / `archive/**` / `data/**`，避免把发布包与本地日志误提交。

### 文档
9. `README`（zh/en）工具章节标题由「八个可调用的工具」改为「九个可调用的工具（8 个业务工具 + 1 个 `ping` 健康检查）」，与 `tools/list` 实测一致。
10. 清理 `README` 中混入的编辑批注类文字（"若原文写的是 MIT，请整段替换"一类不应出现在对外文档里）。

> 协议口径按包区分：本版及之后的发行包为 Apache-2.0；更早的包（含 r3 及 r4 之前的构建）包内仍为 MIT 全文，以包内 `LICENSE` 为准。

## v0.4.4 修订 r3（2026-11-04）— 平台状态披露 / 参数校验 / MCP 注解（核心算法零改动）

> 目标：把"三平台支持程度"如实写进对外文档，并按新用户、开源评审、安全审计、MCP 规范四个视角补上可用性与规范性缺口。**改动只落在文档、错误提示、启动自检、日志、参数校验五类**；`injectIncremental`、prefix 构造/对齐/过门槛、命中率统计逻辑一行未动，核心文件改动前后 SHA256 完全一致（比对记录见发布随附文档）。

### 平台状态披露（文档）
1. `release/README.zh.md` / `README.en.md` 文首新增「平台支持状态」章节：Windows 10/11 为主打平台、**已真机端到端验证**；Linux（x64/arm64）与 macOS（Intel/Apple Silicon）**仅单元测试覆盖、从未真机运行**，明确写"未验证"而非"支持"，不引用任何成功率数字。
2. 同章节给出 Linux / macOS 反馈渠道与信息清单（GitHub Issues 标题前缀 `[platform: ...]`、`node -v` / `uname -a` / `sw_vers`、`cf_report` 的 `logDir` + `logDirSource`、报错原文；提示不要粘贴提问原文）。
3. `release/FAQ-使用须知.md` 新增 §零「支持哪些操作系统？Windows 之外能用吗？」（原 12 问 → 13 问），内容与 README 一致并附自助排查指路。
4. `release/兼容性说明.md` 新增 §零「操作系统平台支持状态（与客户端矩阵正交）」，说明"客户端兼容"≠"平台已验证"。

### 文档准确性（文档）
5. `README`（zh/en）工具清单由 4~5 个补全为 **8 个业务工具**（补 `cf_tier` / `cf_warmup` / `cf_prune`）+ `ping` 健康检查，新增「是否写盘」列；安装步骤改为"确认 9 个工具出现"。
6. 版本说明表测试数由 `68/68` 更正为 **`79/79`**（64 原有 + 4 隐私 + 11 跨平台），并新增「平台验证」行。
7. `README.en.md` §5 不再声称示例记录"逐字来自日志"——如实标注字段名/数值逐字一致、`label` / `note` 为可读性翻译，未翻译原文见 `README.zh.md` §5。
8. `README`（zh/en）新增「全部环境变量」表：`DOBOCACHE_LOG_DIR`、`DOBOCACHE_HIT_PRICE_PER_M`、`DOBOCACHE_MISS_PRICE_PER_M` 及 `CACHEFORGE_*` 旧名别名，说明默认计价系数仅为相对值占位、`savedUsd` 为历史字段名、`DOBOCACHE_LOG_DIR` 应填绝对路径。
9. 根 `README.md` 客户端配置示例由占位符 `"command": "node"` 改为真实绝对路径写法，并加一行说明（只写 `node` 是常见翻车点）。
10. `FAQ` 速记行同步为平台标准日志目录；§三补充"`DOBOCACHE_LOG_DIR` 请填绝对路径"。

### 参数校验（协议层）
11. `src/adapters/mcpTools.ts` 全部数值入参补上下界与整数约束，越界不再静默接受，统一返回 MCP 标准 `-32602` 校验错误并指明字段：
    - `cf_judge`：`query` 非空（`.min(1)`）、`threshold ≥ 0`、`topK ≥ 1` 整数、`now` / `hitTokens` / `missTokens` 为非负整数；
    - `cf_tier`：`totalChars` / `reservedChars` / `now` 非负整数，并在字段说明里点明 `reservedChars > totalChars` 会导致"全部片段被丢弃"；
    - `cf_inject`：`maxTokens ≥ 1` 整数、`minPrefixTokens ≥ 0` 整数、`minPrefixSafetyFactor ≥ 1`（< 1 会让门槛低于厂商最小值）、`hitTokens` / `missTokens` 非负整数；
    - `cf_prune`：`maxChars` / `maxLines` ≥ 1 整数；`cf_warmup`：`minPrefixTokens ≥ 0` 整数；
    - 条目/片段 schema 的 `timestamp`、`hitCount` 改为非负整数。

### MCP 规范符合性
12. 9 个工具全部补 `annotations`（`title` + `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`）：只读计算类（`cf_tier` / `cf_warmup` / `cf_prune` / `cf_normalize` / `ping`）标 `readOnlyHint: true`；会写本地日志或冻结/清空会话状态的（`cf_judge` / `cf_inject` / `cf_report` / `cf_meter`）标 `readOnlyHint: false`，`destructiveHint` 一律 `false`，`openWorldHint` 一律 `false`（纯本地）。
13. `McpServer` 增加 `instructions`（MCP `initialize` 返回的服务级说明）：典型调用顺序、日志边界、不发起网络请求、平台验证状态。

### 启动自检（错误提示）
14. `src/index.ts` 计价系数环境变量改为 `resolvePriceEnv()` 解析：`abc` / `-1` / 空串等非法值回退默认值并输出一句 stderr 提示，避免 `cf_meter` / `cf_report` 的比例字段静默变成 `NaN`。

### 验证
15. 核心算法齐备性：`src/core/` 6 个核心文件（`hitJudge` / `valueTier` / `memoryInject` / `serialize` / `prune` / `meter`）改动前后 SHA256 **逐一相同**；`src/` 全量 12 个 `.ts` 文件中仅 `adapters/mcpTools.ts` 与 `index.ts` 有改动（即本轮允许的校验/注解/提示范围）。
16. 命中行为逐字节回归：固定时间戳的 MCP 端到端快照（`cf_judge` / `cf_inject` 双轮 / `cf_tier` / `cf_prune` / `cf_normalize` / `cf_report`，共 7 项）改动前后输出**完全一致**（`prefixHash` / `reusedPrefix` / `frozenHitRatio` / 命中率与 token 统计均不变；`cf_report` 仅因两次运行设置的日志目录不同而 `logDir` 字符串不同，统计字段一致）。
17. `npm run test` → **79/79 通过**；`npm run build` 通过；`eslint src test` → **0 error**。

## v0.4.4 修订 r2（2026-11-04）— 跨机器可跑改造（日志目录 / 启动自检 / 打包依赖 / 启动写法）

> 目标：把"只在开发机跑得起来"的隐性依赖全部消除——日志不再依赖进程当前目录、启动先自检 Node 版本、发布包只带生产依赖、文档给出三种启动写法。**命中判定、前缀构造、分级准入逻辑零改动**，命中行为与 v0.4.4 r1 一致。

### 日志目录：不再依赖 cwd
1. 新增 `src/utils/logDir.ts`（`resolveLogDir()` / `platformLogDir()`），优先级：`DOBOCACHE_LOG_DIR` 环境变量 > 平台标准可写目录 > `<cwd>/data/logs`（旧行为兼容回退）> 全部不可写则不落盘。
2. 平台目录：Windows `%LOCALAPPDATA%\DoboCache\logs`；macOS `~/Library/Logs/DoboCache`；Linux `$XDG_STATE_HOME/dobocache`（未设置则 `~/.local/state/dobocache`）。
3. 全过程用 `path.join` 拼路径，不硬编码分隔符、不硬编码盘符；`mkdir` 失败只记录降级原因，**不抛错、不退出进程**。
4. `whitebox.ts` 构造函数由 `path.join(process.cwd(), "data", "logs")` 改为调用 `resolveLogDir()`；显式传入目录仍优先。新增只读属性 `logDirSource`（`env` / `platform` / `cwd` / `disabled`）与 `logWarnings`，供启动时打到 stderr。
5. 写盘失败处理：首次失败在 stderr 提示一句（含错误码与实际目录）并自动停写，此后不再刷屏；缓存与报告逻辑不受影响，进程继续运行。
6. `index.ts` 启动时把 `logWarnings` 输出到 stderr；未设置环境变量即使用平台目录。

### 启动自检
7. 新增 `src/utils/runtime.ts`（`checkNodeVersion()` / `parseNodeMajor()` / `MIN_NODE_MAJOR = 18`）：Node 主版本 < 18 时输出一句面向非技术用户的中文提示（附英文第二行）并 `exit(1)`，不静默失效；日志目录不可写只告警、不退出。
8. `index.ts` 启动首步执行自检，通过后才注册 MCP 工具。

### 打包与分发
9. `package.json` 补 `engines.node: ">=18.0.0"`、`files` 白名单（`dist` / `README.md` / `CHANGELOG.md` / `LICENSE`）、`bin.dobocache`；现有 `scripts` 与依赖版本未改动。
10. 便携包改为**只内置生产依赖**：`node_modules` 仅含 `@modelcontextprotocol/sdk`（纯 JS），剔除全部 devDependencies 与 `@rollup/rollup-win32-x64-*` 两个 Windows 专用原生 `.node` 二进制；包内 `.node` 文件数 **0**，换平台不会因 ABI 不匹配崩。
11. 新增 `LICENSE`（MIT）。

### 措辞
12. 全仓计费措辞统一改为「计价系数」，`cf_warmup` 返回的 `costHint` 由"未命中价 / 命中价回本"改为"按未命中 / 命中计价系数计费"；对外文案不出现任何具体金额数字。

### 文档
13. `release/README.zh.md` / `README.en.md` §六 重写为「三种启动写法」：A 绝对路径 `node` + 入口 js（推荐）、B `npx -y`（**Windows 须写 `npx.cmd`**，否则 `spawn ENOENT`）、C 全局安装后直接调命令；附三写法对照表、Node ≥18 前置条件、日志目录表、`npm test` / `lint` 需先 `npm install` 的说明。
14. `release/FAQ-使用须知.md` §三 / §四 同步新日志路径、优先级与读取命令；`release/README.zh/en`、根 `README.md` 中 `data/logs` 表述同步更新。
15. 关于日志路径的旧表述统一改为"v0.4.4 起不再依赖当前目录"。

### 验证
16. 新增 11 条单元测试覆盖跨平台逻辑（Node 版本解析/人话提示、三平台日志目录、环境变量优先、`enabled=false` 零副作用、目录不可写降级不抛错），合计 **79/79** 通过；`npm run build` 通过；`eslint src test` **0 error**；MCP stdio 冒烟（`tools/list` + 实际调用）正常，日志落在 `%LOCALAPPDATA%\DoboCache\logs`。

## v0.4.4（2026-11-03）— 白盒日志隐私脱敏（命中行为与 v0.4.3 一致）

> v0.4.3 及以前，白盒日志（旧版写在 `<当前目录>/data/logs/dobocache-<日期>.log.jsonl`）的 `requestId` 字段是用 `stableKey([prompt, 时间戳])` 拼接而成，**实际落盘的是用户提问原文**（例如「请综述 2026 年 10 月 AI 领域的主要动态，按厂商和方向分类。」）。本地日志一旦被收集/分享/随包分发，等于把用户的对话内容带走。v0.4.4 只做隐私脱敏，**不改动任何命中判定、前缀构造、分级准入逻辑**，命中结果与 v0.4.3 逐字节一致。

### 脱敏
1. **`requestId` 改为无内容语义的可追溯标识**：新增 `src/utils/privacy.ts`，`fingerprintPrompt()` 以固定盐 + 64bit hash 生成 `req-<8 位十六进制>`（如 `req-3f9a1c02`）。同一文本恒得同一标识（可做跨轮对照），不可反推原文，不同文本必不同。
2. **新增 `round` 轮次序号**：白盒日志每落一条 `record()` 自增（`cf_judge` / `cf_inject` 各计一条），脱敏后仍可按 `round` 对上日志条目顺序。
3. **新增 `promptChars`**：只记本轮用户输入的字符数，替代原文用于体积对照。
4. **`sessionId` 一并脱敏**：日志中写为 `sid-<8 位十六进制>`，避免调用方传入的项目名/客户名等敏感标识落盘。
5. **`cf_normalize` 缓存键不再回显内容**：`key` 由 `stableKey([JSON.stringify(rows)])`（等于把归一化内容原文重复一遍）改为 `nk-<16 位 hash>`。
6. **落盘走字段白名单**：`WhiteboxLogger.record()` 先经 `sanitizeForLog()` 按白名单重建记录再写盘，以后新增字段即使携带原文也不会进日志。

### 排查结论（全量排查，其余字段无原文）
- `changes[].detail`、`note`：只含数量与 token 数字（如「命中 3 条候选，证据 5 条」「原始 1240 tokens → 优化后 892 tokens」），**不含原文**，保持原样。
- `cf_report`：累计统计与 `per_session` 聚合只输出计数与比率；`per_session` 中的 `sessionId` 是调用方自己传入的标识，返回给它本人不构成外泄，故保留原值（日志内仍为 `sid-*`）。
- `cf_meter`：`snapshot()` 输出不含任何请求文本（`MeterSample.query` 仅存在于进程内存，不落盘、不输出）。
- 工具返回中的 `prefix` / `body` / `tail` / `prompt`：是 `cf_inject` 的功能产物（调用方要用它发请求），不属于日志泄漏面，保持不变。

### 测试
- 新增 4 条用例（指纹确定性/幂等、会话脱敏、白名单构造、真实落盘无原文且 `round` 递增）；**合计 68 用例全绿**（tsc + vitest）。
- 3–5 轮冒烟（临时脚本 `smoke.mjs`，分别对 v0.4.3 包与 v0.4.4 包各跑一遍）：比对两版命中输出，确认命中判定/注入前缀逐字节一致；校验新日志文件中 `requestId`/`sessionId` 均为脱敏标识、`round` 递增、全文无 prompt 原文（v0.4.3 同场景 9 处泄漏 → v0.4.4 0 处）。

## v0.4.3（2026-11-03）— minPrefixTokens 失效修复（临时修复并入正式版）

> v0.4.2 正式包 `memoryInject` 的 `injectIncremental` 第 4 步 `topUpPrefixToMin` 补充结果未赋回 `prefix`，导致 `prefixReady` 恒 false、`minPrefixTokens` 配置失效。厂商 D 系默认门槛 295 足够故未暴露；厂商 G 系门槛 1806+ 露馅。该问题曾以 `.bak_fix_minprefix` 临时修复，现并入正式版。

### 修复
1. **一行变更**：`injectIncremental` 第 4 步 `let topUp = topUpPrefixToMin(...)` 后立即 `prefix = topUp.prefix;`（第 7 步 maxTokens 收缩分支已有同类赋回，未重复修改）。src 与 dist 同步，`npm run build` 重建。

### 测试
- 构建后验证 `dist/core/memoryInject.js` 含修复行。

## v0.4.2（2026-11-02）— 吸收首批实测反馈（跳过 v0.4.1 直接发 v0.4.2）

> 用 v0.4.0 包做 20 次连续请求实测：累计命中 93.09%（R1 82.40%，R2 因门槛盲区 0 命中）。v0.4.1 仅改名+白盒文案、未改核心算法，故不发 v0.4.1，直接把以下改进项改入 v0.4.2 一并重测。

### 实测反馈落地（4 项）
1. **冻结冷启动陷阱修复**：`cf_inject` 新增 `freezeFragments` 开关（默认 true）。false 时冷启动不再锁死占位片段，允许随轮次重建前缀，避免"无历史首轮冻结 128 占位 → 后续全 0 命中"。
2. **前缀门槛 200 → 256**：`DEFAULT_MIN_PREFIX_TOKENS` 提升到 256（回应 R2 门槛盲区）；新增 `DEFAULT_MIN_PREFIX_SAFETY_FACTOR = 1.15`，实际门槛 = `ceil(minPrefixTokens × factor)`，`cf_inject` 支持 `minPrefixSafetyFactor` 覆盖；返回新增 `effectiveMinPrefixTokens`。
3. **full 场景 strictness 可配**：`cf_inject` 新增 `strictness`（strict / balanced / loose），默认 strict；balanced=平衡（允许自身知识补充并标注为推测），loose=自由放行；仅影响 full 场景；冻结会话强制沿用冻结时的强度，避免前缀字节漂移。warmup 沿用冻结强度。
4. **cf_report 聚合维度**：新增 `aggregateBy`（total / per_session），按会话分组累计；白盒单次报告增加 sessionId/scenario/mode/alignBlocks/prefixTokens，返回新增 `frozenFragmentsTokens`（冻结成本可见）。

### 其他
- 新增 `vitest.config.ts`：显式 include `test/**/*.test.ts`、exclude temp 备份目录，避免历史备份干扰测试扫描。
- 白盒报告卡片补充 strictLabel（约束强度文案）与冻结明细。

### 测试
- 新增 7 个用例（strictness 映射/balanced/loose、有效门槛 256×1.15=295、safetyFactor=1、frozenFragmentsTokens、per_session 聚合、默认门槛 256）。
- 合计 **64 用例全绿**（tsc 编译 + vitest 通过）。

## v0.4.1（2026-11-02）— 产品定名 DoboCache + 白盒报告即时摘要（形态 A）

### 产品定名
- 产品定名 **DoboCache**（dobo 前缀，一眼看懂是提升缓存命中率的小插件）。
- 对外全量改名：`package.json` name/description、README 标题与叙事、CHANGELOG、代码内对外文案（工具描述/返回文案/注释/日志文件名/前缀填充块/稳定前缀文档块/预热占位符）、对照实验脚本标签、打包文件名 `dobocache-v0.4.1-portable.zip`。
- 包内接口名（`cf_*` 工具、WhiteboxLogger、SessionInjectStore 等）保留不变，保证调用方式零变更。

### 白盒报告形态 A：即时摘要卡片（产品差异化核心升级）
- **「省钱报告」正式更名「白盒报告」**：whitebox.ts 注释、README、部署文档、工具返回文案全部统一。
- `cf_judge` / `cf_inject` 调用返回时**自动附带一段固定格式的对齐文本块**（白盒报告卡片）：
  - 原始 token / 优化后 token（千分位对齐）；
  - 缓存命中率（本次命中/未命中占比，有厂商 usage 时优先）；
  - 预估节省（比例，按命中/未命中两个计价系数折算，不输出金额）；
  - 本次做了什么（变更明细：前缀稳定化、重复指令去重、动态内容移至末尾、128 对齐、前缀过门槛补充、场景化约束、命中判定等）；
  - 可带备注（如"cf_judge 只做判定不改写输入"）。
- 新增强化函数 `formatReportCard`（whitebox.ts），生成对齐文本卡片。
- 无新增按钮、无新增窗口、无新增工具、不改变工具调用方式（本版明确不做悬浮窗/仪表盘/行为痕迹采集/数据回传）。

### 测试
- 新增 3 个白盒报告卡片用例（formatReportCard 固定格式 / 无变更明细省略 / 千分位与计价系数备注）；测试数据同步更新为 DoboCache。
- 合计 **57 用例全绿**（构建 + vitest 全绿）。

## v0.4.0（2026-11-02）—「命中缓存 + 白盒」首发主产品

### 定位
- 产品聚焦为「装上 token 就是少，每一步看得见」：**缓存命中 + 白盒日志**双核心，剥离跨对话承接，作为后续独立方向保留（实现不随本包分发）。
- 保留核心四模块（hitJudge / valueTier / memoryInject / meter）与简单工具调用（无按钮、无复杂 UI）。

### 剥离：跨对话承接
- 从发布包移除跨对话相关能力：`cf_sessions` 工具、`cf_inject` 的 `resumeFrom` 参数、`SessionInjectStore` 的磁盘持久化 / `list` / `getDetail` / `isExpired` / `resolveResume`。
- `SessionInjectStore` 收敛为**纯内存**会话冻结前缀注册表（同会话跨轮前缀复用能力保留），完整跨对话实现不随本包分发（含 v0.3.0 源码快照与旧测试），留作后续独立方向复用。
- 环境变量 `CACHEFORGE_DATA_DIR / CACHEFORGE_SESSION_TTL_MS` 随之移除；新增白盒日志目录 `data/logs/`（相对启动目录，v0.4.4 r2 起改为平台标准目录，此处为历史记录）。

### 新增：白盒日志模块（产品差异化核心）
- **单次调用「白盒报告」**：`cf_judge` / `cf_inject` 每次调用生成报告——原始 token / 优化后 token / 缓存命中率 / 预计命中 token 与比例 / 本次做了什么（前缀稳定化、重复指令去重、动态内容移至末尾、128 对齐、前缀过门槛补充、场景化约束、命中判定等变更明细）。
- **cf_report 累计统计工具**：输出今日与进程累计——调用次数、命中率（按调用加权均值）、原始/优化 token、预计命中 token 与比例（按未命中 / 命中两个计价系数的比值口径，不输出任何具体金额数字，系数可配）。
- **不占对话 token**：每次报告追加写入本地 JSONL 日志 `data/logs/dobocache-<date>.log.jsonl`（JSON 每行一条，可折叠/文件查看），server 侧零 LLM 调用、零额外推理成本；日志落盘失败不阻断主流程。

### 测试
- 移除跨对话用例 10 个（持久化/resume/cf_sessions），新增白盒用例 6 个（buildReport 口径、today/total 累计、跨自然日滚动、JSONL 落盘、重复行检测、reset）；合计 **54 用例全绿**（构建 + vitest 全绿）。

## v0.3.0（2026-11-02）

### 新增：跨对话承接（冻结前缀持久化 + resumeSession）
- **冻结前缀持久化**：`SessionInjectStore` 支持落盘（`persist` 模式），每次 `cf_inject` 冻结后把 `frozenFragments / prefixHash / 价值分级结果 / 更新时间` 写入 `<cwd>/data/sessions/<sessionId>.json`；server 重启后 `get/list/getDetail` 仍可读取，实现「对话满了换新对话后，稳定前缀+厂商缓存收益无缝延续」。
  - 存储目录默认 `data/sessions`，可经 `CACHEFORGE_DATA_DIR` 覆盖；过期阈值默认 7 天，可经 `CACHEFORGE_SESSION_TTL_MS` 覆盖；
  - 会话文件仅存本机 data 目录，**不随发布包分发**；删除某会话记录删除 `data/sessions/<sessionId>.json` 即可，或整体删除 `data/` 目录清理全部。
- **resumeSession 跨对话承接**：`cf_inject` 新增可选参数 `resumeFrom`（旧会话 sessionId），调用时从持久化文件加载旧会话冻结前缀作为本会话前缀基础，新对话内容仅进 tail（增量注入照常）；返回 `resumedFrom / resumedPrefixHash / resumedFragments / resumeStatus`（`ok / not_found / expired`）。
  - 隐私：resume 仅复用旧会话**冻结前缀片段**，不注入任何旧对话 tail（敏感动态内容不落盘、不跨会话扩散）。
- **cf_sessions 会话管理工具**：列出历史持久化会话（sessionId、创建/更新时间、冻结片段数、prefixHash 摘要、前缀 tokens、是否过期），支持 `detailId` 查看单会话完整记录（冻结片段明细 + prefix/body），供跨对话承接前自主选择旧会话。
- **代码结构**：`memoryInject.ts` 新增 `SessionPersistenceOptions / SessionRecord / DEFAULT_SESSION_TTL_MS / DEFAULT_SESSION_DATA_DIR`，`SessionInjectStore` 增加 `list / getDetail / isExpired` 与 `persist / dataDir / ttlMs` 构造配置；`mcpTools.ts` 新增 `resolveResume` 并导出（便于单测）。

### 测试
- 新增 10 个用例：持久化读写（新实例读回）、list 摘要、getDetail/remove、损坏文件安全跳过、resume 成功/找不到/过期/未传、resume 后增量注入复用旧冻结前缀（前缀逐字节一致 + frozenHitRatio=100 + 新内容仅进 tail）、会话列表过期标记；合计 **58 用例全绿**。

## v0.2.1（2026-11-02）

### 修复
- **版本号修正**：package.json 版本 0.1.0 → 0.2.1，消除与发布包 v0.2.x 的版本不一致（见早期实测记录）。
- **prefixHash 语义修复**：
  - 保留 `prefixHash`（整体前缀指纹），新增 `frozenHitRatio`（上一轮冻结片段集合本轮原样复用比例）与 `frozenReused` 明细（`reused` 复用片段 id / `replaced` 被替换片段 id）；
  - `reusedPrefix` 语义改为「本轮是否复用了上一轮冻结前缀」（与冻结前缀逐字节比对），不再因整体 hash 随历史增长而变化而恒为 false。
- **首轮空窗优化**：修复 maxTokens 收缩分支未同步更新 `prefix/prefixTokens/prefixHash` 导致返回 `prefixReady=false` 的误导（R1 前缀实际已补齐、返回却显示 188<200）；
  - 前缀不足门槛时 `topUpPrefixToMin` 循环追加固定版本文档块，**必然补齐过门槛**（不再只遍历一轮 docBlocks）；
  - 支持 `maxTokens` 提高时首轮多并入高价值片段（补充受 `maxPrefixTokens` 软上限约束）。
- **128-token 对齐（启发式）**：无 tokenizer 条件下按字符估算 token，稳定前缀尾部按 128 倍数补齐（固定对齐块追加到前缀末尾，保持字节稳定），减少厂商缓存尾部部分命中；提供 `align128` 开关（默认开启，可关闭恢复原行为）与 `alignFillText` 自定义填充块。

### 增强
- **meter 计费相对值曲线**：`cf_meter` 新增按轮次累计字段——累计命中 tokens、累计未命中 tokens、累计节省估算（命中 tokens × 命中/未命中两个计价系数之差，系数可配、默认档位可经环境变量覆盖），并输出逐样本累计曲线 `cumulative`。
- **cf_warmup 预热工具**：新增 MCP 工具，客户端在首轮前**显式**调用一次，用当前冻结前缀构造最小占位请求以触发厂商缓存建立；默认不自动触发；调用说明注明该请求本身会计入少量未命中 token；命中率无法由 server 侧确认时提示「请以第二轮 usage 为准」。

## v0.2.0（2026-11-02）

### 增量注入（发布名 v0.2.0-portable，对应首轮对照实测）
- `memoryInject.ts` 新增 `injectIncremental` / `SessionInjectStore` / `extractVolatileParts` / `resolveRulesForScenario` / `topUpPrefixToMin`：
  - 会话增量注入：固定版本化前缀（规则块 + 分级片段分块 + 固定补充块）逐字节不变，新内容只追加尾部 tail；
  - 最小有效前缀：`DEFAULT_MIN_PREFIX_TOKENS=200` 门槛，不足时先补池中高价值片段、再补固定版本文档块；
  - 约束场景化：缓存充足（full）含「禁止编造」硬约束，首轮/缓存为空（first）放行自由回答；
  - 易变内容强制 tail：时间戳/会话标记/最新消息自动剥离进尾部，避免污染稳定前缀；
  - 跨轮前缀复用：同一 `sessionId` 冻结前缀，后续轮次片段变化也复用冻结片段，保证前缀逐字节不变。
- `mcpTools.ts` `cf_inject` 新增 `sessionId / previousPrefixHash / minPrefixTokens / minPrefixDocBlocks / volatile / reset / scenario` 入参，返回 `prefixHash / prefixReady / frozenReused / reusedPrefix / scenario / prefixTokens / tokens`。
- `serialize.ts` 新增 `hashString`（64bit 确定性指纹）。

## v0.1.0（2026-10 初）

### 核心四模块
- `hitJudge`：关键词分层（实体锚词/意图词）、三层缩圈匹配、时效衰减、负向过滤、交叉关联召回；
- `valueTier`：记忆提纯、A/B/C 价值分级、预算填充准入；
- `memoryInject`：稳定版本化前缀 + 分级片段正文 + 动态尾部；
- `meter`：测量仪表快照（命中率、分级分布、token/成本节省估算）。
- MCP 工具：`cf_judge / cf_tier / cf_inject / cf_meter / cf_prune / cf_normalize / ping`。

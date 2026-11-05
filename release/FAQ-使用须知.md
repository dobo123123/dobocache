# FAQ / 使用须知 — DoboCache v0.4.7

> 本文汇总挂载后最常见的 14 个问题（§零 为平台支持状态，§一–§十三 为使用问题）。所有结论均对应 v0.4.7 实际行为；涉及数字的条目请与 `testdata/` 内原始数据核对。

---

## 安装报错速查（装不上先看这一章）

> 这一章按**报错原文**排的，直接 Ctrl+F 搜你看到的那句话。
> 如果还没开始装，先看 [零基础三分钟上手.md](零基础三分钟上手.md)，那份是从零开始的步骤版。

### 1. `'node' 不是内部或外部命令` / `node: command not found`

**原因**：没装 Node.js，或者装了但没进 PATH。

**解法**：
1. 到 <https://nodejs.org/zh-cn> 下 LTS 版，默认下一步装完
2. **关掉所有命令行窗口重新开**（不重开不生效，这是最常见的漏步）
3. `node -v` 应输出 `v18.x` 以上

### 2. `spawn node ENOENT` / `spawn npx ENOENT` / `MCP error -32000: Connection closed`

**原因**：客户端启动子进程时**找不到 `node` 这个命令**。客户端不是在你的终端里跑，它用的是系统 PATH，装了 Node 也可能找不到。

**解法**（按推荐顺序）：

- **最稳**：配置里把 `command` 改成 node 的**绝对路径**。先查出来：
  ```
  where node
  ```
  常见输出 `C:\Program Files\nodejs\node.exe`。然后配置写成：
  ```json
  { "mcpServers": { "dobocache": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\dobocache\\dist\\index.js"]
  } } }
  ```
- 如果用 `npx` 写法则报这个错：**别用 npx**，原因见第 10 条

### 3. `Cannot find module 'D:\...\dist\index.js'` / `ERR_MODULE_NOT_FOUND`

**原因**：路径写错，或者解压时多套了一层文件夹。

**解法**：
1. 在资源管理器里打开你解压的目录，确认**能直接看到 `dist` 文件夹**
2. 如果看到的是 `dobocache-v0.4.7` 里面再套 `dist`，说明多了一层，要把内层内容提出来
3. 把 `dist\index.js` 整个拖进命令行会显示真实路径，复制那个

### 4. 配置改了但客户端启动失败 / 配置被忽略 / 工具列表空

**原因**：JSON 语法错。Windows 路径写成单个反斜杠是最常见的一个。

**解法**：
- `D:\dobocache\dist\index.js` 在 JSON 里必须写成 `D:\\dobocache\\dist\\index.js`（双反斜杠）
- 把整个文件贴到 <https://jsonlint.com> 校验，显示 **Valid JSON** 才算对
- 特别注意：如果客户端原来就有 `mcpServers` 段，不要整体覆盖，只往里加 `dobocache` 那一块

### 5. 客户端重启了，但工具列表里根本没有 `dobocache`

**原因**：九成是"假重启"——右上角 X 只是最小化到托盘，进程没退出。

**解法**：
- **Claude Desktop**：右键任务栏图标 → Quit / 退出，然后重新打开
- **Cursor**：完全关闭再打开
- **VS Code + Cline**：`Ctrl + Shift + P` → `Reload Window`
- 还不行：在任务管理器里结束掉客户端进程再启动

### 6. `EACCES` / `EPERM` / 拒绝访问 / 无法写入

**原因**：程序目录没有写权限。DoboCache 需要在同级目录下写日志。

**解法**：
- 别放 `C:\Program Files`、别放系统盘根目录
- 换到 `D:\dobocache` 这类普通目录
- 别用管理员权限的终端跑客户端（会导致权限不一致）

### 7. 路径里有中文或空格导致启动失败

**原因**：部分客户端在拼命令行时不加引号，空格会被当成参数分隔。

**解法**：
- 解压到**纯英文、无空格**的短路径，推荐 `D:\dobocache`
- 如果非要带空格，`args` 里每一项要单独写，不要拼成一整条字符串

### 8. PowerShell 报"因为在此系统上禁止运行脚本"

**原因**：PowerShell 默认执行策略限制。只有用 `写法 C`（全局安装后调命令）时才会遇到。

**解法**：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

> 这条只改你当前用户、只允许本地脚本运行，不需要管理员权限。如果不放心改策略，就改用 `写法 A`（绝对路径 + index.js），完全不经过 PowerShell 脚本。

### 9. 杀毒软件 / Windows Defender 拦截或删文件

**原因**：DoboCache 会启动子进程并读写本地日志，行为上像"可疑程序"。

**解法**：
- 把解压目录加入 Defender / 杀软的白名单或排除项
- 如果是公司电脑装了 EDR，可能需要 IT 放行

### 10. `npx` / `npm install -g dobocache` 装不上

**原因**：**npm 渠道目前尚未上架**，`npm view dobocache` 返回 404。

**解法**：这条不是你的问题，是我们还没发布到 npm。**请一律用便携包（写法 A）**：

```json
{ "mcpServers": { "dobocache": {
    "command": "node",
    "args": ["D:\\dobocache\\dist\\index.js"]
} } }
```

README 里出现的 `npx` 写法是上架后的预留写法，现在还不可用。上架后会在 Release 里公告。

### 11. Node 版本报错：`SyntaxError` / `不是函数` / 启动即崩

**原因**：Node 版本低于 18。DoboCache 用到了新版才有的 API。

**解法**：`node -v` 确认，升级到 18 或以上（推荐 22 LTS）。升级后要**重开客户端**。

### 12. 装上了，但完全看不出任何变化

**原因**：这是**正常现象**，不是故障。

**解法**：DoboCache 不改变 AI 的回答内容，只提升服务商侧的缓存命中率。你的主观感受就是"什么都没变，但账单少了"。想看证据：

```
把 dobocache 的白盒报告打开
```

或者查看 `data\logs\` 下的日志（见第三章）。详细解释见 [零基础三分钟上手.md](零基础三分钟上手.md) 最后一节。

### 13. 装完想卸载 / 想彻底关掉

**解法**：
1. 从客户端配置文件里删掉 `dobocache` 那一整块
2. 完全退出并重启客户端
3. 解压目录可以直接删掉（日志也一并删除，不留痕）
4. 如果之前设过环境变量或全局安装，一并清理

**不需要**卸载 Node（除非你本来就没在用）。

---

## 零、支持哪些操作系统？Windows 之外能用吗？

**Windows 是主打平台，也是唯一做过真机端到端验证的平台。Linux 已在 `linux/amd64` 容器内实测运行；macOS 未在真机运行过，只有单元测试覆盖。**

| 平台 | 状态 | 说明 |
|---|---|---|
| Windows 10 / 11（x64） | ✅ 主打，已真机验证 | 本组实验 20 次连续请求真机对照、便携包解压即跑、95 项测试全通、日志落盘实测 |
| Linux（x86_64） | 🟡 容器环境已实测 | 2026-11-04 Docker `linux/amd64` + Node 官方镜像：解压即跑、`initialize`/`tools/list` 合法、9 工具可用、日志 `~/.local/state/dobocache` 落盘、`XDG_STATE_HOME` 与 `DOBOCACHE_LOG_DIR` 优先级正确、只读目录降级不崩溃、Node 16 自检 `exit 1`；桌面真机 + 图形客户端挂载、arm64 未验证 |
| macOS（Intel / Apple Silicon） | ⚠️ 未真机验证 | 只有单元测试覆盖 `~/Library/Logs/DoboCache` 及同批用例 |

包内不含任何原生二进制（`.node` / `.exe` / `.dll` 为 0），所以不存在 ABI 层面的"装不上"问题；但**"没有原生依赖"不等于"我们已经验证过"**，桌面 Linux 的图形客户端挂载、macOS 全平台，以及"真实客户端挂载 + 厂商缓存回读"这条完整链路我们没有跑过，因此不做可用性承诺。

**在 Linux / macOS 上遇到问题怎么反馈**（欢迎反馈后修）：

1. 先自查本文 §三（日志落盘位置）与 §七（`prefixReady` 恒 false）；
2. 反馈时附：`node -v`、`uname -a`（macOS 用 `sw_vers`）、`cf_report` 返回的 `logDir` / `logDirSource`、完整报错原文；
3. 渠道：GitHub Issues（仓库开通后，标题带 `[platform: linux]` / `[platform: macOS]`）；仓库开通前在包的获取渠道回帖；
4. **不要粘提问原文**——日志已脱敏，贴日志片段足够定位。

## 一、hitRate 是 null / 0，是不是没生效？

**不是。日志里的 `hitRate` 不等于厂商真实命中率，别拿它当结论。**

原因：白盒日志由 `cf_judge` / `cf_inject` 在**发出请求之前**写入，此时厂商还没返回本次请求的 usage，日志无从得知真实命中量。**它记录的是"这一步做了什么调整"，不是"厂商命中多少"。**

两版口径的差别（v0.4.6 起）：

| 情况 | 旧口径（v0.4.4 及以前） | 新口径（v0.4.6） |
|---|---|---|
| 调用方没回传厂商 usage | `hitRate` 写 `0` | `hitRate` 写 `null`（未判定） |
| 调用方回传了 `hitTokens` / `missTokens` | 写真实命中率 | 写真实命中率（同） |

也就是说：**看到 `null` 就表示"这次没拿到厂商 usage，算不出来"，不是"命中率 0%"。** 要让日志记下真实命中率，请在 `cf_judge` / `cf_inject` 调用里带上 `hitTokens` / `missTokens`（取自厂商 `usage` 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`）。

判断真实命中率只有两个来源，且优先级如下：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | **厂商 API 返回的 usage 缓存字段** | 唯一权威口径：`cached_tokens / prompt_tokens`（部分厂商 `prompt_tokens` 已含缓存部分，不重复相加；具体字段名以该厂商文档为准） |
| 2 | **`cf_report` 的累计统计** | DoboCache 侧汇总视图，用于看趋势与按会话聚合，适合快速自查 |

举例（本组 实验第一次请求的真实记录，旧口径日志）：日志里 `hitRate=0`，而同一次请求厂商 usage 实测 **99.12%**。两者不矛盾——一个写在请求发出前，一个来自请求返回后；v0.4.6 起这种拿不到 usage 的场景统一记 `null`，不再写 `0`，从根上避免"0% 命中"的误读。

## 二、第一次请求为什么没有命中？

**第一次请求是建缓存，命中率从第二次请求起才有。**

正常情况下第一次请求的上下文是全新的，厂商侧还没有可复用的缓存块，所以这一次必然"建缓存"而非"用缓存"。流程是：

```
第 1 次请求  建缓存（必然 0 命中）→ 第 2 次请求起复用前缀 → 高命中
```

两个前提必须同时满足，否则第二次请求也不会命中：

1. **前缀稳定**：第二次请求的开头必须与第一次逐字节一致。DoboCache 已做去重、128 token 对齐与门槛补足，但如果你的客户端在两次请求之间改变系统提示词或注入时间戳等动态内容，前缀仍会被破坏；
2. **前缀过门槛**：前缀长度必须超过厂商的最小缓存长度。部分厂商门槛远高于默认值（例如需要 1806+），此时要在 `cf_inject` 显式传 `minPrefixTokens`，实际生效门槛为该值 × 1.15。

验证方法：日志里 `prefixReady` 应为 `true`、`effectiveMinPrefixTokens` 应等于你配置的门槛 × 1.15。若 `prefixReady` 恒为 false，说明前缀没补到门槛（v0.4.2 及更早版本存在此 bug，v0.4.3 起已修复）。

> 补充：`minPrefixTokens` 的上限场景下，前缀补足会引入少量额外块（日志 `changes[]` 里 `topup` 一项会写明补充块数），这是换取"稳定过门槛"的必要成本。

## 三、日志文件在哪？怎么读？

**路径**：`<日志目录>/dobocache-<日期>.log.jsonl`（日期格式 `YYYY-MM-DD`，每天一个文件，JSONL 逐行一条记录）。

日志目录从 **v0.4.4** 起不再依赖"当前目录"——MCP 客户端拉起 server 时的 cwd 常常未定义或是只读目录，写相对路径会写错位置甚至直接崩，因此改为系统标准可写目录：

| 平台 | 默认日志目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\DoboCache\logs`（例 `C:\Users\<你>\AppData\Local\DoboCache\logs`） |
| macOS | `~/Library/Logs/DoboCache` |
| Linux | `$XDG_STATE_HOME/dobocache`（未设置则 `~/.local/state/dobocache`） |

优先级：环境变量 `DOBOCACHE_LOG_DIR` > 平台默认目录 > `<cwd>/data/logs`（兼容旧行为，仅前两者都不可用时回退）> 都不行则不写文件、只在 stderr 提醒一句，进程继续运行（不会因此退出）。

**不确定落在哪**：调 `cf_report`，返回里的 `logDir` / `logFile` 就是本次实际使用的目录与当前文件；`logDirSource` 说明来源（`env` / `platform` / `cwd` / `disabled`）。

**改了目录也算得出来**：设置环境变量 `DOBOCACHE_LOG_DIR` 指向目标目录即可覆盖默认位置，再按 `<DOBOCACHE_LOG_DIR>/dobocache-<日期>.log.jsonl` 查找。**请填绝对路径**：填相对路径时会按 server 进程的当前目录解析，而客户端拉起 server 时 cwd 不确定，日志可能写到你想不到的位置。

**常用读取命令**（Windows PowerShell；macOS / Linux 把 `$log` 换成对应目录，如 `$HOME/Library/Logs/DoboCache`、`${XDG_STATE_HOME:-$HOME/.local/state}/dobocache`）：

```powershell
$log = "$env:LOCALAPPDATA\DoboCache\logs"

# 看今天最后 5 条记录
Get-Content "$log\dobocache-2026-11-03.log.jsonl" -Tail 5

# 只看命中相关字段（每行取 requestId / reqIndex / hitRate / prefixTokens）
Get-Content "$log\dobocache-2026-11-03.log.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object requestId, reqIndex, hitRate, prefixTokens, sessionId

# 统计当天记录条数
(Get-Content "$log\dobocache-2026-11-03.log.jsonl").Count

# 检查日志里是否还残留自己的提问原文（应无结果）
Select-String -Path "$log\*.jsonl" -Pattern "你的提问片段"
```

**字段速查**（v0.4.6）：

| 字段 | 含义 |
|---|---|
| `reqIndex` | 本机进程内第几次请求（每次白盒记录自增，用于"第几次请求"级对照；v0.4.6 起由 `round` 更名） |
| `requestId` | `req-<8 位 hash>`，同一提问恒同值（用于"是否同一提问"对照），不含原文 |
| `sessionId` | `sid-<8 位 hash>` |
| `promptChars` | 提问字符数（只有数字） |
| `rawTokens` / `optimizedTokens` | 注入前 / 注入后的 token 数 |
| `hitRate` / `savedTokens` / `savedPct` | 注入阶段派生值，见 §一，不作真实命中率使用 |
| `changes[]` | 本步做的调整（`dedup` 去重 / `align128` 对齐 / `topup` 过门槛补充 / `scenario` 场景判断） |
| `note` | 一句话说明（只含 token 数字） |
| `prefixTokens` / `alignBlocks` | 前缀长度 / 对齐块数 |

**`cf_report` 兜底**：不便读文件时，直接调 `cf_report`，返回累计命中率、节省比例与 `per_session` 聚合。注意 `cf_report` 的累计是按"已回传 usage 的请求"统计，与逐行日志的条数口径不同，不要互相加减。

## 四、隐私：日志里到底存了什么？

从 **v0.4.4** 起：

- **不含提问原文**：`requestId` 由原文改为 `req-<8 位 hash>`（固定盐 + 64bit 指纹），同文恒同值、不可反推；
- **不含会话原文**：`sessionId` 改为 `sid-<8 位 hash>`；
- **`cf_normalize`** 返回键改为 `nk-<16 位 hash>`，不再回显归一化内容；
- **只存本地，不上传**：日志留在本机日志目录（默认见 §三的平台标准目录），DoboCache 不向任何服务器发送日志或上下文；该目录也不随便携包分发；
- **白名单落盘**：写盘前走字段白名单，后续版本即使新增字段携带正文，也不会写进日志。

**历史旧日志仍需自行清理**：v0.4.4 不能追溯修改旧文件。v0.4.3 及以前产生的 `data/logs/*.jsonl` 中 `requestId` 仍是提问原文，若你把机器日志对外提供过，建议按自己的合规要求删除或归档：

```powershell
# 旧版本日志写在"启动时的当前目录"下，常见为解压目录\data\logs；先定位再确认
$old = "D:\<你的旧日志目录>\data\logs"   # 换成你实际的旧日志目录

# 先确认哪些文件属于旧版本产生（含空格与中文即为原文残留）
Select-String -Path "$old\*.jsonl" -Pattern '::\d{13}' | Select-Object -First 5

# 确认后移入回收站（不建议直接永久删除，便于回溯）
# 手工在资源管理器中删除，或：
# Remove-Item "$old\dobocache-2026-11-02.log.jsonl"
```

> 说明：`cf_inject` 返回的 `prefix` / `tail` / `prompt` 是**功能产物**（你需要用它去发请求），不属于日志泄漏面，不做脱敏。

## 五、自己复现实验时，对照组必须注入随机噪音

**这是本套实验最容易做错的一步。**

对照组（不挂载）如果每次直接发同样的任务文本，厂商的自动前缀缓存会让第二遍请求**也命中**——于是"对照组"看起来命中率很高，对照失去意义。

正确做法：

1. 对照组每次发送**两遍**相同任务，但**头部注入不同的随机噪音标记**（如随机串 + 时间戳），制造前缀漂移；
2. **取第二遍的 usage** 作为该次读数（第一遍是建缓存）；
3. 实验组同样每次两遍，但两遍完全相同，也取第二遍。

否则会出现"对照组天然命中 60%–80%"的情况（这在稳定长前缀的 CLI 场景里很常见），此时对比的不是"有没有 DoboCache"，而是"缓存窗口状态"。

## 六、命中率能不能换算成计费折扣？

**不能，本文档也从不给出任何计费金额数字。** 原因：

1. 命中率是**单次请求输入内部**的缓存占比，两组输入量本就不同（对照组输入随请求次数累积增长，实验组稳定在"前缀 + 尾部"），不可跨组换算成绝对 token 数；
2. 不同厂商、不同模型的缓存计费规则（未命中/命中两个计价系数）各不相同，同一命中率对应的计费差异很大；
3. 同一实验内不同接入方式的数字不可混比（例如本组与另一组 CLI headless 接入路径不同，只可看形态，不可混比数值）。

对外只报**命中率**与**相对比例**，这是本项目的口径约束。

## 七、`prefixReady` 一直是 false 怎么办？

1. 检查是否传了 `minPrefixTokens`，以及目标厂商的真实门槛（部分厂商需 1806+）；
2. 看日志 `effectiveMinPrefixTokens` 是否为"配置值 × 1.15"；若等于 295（默认值 256 × 1.15），说明配置未生效 → 确认版本是否 ≥ v0.4.3（v0.4.2 及更早存在补足结果未接回的 bug）；
3. 看 `prefixTokens` 是否稳定超过 `effectiveMinPrefixTokens`；
4. 若前缀被客户端动态内容打断（时间戳、随机 ID、工具结果顺序变化），需在客户端侧固定这些内容。

## 八、`cf_inject` 里 `reset` 什么时候开？

- **开（`reset=true`）**：新会话、换话题、换目标厂商门槛时。会重建前缀，第一次请求必然是建缓存；
- **不开**：同一会话连续追问时，复用已建立的前缀。

注意：不 `reset` 却换了话题或门槛，会让旧前缀与新技术不匹配，出现初始请求被"锁死"命不上的情况（早期一次实测有单独存档记录该现象，未计入正式结果）。

## 九、日志每天都生成一个文件，会一直涨吗？

每个自然日一个文件，当日累积。长期运行可按需归档旧文件（JSONL 是纯文本，压缩率高）。DoboCache 不会自动删除你的日志——是否清理、保留多久由你决定。

## 十、换机器后要不要做什么？

1. 解压新包即可用（内含 `dist` 与 `node_modules`，无需 `npm install`）；
2. **不要直接拷贝旧机器的 `data/logs`**，仅当需要留存历史时单独归档；旧日志含提问原文（v0.4.3 及以前）；
3. 若希望命中率可比，`sessionId` 建议按"机器 + 项目 + 版本"重新命名，避免跨环境混入同一聚合。

## 十一、有没有 `cf_doctor` 之类的自检工具？

**当前版本没有。** 自检工具（`cf_doctor`）按计划留到 v1.1，本版不提供。

现阶段的自检手段就是本文 §二 的验收标准：

- 日志 `prefixReady = true`；
- `effectiveMinPrefixTokens` = 配置门槛 × 1.15；
- 第二次请求起厂商 usage 的缓存字段 > 0；
- `cf_report` 的累计命中率呈上升趋势。

四条同时满足即视为工作正常。

## 十二、挂上以后客户端看不出变化，是没生效吗？

分两种：

1. **功能生效但客户端不显示**：客户端是否展示缓存命中取决于它自己。目前只有少数客户端有文档级证据（如 Codex CLI 的遥测字段、Gemini CLI 的 `/stats`），且都不是"面板直接显示命中率"。判断是否生效请以**日志 + `cf_report`** 为准，或比对同一请求的前后 usage 字段；
2. **请求没走到 DoboCache**：检查 MCP 配置是否指向 `dist/index.js`、客户端是否支持自定义 `base_url`（**Cursor 不支持自定义端点**；Claude Desktop、Gemini CLI 文档中未见兼容端点入口），详见 `兼容性说明.md`。

## 十三、白盒报告卡片怎么不见了？要不要开？

**v0.4.6 起白盒报告默认关闭，这是刻意设计，不是坏了。** 报告卡片写进对话上下文是要**占 token** 的（每张约 300+ tokens），日常使用没必要为此付费。

| 你想干什么 | 怎么做 | 花不花对话 token |
|---|---|:---:|
| 日常使用 | 什么都不用设（默认 `quiet`，只写本地日志） | 不花 |
| 看累计命中率 / 今日请求数 | 调 `cf_report` | 不花（读本机日志） |
| 想看下一次调用的详情 | 设 `DOBOCACHE_WHITEBOX=once`，出一次后自动回落 | 一次性 |
| 正在做对照实验，每次都要读数 | 设 `DOBOCACHE_WHITEBOX=always` | 每次约 300+ tokens |
| 想彻底关掉 | `DOBOCACHE_WHITEBOX=quiet`（等同不设） | 不花 |

首次在本机运行时会给一条**一次性**提示（告诉你白盒在哪、怎么开），之后不再出现。开启后若仍看不到卡片，先看 server 的 stderr——启动时会打一行"白盒卡片已开启（DOBOCACHE_WHITEBOX=...）"，没有这行说明环境变量没被客户端传进去（多数客户端的 `env` 字段要写在 server 配置里，而不是系统环境变量）。

---

## 提问与求助（做完这三步，能省掉两三轮来回）

这个项目是免费的、由作者业余维护，**没有客服**。把下面三步做完再提问，绝大多数问题能自己解决；即使要问，也能一次问清、少走弯路。

### 第一步：搜报错原文

不要描述现象，直接 Ctrl+F 搜你看到的那句话（英文报错也照抄）。本文开头的 [安装报错速查](#安装报错速查装不上先看这一章) 覆盖了 13 类最常见错误。

### 第二步：跑一次自检，把输出贴上来

```
让 AI 调用 cf_report 工具（或用你客户端自带的工具调试面板触发）
```

把返回的版本号、`logDir`、`logDirSource`、当前平台这三项贴上来 —— 这四个值能定位掉大半环境问题。

### 第三步：四项必备信息，缺一项就会多一轮追问

| 项 | 怎么拿 | 示例 |
|---|---|---|
| DoboCache 版本 | `package.json` 里的 `version`，或 `cf_report` 返回 | `0.4.7` |
| 操作系统 | 自己报 | Windows 11 23H2 / macOS 14.5 / Ubuntu 22.04 |
| Node.js 版本 | 命令行执行 `node -v` | `v20.11.1` |
| 客户端名称 + 版本 | 你用的什么在加载它 | Cursor 0.48 / Claude Desktop 0.9 / Cline 3.2 |

**再加一条**：`报错原文`（不是"报错了"），以及你配置文件里 `dobocache` 那一段（**把用户名、路径里的个人信息打码**）。

### 去哪里问

| 场景 | 去哪 | 说明 |
|---|---|---|
| 装不上、配不通、怎么接我的客户端 | [Discussions](https://github.com/dobo123123/dobocache/discussions) | 安装与使用类提问统一在这里，不必开 Issue |
| 确认是程序 bug（可复现、行为不对） | [Issues](https://github.com/dobo123123/dobocache/issues/new/choose) | 用 Bug report 模板，必填项照着填 |
| 希望加功能 | [Issues](https://github.com/dobo123123/dobocache/issues/new/choose) | 先看 [CONTRIBUTING.md](https://github.com/dobo123123/dobocache/blob/main/CONTRIBUTING.md) 里的范围约定，这个项目刻意保持"小而准" |
| 安全问题（泄露、越权、读不该读的文件） | [SECURITY.md](https://github.com/dobo123123/dobocache/blob/main/SECURITY.md) | **绝对不要**公开开 Issue |
| 想自己改代码 | [CONTRIBUTING.md](https://github.com/dobo123123/dobocache/blob/main/CONTRIBUTING.md) | 跑通 build / lint / test / check:docs 四道门再提 PR |

### 提问前自查三条

- [ ] 我搜过报错原文，也看过本文开头那一章
- [ ] 我贴的是**报错原文**和**配置片段**，不是复述
- [ ] 我已经把密钥、token、真实路径、提问内容里的隐私信息删掉了

> 回复时间不保证。作者会按"能一次定位"的优先级处理 —— 信息齐的问题通常当天有回复，信息缺的要来回问，自然就慢。

## 附：一句话速记

- 白盒报告**默认关**（`DOBOCACHE_WHITEBOX=quiet`），要看就开 `once` / `always`，看累计用 `cf_report`（不花 token）；
- `hitRate=null` = **本次没拿到厂商 usage、未判定**（旧版本此处写 0），**真实命中看厂商 usage**；
- **第一次请求建缓存**，第二次请求起才有命中；
- 日志在**平台标准目录**（Windows `%LOCALAPPDATA%\DoboCache\logs`，macOS `~/Library/Logs/DoboCache`，Linux `$XDG_STATE_HOME/dobocache`），`DOBOCACHE_LOG_DIR` 可改，实际落点看 `cf_report` 的 `logDir`；
- **v0.4.4 日志无提问原文**（`req-<hash>` / `sid-<hash>`），只存本地；**本版起日志自动维护**：单文件 10MB 轮转、最多 3 份副本、保留 7 天、只清理本模块命名的文件（同目录你自己的文件不会动），`DOBOCACHE_LOG_MAX_MB` / `DOBOCACHE_LOG_KEEP_DAYS` 可调；
- **复现对照组必须每次注入随机噪音**，否则对照组也会命中。

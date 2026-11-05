# testdata — 本组可复现实验证据包

本目录是 DoboCache v0.4.7 公开发布随附的**证据包**：本组实验的全部原始材料都在这里，README 正文引用的每一个数字都能在此逐项核对。

## 一、包含什么

| 文件 | 内容 | 支撑 README 中的哪个数字 |
|---|---|---|
| `hitrate-regression-report-20261103.md` | 本组回归报告：测试设置、门槛修复前后对照、20 次逐次结果、与早期一轮实测的对照判读、判读标准逐条核对 | 实验组均值 98.59%、区间 96.08%–99.79%、对照组 20/20 全 0、前缀就绪 20/20、`effectiveMinPrefixTokens=3450` |
| `hitrate-task-inventory-20261103.md` | 组 1→组 8 共 8 组实验的任务清单、20 次任务**原文**、复跑要点、各组结果汇总 | 说明"测的是什么任务、怎么测、测了多少次请求"；第 1–20 次任务原文 |
| `hitrate-testdata-20261103.csv` | 组 8（v0.4.3）20 次逐次数据：`round,text_type,raw_tokens,opt_tokens,hit_rate,saved_tokens,platform`（`round` 为列名，语义是"第几次请求"） | `hitrate-comparison.png` 中 v0.4.3 实验组的全部数据来源 |
| `hitrate-testdata-glm-v042-20261103.csv` | 组 7（v0.4.2 候选修复构建）20 次逐次数据：`round,baseline_hit_rate,opt_hit_rate,baseline_note`，同时含**对照组**逐次值（R10/R20 标注 `baseline_natural_hit`） | `hitrate-comparison.png` 中 v0.4.2 实验组与对照组曲线 |
| `hitrate-multi-platform-summary-20261105.csv` | 三种请求端形态 × 两个版本的汇总：`form_code,form_label,rounds,version,baseline_hit_rate,opt_hit_rate,metric,source_exp` + 四个 token 列（`baseline_hit_tokens,baseline_prompt_tokens,opt_hit_tokens,opt_prompt_tokens`）+ `recompute_file`（该行可复算的原始出处） | `hitrate-comparison-platforms.png` 的全部数据来源；数值回溯实验 031/032/033/034 与组 7/组 8。**形态 A / B 六行可用同行的 token 列直接除出百分比**（累计口径）；**形态 C 两行为逐次均值口径**，token 列留空，逐次值在同目录 `hitrate-testdata-glm-v042-20261103.csv`（组 7）与 `hitrate-testdata-20261103.csv`（组 8），由 `recompute_file` 列指明 |
| `复跑说明.md` | 从零复现的操作步骤、验收标准、四个常见踩坑、字段说明、重绘命令 | README「如何复现」章节的详细版 |



## 二、口径说明（重要）

1. **测试宿主匿名**：全部材料中被测宿主统一称「某常见编码 CLI 工具」，模型厂商以代号出现（厂商 D / 厂商 G）。任务原文中出现的公司/产品名属**对话话题内容**（20 次请求为 AI 资讯盘点话题），不是被测宿主指代。
   - 关于任务清单中的厂商名称：`本组-test-task-inventory` 里出现的厂商名**仅为测试提问的话题文本**，与被测宿主、计价档位、接入模型均无关；为保证据可复现，此处**原样保留不作替换**，请勿据此推断测试所用宿主或厂商。
2. **不报金额**：证据包内不含任何费用明细、计价明细与成本换算数据。README 与社区帖同样只报命中率与相对比例。
3. **不宣称提升**：本组 数字用于说明"挂载 vs 不挂载"的差异；v0.4.4 相对 v0.4.3 命中行为一致，**不构成版本提升**。
4. **同一形态内可比，跨形态不可混比**：请求端形态不同（白盒直连 / 官方 Harness headless / 编码 CLI），对照组的起点会天然不同（0% 与 66%–68% 就是形态差异，不是方案差异），因此只能比较**同一形态内部**的"挂 vs 不挂"；跨形态数字不得横向换算成"提升幅度"。
5. **三种形态的对照组起点为何不同（根因）**：
   - **形态 A 的 0% 是结构性零基线**：该请求端是 DoboCache **自研的白盒测试底座**，为跑对照实验自己写的直连客户端，**不做任何前缀处理**（不构造前缀、不预热缓存、不复用会话），每轮只发「任务原文 + 随机噪音」。请求端本身没有可复用前缀，命中自然恒为 0——不是"缓存被打崩"，也不是"对照组被打压"。
   - **形态 B 的 66%–68% 来自官方前缀，与本方案无关**：该请求端是厂商 D 的官方客户端（headless），每次新会话自带约 **2,560 tokens 的厂商全局系统前缀**。实验 033 的累计命中 51,200 tokens 恰等于 **2,560 × 20**（分母 77,576），可直接在 CSV 同行的 token 列上除一遍验证。
   - **形态 C 介于两者之间且不稳定**：编码 CLI 无固定系统前缀，仅当历史长前缀自然稳定时才偶发命中（组 7 的 R10 / R20；组 8 全 0）。
   - 结论：**对照组的起点 = 请求端自身的前缀处理能力**。官方客户端有官方前缀垫底，自研白盒底座刻意什么都不做，编码 CLI 居中且飘。因此跨形态只能看量级，不能相减。

### 补充：这套证据覆盖多大、没覆盖什么

- **组数**：8 组对照实验（组 1–组 8），正式组每组 20 次连续请求，另有两组 5 次、10 次的前期门槛探测。
- **单轮体量**：每轮输入是同一份 AI 资讯盘点话题，前缀几百到数千 tokens，逐次 usage 见本目录 CSV。
- **没覆盖**：单轮上万 tokens 的长文档问答、整库代码分析、几十轮超长会话这类**长任务**。缓存前缀复用在这种体量下是否同样成立，本证据包**不作任何结论**。
- 如果你用长任务复跑，把逐次 usage 记成同格式 CSV 反馈即可，口径与本目录一致。

## 三、最短核对路径

```powershell
cd <解压后的仓库根目录>   # 即同时包含 release\ 与 dist\ 的那一层，路径请替换为你自己的绝对路径
# 1) 看逐次数据（组 8 / 组 7）
Import-Csv release\testdata\hitrate-testdata-20261103.csv | Format-Table round,raw_tokens,opt_tokens,hit_rate
Import-Csv release\testdata\hitrate-testdata-glm-v042-20261103.csv | Format-Table round,baseline_hit_rate,opt_hit_rate
# 1b) 看跨形态汇总（形态 A/B 行自带 token 列，可直接除出百分比）
Import-Csv release\testdata\hitrate-multi-platform-summary-20261105.csv | Format-Table source_exp,version,baseline_hit_rate,opt_hit_rate,baseline_hit_tokens,baseline_prompt_tokens,opt_hit_tokens,opt_prompt_tokens
# 2) 重绘两张对照图（输出到 release\hitrate-comparison.png 与 release\hitrate-comparison-platforms.png）
python release\scripts\hitrate-comparison.py
# 3) 核对逐次数据里是否混入提问原文（应无任何输出）
Select-String -Path release\testdata\hitrate-testdata-20261103.csv -Pattern '请综述|简述'
```

第 3 条命令应无输出——证据包里只有数值与任务类别列，不含提问原文。第 2 步需要 Python 与 `matplotlib`（`pip install matplotlib`）；只做第 1、3 步则只需 PowerShell 自带 cmdlet。

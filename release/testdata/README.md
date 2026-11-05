# testdata — 本组可复现实验证据包

本目录是 DoboCache v0.4.7 公开发布随附的**证据包**：本组实验的全部原始材料都在这里，README 正文引用的每一个数字都能在此逐项核对。

## 一、包含什么

| 文件 | 内容 | 支撑 README 中的哪个数字 |
|---|---|---|
| `hitrate-regression-report-20261103.md` | 本组回归报告：测试设置、门槛修复前后对照、20 次逐次结果、与早期一轮实测的对照判读、判读标准逐条核对 | 实验组均值 98.59%、区间 96.08%–99.79%、对照组 20/20 全 0、前缀就绪 20/20、`effectiveMinPrefixTokens=3450` |
| `hitrate-task-inventory-20261103.md` | 组 1→组 8 共 8 组实验的任务清单、20 次任务**原文**、复跑要点、各组结果汇总 | 说明"测的是什么任务、怎么测、测了多少次请求"；第 1–20 次任务原文 |
| `hitrate-testdata-20261103.csv` | 20 次逐次数据：`round,text_type,raw_tokens,opt_tokens,hit_rate,saved_tokens,platform`（`round` 为列名，语义是"第几次请求"） | `hitrate-comparison.png` 的全部数据来源 |
| `复跑说明.md` | 从零复现的操作步骤、验收标准、四个常见踩坑、字段说明、重绘命令 | README「如何复现」章节的详细版 |



## 二、口径说明（重要）

1. **测试宿主匿名**：全部材料中被测宿主统一称「某常见编码 CLI 工具」，模型厂商以代号出现（厂商 D / 厂商 G）。任务原文中出现的公司/产品名属**对话话题内容**（20 次请求为 AI 资讯盘点话题），不是被测宿主指代。
   - 关于任务清单中的厂商名称：`本组-test-task-inventory` 里出现的厂商名**仅为测试提问的话题文本**，与被测宿主、计价档位、接入模型均无关；为保证据可复现，此处**原样保留不作替换**，请勿据此推断测试所用宿主或厂商。
2. **不报金额**：证据包内不含任何费用明细、计价明细与成本换算数据。README 与社区帖同样只报命中率与相对比例。
3. **不宣称提升**：本组 数字用于说明"挂载 vs 不挂载"的差异；v0.4.4 相对 v0.4.3 命中行为一致，**不构成版本提升**。
4. **不混比**：本组与早期各轮实测的接入方式、厂商门槛不同，数字不可横向换算或混比。

## 三、最短核对路径

```powershell
cd <解压后的仓库根目录>   # 即同时包含 release\ 与 dist\ 的那一层，路径请替换为你自己的绝对路径
# 1) 看逐次数据
Import-Csv release\testdata\hitrate-testdata-20261103.csv | Format-Table round,raw_tokens,opt_tokens,hit_rate
# 2) 重绘对照图（输出到 release\hitrate-comparison.png）
python release\scripts\hitrate-comparison.py
# 3) 核对逐次数据里是否混入提问原文（应无任何输出）
Select-String -Path release\testdata\hitrate-testdata-20261103.csv -Pattern '请综述|简述'
```

第 3 条命令应无输出——证据包里只有数值与任务类别列，不含提问原文。第 2 步需要 Python 与 `matplotlib`（`pip install matplotlib`）；只做第 1、3 步则只需 PowerShell 自带 cmdlet。

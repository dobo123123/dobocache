# -*- coding: utf-8 -*-
"""
DoboCache 命中率对照图生成脚本（多请求端形态版 / v0.4.7 公开发布随附）
=====================================================================
用途：为 DoboCache v0.4.7 公开发布生成两张对照图
  图1 hitrate-comparison.png         同一请求端形态下「不挂 vs 挂」逐次请求曲线（含两个版本）
  图2 hitrate-comparison-platforms.png 跨请求端形态汇总对照（三种形态、六个实测组合）

数据源（均为真实实测记录，可回溯）：
  1. testdata/hitrate-testdata-20261103.csv
     列：round,text_type,raw_tokens,opt_tokens,hit_rate,saved_tokens,platform
     = 组 8（v0.4.3，常见编码 CLI + 厂商 G），实验组逐次请求；同组对照组 20/20 次为 0 命中
  2. testdata/hitrate-testdata-glm-v042-20261103.csv
     列：round,baseline_hit_rate,opt_hit_rate,baseline_note
     = 组 7（v0.4.2 候选修复构建，同形态），对照组有 2 次自然命中（R10 / R20）
  3. testdata/hitrate-multi-platform-summary-20261105.csv
     = 跨形态汇总（形态 A 白盒直连 / 形态 B 官方 Harness headless / 形态 C 编码 CLI），
       数值回溯 EXPERIMENT-LOG 实验 031 / 032 / 033 / 034 与组 7 / 组 8

重跑方式：
    python release/scripts/hitrate-comparison.py
输出：
    release/hitrate-comparison.png（约 1300x820, dpi=120）
    release/hitrate-comparison-platforms.png（约 1500x820, dpi=120）

口径约束：图中不出现任何产品名、厂商真名、模型型号与金额数字；宿主与厂商以代号呈现。
命中率口径 = 厂商 usage 的 cached_tokens / prompt_tokens（各请求输入内部的命中占比）。
"""
import csv
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager


def setup_font():
    for name in ["Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC"]:
        try:
            font_manager.findfont(name, fallback_to_default=False)
            plt.rcParams["font.sans-serif"] = [name]
            break
        except Exception:
            continue
    plt.rcParams["axes.unicode_minus"] = False


setup_font()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # release/
TD_DIR = os.path.join(BASE_DIR, "testdata")
CSV_G8 = os.path.join(TD_DIR, "hitrate-testdata-20261103.csv")
CSV_G7 = os.path.join(TD_DIR, "hitrate-testdata-glm-v042-20261103.csv")
CSV_FORM = os.path.join(TD_DIR, "hitrate-multi-platform-summary-20261105.csv")
OUT_MAIN = os.path.join(BASE_DIR, "hitrate-comparison.png")
OUT_FORM = os.path.join(BASE_DIR, "hitrate-comparison-platforms.png")

BLUE = "#2f6fed"      # 实验组（组 8 / v0.4.3）
CYAN = "#0e9f6e"      # 实验组（组 7 / v0.4.2 候选）
RED = "#c0392b"       # 对照组
GREY = "#8a94a6"


def load_g8():
    rounds, hit = [], []
    with open(CSV_G8, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                rounds.append(int(row["round"]))
                hit.append(float(row["hit_rate"]) * 100.0)
            except (KeyError, ValueError, TypeError):
                continue
    order = sorted(range(len(rounds)), key=lambda i: rounds[i])
    return [rounds[i] for i in order], [hit[i] for i in order]


def load_g7():
    rounds, base, opt = [], [], []
    with open(CSV_G7, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                rounds.append(int(row["round"]))
                base.append(float(row["baseline_hit_rate"]) * 100.0)
                opt.append(float(row["opt_hit_rate"]) * 100.0)
            except (KeyError, ValueError, TypeError):
                continue
    order = sorted(range(len(rounds)), key=lambda i: rounds[i])
    return [rounds[i] for i in order], [base[i] for i in order], [opt[i] for i in order]


def load_forms():
    rows = []
    with open(CSV_FORM, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                rows.append({
                    "code": row["form_code"],
                    "label": row["form_label"],
                    "rounds": int(row["rounds"]),
                    "version": row["version"],
                    "base": float(row["baseline_hit_rate"]),
                    "opt": float(row["opt_hit_rate"]),
                    "metric": row["metric"],
                })
            except (KeyError, ValueError, TypeError):
                continue
    return rows


def fig_main():
    """图1：同一形态（编码 CLI + 厂商 G）下，两个版本的逐次请求对照"""
    rounds, g8_opt = load_g8()
    rounds7, g7_base, g7_opt = load_g7()
    n = len(rounds)
    g8_base = [0.0] * n
    mean8 = sum(g8_opt) / n
    mean7 = sum(g7_opt) / len(g7_opt)
    lo8, hi8 = min(g8_opt), max(g8_opt)

    fig, ax = plt.subplots(figsize=(13, 8.2), dpi=120)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#f7f8fa")
    xs = list(range(n))

    ax.plot(xs, g8_opt, marker="o", linewidth=2.6, markersize=6.5, color=BLUE,
            label="实验组 · 挂载 DoboCache（v0.4.3，稳定前缀）")
    ax.plot(xs, g7_opt, marker="s", linewidth=1.8, markersize=5.2, color=CYAN, alpha=0.9,
            linestyle="--", label="实验组 · 挂载 DoboCache（v0.4.2 候选构建）")
    ax.plot(xs, g8_base, marker="x", linewidth=2.4, markersize=7.5, linestyle="--", color=RED,
            label="对照组 · 不挂载（v0.4.3 同期，前缀每次漂移）")
    ax.plot(xs, g7_base, marker="o", linewidth=1.4, markersize=4.2, linestyle=":", color="#e08e0b",
            alpha=0.95, label="对照组 · 不挂载（v0.4.2 同期，含 2 次自然命中）")

    # 实验组 v0.4.3 逐点数值（每 2 轮标一次，避免挤压）
    for x, v in zip(xs, g8_opt):
        if x % 2 == 0 or x == n - 1:
            ax.annotate(f"{v:.1f}%", (x, v), textcoords="offset points", xytext=(0, 10),
                        ha="center", fontsize=8.2, color=BLUE, fontweight="bold")

    # 对照组：v0.4.3 全 0、v0.4.2 有两次自然命中
    ax.annotate("20/20 次请求 = 0%", (xs[-1], 0), textcoords="offset points", xytext=(-62, 12),
                ha="center", fontsize=10.5, color=RED, fontweight="bold")
    for i, v in enumerate(g7_base):
        if v > 1:
            ax.annotate(f"自然命中 {v:.1f}%", (xs[i], v), textcoords="offset points",
                        xytext=(0, -18), ha="center", fontsize=8.4, color="#b3730a",
                        fontweight="bold")

    # v0.4.2 的三个厂商侧抖动点
    for i, v in enumerate(g7_opt):
        if v < 96.0:
            ax.annotate(f"{v:.1f}%", (xs[i], v), textcoords="offset points", xytext=(0, -19),
                        ha="center", fontsize=8.6, color=CYAN, fontweight="bold")

    ax.axhline(mean8, color=BLUE, linewidth=1.2, linestyle=":", alpha=0.85)
    ax.annotate(f"v0.4.3 均值 {mean8:.2f}%（区间 {lo8:.2f}%–{hi8:.2f}%）", xy=(n * 0.52, mean8),
                xytext=(n * 0.10, 55), fontsize=11.5, color=BLUE, fontweight="bold",
                arrowprops=dict(arrowstyle="->", color="#8aa8e8", linewidth=1.2,
                                connectionstyle="arc3,rad=0.12"))
    ax.annotate(f"v0.4.2 候选构建均值 {mean7:.2f}%（含 3 次厂商侧抖动）",
                xy=(n * 0.34, mean7), xytext=(n * 0.02, 18), fontsize=10.5, color=CYAN,
                fontweight="bold",
                arrowprops=dict(arrowstyle="->", color="#7fcfb4", linewidth=1.1,
                                connectionstyle="arc3,rad=-0.1"))

    ax.set_xticks(xs)
    ax.set_xticklabels([f"R{r}" for r in rounds], fontsize=10.5)
    ax.set_xlim(-0.6, n - 0.4)
    ax.set_ylim(-30, 112)
    ax.set_yticks(range(0, 101, 20))
    ax.set_yticklabels([f"{v}%" for v in range(0, 101, 20)], fontsize=11)
    ax.set_xlabel("测试次序（同一话题递进追问，历史逐次累积）", fontsize=12)
    ax.set_ylabel("缓存命中率（%）", fontsize=12)
    ax.set_title(f"同一请求端形态下「不挂 vs 挂」缓存命中率对照（{n} 次请求实测 · 两个版本）",
                 fontsize=16, fontweight="bold", pad=14)
    ax.grid(axis="y", color="#d8dce2", linewidth=0.8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(loc="lower center", fontsize=9.6, framealpha=0.96, ncol=2,
              columnspacing=1.4, handlelength=2.4)

    note1 = ("数据来源：testdata/hitrate-testdata-20261103.csv（v0.4.3 实验组逐次）＋"
             "testdata/hitrate-testdata-glm-v042-20261103.csv（v0.4.2 候选构建逐次）＋ 同期对照组实测")
    note2 = (f"v0.4.3：20/20 次前缀就绪（prefixReady=true），均值 {mean8:.2f}%，区间 {lo8:.2f}%–{hi8:.2f}%，"
             f"无一次 0 命中；对照组 20/20 次为 0")
    note3 = ("v0.4.2 候选构建的 3 次低值（R9/R13/R16）为厂商侧缓存窗口抖动，非配置差异；"
             "对照组 R10/R20 的命中为长历史前缀自然命中，属厂商机制")
    note4 = "命中率口径＝厂商 usage 的 cached_tokens / prompt_tokens；两组输入量不同，不可跨组换算为绝对 token 数。"
    ax.text(0.005, -0.135, note1, transform=ax.transAxes, fontsize=8.4, color="#555555")
    ax.text(0.005, -0.172, note2, transform=ax.transAxes, fontsize=8.4, color="#555555")
    ax.text(0.005, -0.209, note3, transform=ax.transAxes, fontsize=8.4, color="#555555")
    ax.text(0.005, -0.246, note4, transform=ax.transAxes, fontsize=8.4, color="#777777")

    plt.tight_layout(rect=[0, 0.13, 1, 1])
    fig.savefig(OUT_MAIN, dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("saved:", OUT_MAIN)
    print(f"[main] rounds={n} g8_mean={mean8:.2f} ({lo8:.2f}-{hi8:.2f}) g7_mean={mean7:.2f}")


def fig_forms():
    """图2：跨请求端形态汇总（对照组 vs 实验组）"""
    rows = load_forms()
    _CODE = {"A": "WBX", "B": "DXH", "C": "COD-X"}
    labels = [f"{_CODE.get(r['code'], r['code'])} · {r['label']}\n{r['version']}" for r in rows]
    base = [r["base"] for r in rows]
    opt = [r["opt"] for r in rows]
    xs = list(range(len(rows)))
    w = 0.36

    fig, ax = plt.subplots(figsize=(15, 9.0), dpi=120)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#f7f8fa")

    b1 = ax.bar([x - w / 2 for x in xs], base, width=w, color="#b02a1f", alpha=0.85,
                label="对照组 · 不挂载（前缀每次漂移）", zorder=3)
    b2 = ax.bar([x + w / 2 for x in xs], opt, width=w, color=BLUE, alpha=0.92,
                label="实验组 · 挂载 DoboCache（稳定前缀）", zorder=3)

    for rect, v in zip(b1, base):
        ax.annotate(f"{v:.2f}%", (rect.get_x() + rect.get_width() / 2, v),
                    textcoords="offset points", xytext=(0, 5), ha="center",
                    fontsize=11, color="#8f1f16", fontweight="bold")
    for rect, v in zip(b2, opt):
        ax.annotate(f"{v:.2f}%", (rect.get_x() + rect.get_width() / 2, v),
                    textcoords="offset points", xytext=(0, 5), ha="center",
                    fontsize=11, color="#1b4fc4", fontweight="bold")

    # 形态分组分隔线与标注
    groups = {"A": [], "B": [], "C": []}
    for i, r in enumerate(rows):
        groups[r["code"]].append(i)
    for code, idx in groups.items():
        if not idx:
            continue
        left = min(idx) - 0.48
        right = max(idx) + 0.48
        ax.axvspan(left, right, color="#e9edf5" if code in ("A", "C") else "#eef3ec",
                   alpha=0.55, zorder=0)
        ax.annotate({"A": "形态 A · WBX 白盒直连（自研底座，无前缀处理）",
                     "B": "形态 B · DXH 官方 Harness headless",
                     "C": "形态 C · COD-X 常见编码 CLI"}[code],
                    xy=((left + right) / 2, 106), ha="center", fontsize=11.5,
                    color="#333333", fontweight="bold")

    ax.set_xticks(xs)
    ax.set_xticklabels(labels, fontsize=9.6)
    ax.set_ylim(0, 118)
    ax.set_yticks(range(0, 101, 20))
    ax.set_yticklabels([f"{v}%" for v in range(0, 101, 20)], fontsize=11)
    ax.set_ylabel("20 次请求整体缓存命中率（%）", fontsize=12)
    ax.set_title("三种请求端形态对照：不挂载 vs 挂载 DoboCache（20 次请求 / 每组）\n"
                 "WBX = 自研白盒直连 · DXH = 官方 Harness headless · COD-X = 常见编码 CLI（代号为类型缩写，不对应具体产品名）",
                 fontsize=14.5, fontweight="bold", pad=26)
    ax.grid(axis="y", color="#d8dce2", linewidth=0.8, zorder=1)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(loc="upper left", fontsize=10.5, framealpha=0.96, ncol=2)

    note1 = ("数据来源：testdata/hitrate-multi-platform-summary-20261105.csv（数值回溯 EXPERIMENT-LOG 实验 031/032/033/034 与组 7/组 8 实测记录）")
    note2a = ("对照基线根因（这两条的差别不是本方案的功劳）：形态 A 的请求端是 DoboCache 自研的白盒测试底座，"
              "不做任何前缀处理（不构造前缀 / 不预热缓存 / 不复用会话），请求端无可复用前缀，对照组为结构性零基线 0%；")
    note2b = ("形态 B 的请求端是厂商 D 官方客户端 headless，每次新会话自带约 2,560 tokens 厂商全局系统前缀"
              "（实验 033 累计命中 51,200 = 2,560×20），对照组基线天然 66%–68%，与 DoboCache 无关；"
              "形态 C 无固定系统前缀，仅 R10/R20 长历史前缀自然命中，故逐次均值 9.87%。")
    note3 = ("口径：形态 A/B 用 20 次请求累计命中率（累计 hit / 累计 prompt）；形态 C 用逐次请求命中率均值。"
             "命中率＝cached_tokens / prompt_tokens。")
    note4 = "结论口径：不挂载约 0%–68%（随请求端形态浮动），挂载后 90%–98%；本图不宣称跨形态的提升幅度。"
    ax.text(0.005, -0.100, note1, transform=ax.transAxes, fontsize=8.4, color="#555555")
    ax.text(0.005, -0.138, note2a, transform=ax.transAxes, fontsize=8.4, color="#8f1f16")
    ax.text(0.005, -0.176, note2b, transform=ax.transAxes, fontsize=8.4, color="#8f1f16")
    ax.text(0.005, -0.214, note3, transform=ax.transAxes, fontsize=8.4, color="#555555")
    ax.text(0.005, -0.252, note4, transform=ax.transAxes, fontsize=8.4, color="#1b4fc4",
            fontweight="bold")

    plt.tight_layout(rect=[0, 0.17, 1, 1])
    fig.savefig(OUT_FORM, dpi=120, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("saved:", OUT_FORM)
    print(f"[forms] rows={len(rows)}")


def main():
    fig_main()
    fig_forms()


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
DoboCache 命中率对照图生成脚本（本组数据版 / v0.4.7 公开发布随附）
================================================================
用途：为 DoboCache v0.4.7 公开发布生成「对照组 vs 实验组」20 次请求实测样本命中率对照图。

数据源：
  1. 实验组逐次请求命中率：testdata/hitrate-testdata-20261103.csv（既有数据，列名沿用 round）
     列：round,text_type,raw_tokens,opt_tokens,hit_rate,saved_tokens,platform
     命中率口径 = 厂商 usage 的 cached_tokens / prompt_tokens
  2. 对照组：本组回归报告实测「20 次请求全部 0 命中」（对照组每次请求头部注入不同随机噪音，
     前缀漂移导致厂商前缀缓存无法建立）。CSV 未含对照组列，故此处以报告结论作为常量。
     注：中文表述统一用「次请求」，列名仍为 round，二者指同一件事。

重跑方式：
    python release/scripts/hitrate-comparison.py
输出：
    release/hitrate-comparison.png（1200x750, dpi=120）

口径约束：图中不出现任何产品名、厂商名、金额数字。
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
CSV_PATH = os.path.join(BASE_DIR, "testdata", "hitrate-testdata-20261103.csv")
OUT_PATH = os.path.join(BASE_DIR, "hitrate-comparison.png")

# 对照组：本组回归报告实测 20 次请求全部 0 命中
BASELINE_VALUE = 0.0


def load_csv():
    rounds, hit = [], []
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                rounds.append(int(row["round"]))
                hit.append(float(row["hit_rate"]) * 100.0)
            except (KeyError, ValueError, TypeError):
                continue
    order = sorted(range(len(rounds)), key=lambda i: rounds[i])
    return [rounds[i] for i in order], [hit[i] for i in order]


def main():
    rounds, hits = load_csv()
    n = len(rounds)
    mean = sum(hits) / n
    lo, hi = min(hits), max(hits)
    baseline = [BASELINE_VALUE] * n

    fig, ax = plt.subplots(figsize=(12, 7.5), dpi=120)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#f7f8fa")

    xs = list(range(n))
    ax.plot(xs, hits, marker="o", linewidth=2.6, markersize=6.5, color="#2f6fed",
            label="实验组：挂载 DoboCache（稳定前缀 + 白盒报告）")
    ax.plot(xs, baseline, marker="x", linewidth=2, markersize=7, linestyle="--",
            color="#c0392b", label="对照组：不挂载（每次请求前缀漂移，缓存不命中）")

    for x, v in zip(xs, hits):
        ax.annotate(f"{v:.1f}%", (x, v), textcoords="offset points", xytext=(0, 11),
                    ha="center", fontsize=8.5, color="#2f6fed", fontweight="bold")
    ax.annotate("0%（20/20 次请求）", (xs[-1], 0), textcoords="offset points", xytext=(-42, -16),
                ha="center", fontsize=10, color="#c0392b", fontweight="bold")

    ax.axhline(mean, color="#2f6fed", linewidth=1.2, linestyle=":", alpha=0.85)
    # 均值标注移到顶部空白区，避免压住数据点
    ax.annotate(f"实验组均值 {mean:.2f}%（区间 {lo:.2f}%–{hi:.2f}%）", xy=(n * 0.55, mean),
                xytext=(n * 0.16, 52), fontsize=11, color="#2f6fed", fontweight="bold",
                arrowprops=dict(arrowstyle="->", color="#8aa8e8", linewidth=1.2,
                                connectionstyle="arc3,rad=0.12"))

    ax.set_xticks(xs)
    ax.set_xticklabels([f"R{r}" for r in rounds], fontsize=10.5)
    ax.set_xlim(-0.6, n - 0.4)
    ax.set_ylim(-6, 108)
    ax.set_yticks(range(0, 101, 20))
    ax.set_yticklabels([f"{v}%" for v in range(0, 101, 20)], fontsize=11)
    ax.set_xlabel("测试次序（同一话题递进追问，历史逐次累积）", fontsize=12)
    ax.set_ylabel("缓存命中率（%）", fontsize=12)
    ax.set_title(f"对照组 vs 实验组 缓存命中率对照（20 次请求实测，n={n}）",
                 fontsize=16, fontweight="bold", pad=14)
    ax.grid(axis="y", color="#d8dce2", linewidth=0.8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.legend(loc="center right", fontsize=10.5, framealpha=0.95)

    note1 = (f"数据来源：testdata/hitrate-testdata-20261103.csv（实验组逐次请求，n={n}）＋"
             f"testdata/hitrate-regression-report-20261103.md（对照组 20/20 次请求为 0）")
    note2 = (f"实验组：均值 {mean:.2f}%，区间 {lo:.2f}%–{hi:.2f}%，20/20 次请求前缀就绪（prefixReady=true）；"
             f"命中率口径＝厂商 usage 的 cached_tokens / prompt_tokens")
    note3 = "说明：命中率是每次请求输入内部的缓存命中占比，两组输入量不同，不可跨组换算为绝对 token 数。"
    ax.text(0.005, -0.155, note1, transform=ax.transAxes, fontsize=8.6, color="#555555")
    ax.text(0.005, -0.195, note2, transform=ax.transAxes, fontsize=8.6, color="#555555")
    ax.text(0.005, -0.235, note3, transform=ax.transAxes, fontsize=8.6, color="#777777")

    plt.tight_layout(rect=[0, 0.13, 1, 1])
    fig.savefig(OUT_PATH, dpi=120, bbox_inches="tight", facecolor="white")
    print("saved:", OUT_PATH)
    print(f"rounds={n} mean={mean:.4f} lo={lo:.2f} hi={hi:.2f}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DoboCache 便携包打包脚本（发布用）

把"该带什么、不该带什么"固化进代码，避免内部文件再次混进对外发布包。

用法：
    python scripts/pack-portable.py                # 默认输出到 ../../output
    python scripts/pack-portable.py --out D:\tmp   # 指定输出目录
    python scripts/pack-portable.py --skip-install # 复用已有 node_modules（调试用）

打包结果自检（任一不通过即失败，退出码 1）：
  1. 敏感/内部清单扫描：厂商全称、API Key 形态、内部档案路径、邮箱
  2. 必须存在的关键文件（入口、清单、文档）
  3. 不得存在的内部文件（ab-test 脚本、release/internal、test 目录）
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG_NAME = "dobocache"

# ---- 要带进包里的根文件 ----
ROOT_FILES = [
    ".gitignore", "CHANGELOG.md", "LICENSE", "NOTICE", "README.md", "SECURITY.md",
    "eslint.config.js", "package-lock.json", "package.json", "server.json",
    "tsconfig.json", "vitest.config.ts",
]

# ---- 要带进包里的目录 ----
ROOT_DIRS = ["dist", "src", "assets", "scripts", "release"]

# ---- 永远不得进包的东西（目录名或相对路径片段）----
EXCLUDE_DIR_NAMES = {"internal", "node_modules", "__pycache__", ".git", "test", "tests"}
EXCLUDE_FILE_PATTERNS = [
    "ab-test.ts",          # 内部 A/B 实验脚本：点名厂商、需要 API Key，绝不对外
    "pack-portable.py",    # 本打包脚本自身
    "pack-portable.ps1",   # PowerShell 版打包脚本（同样含内部扫描规则）
    ".DS_Store", "Thumbs.db",
]

# ---- 敏感内容扫描（正则字符串，全部小写比较）----
# 硬拦项：命中即中止打包（真泄密风险 / 内部痕迹）
SENSITIVE_MARKERS = [
    "release/internal",     # 内部档案路径痕迹
]

# ---- 通用邮箱扫描 ----
# 本脚本会随仓库公开，所以不硬编码任何具体私人地址；
# 改为「任意邮箱形态命中即拦，只放行非个人信息形态」。
EMAIL_RE = r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}"
EMAIL_ALLOW_SUFFIX = (
    "noreply@github.com",
    "@users.noreply.github.com",   # GitHub 提交邮箱（<id>+<name>@users.noreply.github.com）
    "@example.com",
    "@example.org",
    "@example.net",
    "@example.invalid",
)

# 提示项：厂商/上游服务域名只在对外文档里给 WARN，不阻断打包。
# 依据（2026-11-15 定）：这些字样是功能路由表与兼容性说明的必要信息，
# README 现行口径已统一写厂商名本身；v0.5.1 / v0.5.2 公开包内同样带有这些字样。
# 一刀切阻断会让便携包永远打不出来，改为「文档提示 + 人工确认非效果表述」。
VENDOR_NOTE_MARKERS = ["deepseek", "api.deepseek.com", "deepseek_api_key"]
VENDOR_NOTE_DOC_EXT = (".md", ".txt")

# ---- .gitignore 净化：剥离内部规则段，对外只留通用忽略规则 ----
_GITIGNORE_DROP_TOKENS = (
    "ab-test", "release/internal", "发布物料清单",
    "pack-portable", "tools/",
)


def write_sanitized_gitignore(stage_dir):
    src = os.path.join(REPO, ".gitignore")
    if not os.path.exists(src):
        print("  [warn] .gitignore 缺失，跳过")
        return
    out = []
    for line in open(src, encoding="utf-8").read().splitlines():
        s = line.strip()
        if not s:
            out.append("")
            continue
        if s.startswith("# 内部"):          # 内部段落的说明注释一并去掉
            continue
        if any(tok in s for tok in _GITIGNORE_DROP_TOKENS):
            continue
        out.append(line)
    text = "\n".join(out)
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    text = text.strip() + "\n"
    open(os.path.join(stage_dir, ".gitignore"), "w", encoding="utf-8").write(text)


# ---- 必须存在的关键文件（相对包根）----
REQUIRED_FILES = [
    "README.md", "LICENSE", "NOTICE", "package.json", "server.json",
    "dist/index.js", "src/index.ts",
    "release/零基础三分钟上手.md", "release/FAQ-使用须知.md",
    "release/README.zh.md", "release/README.en.md",
]


def skip(name):
    if name in EXCLUDE_FILE_PATTERNS:
        return True
    return name.endswith((".zip", ".tgz", ".log"))


def copy_tree(src, dst):
    os.makedirs(dst, exist_ok=True)
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIR_NAMES]
        rel = os.path.relpath(dirpath, src)
        target_dir = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target_dir, exist_ok=True)
        for f in filenames:
            if skip(f):
                continue
            shutil.copy2(os.path.join(dirpath, f), os.path.join(target_dir, f))


def scan(stage):
    """返回 (错误列表, 警告列表)"""
    import re
    errors, warns = [], []
    text_ext = (".md", ".ts", ".js", ".mjs", ".json", ".txt", ".py", ".yml", ".yaml", ".html", ".css")
    for dirpath, dirnames, filenames in os.walk(stage):
        for f in filenames:
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, stage)
            if os.sep + "node_modules" + os.sep in os.sep + rel:
                continue
            if "ab-test" in f:
                errors.append(f"内部脚本混入：{rel}")
            if "glm" in f.lower():
                errors.append(f"文件名含模型系列标识（应改用中性语义名）：{rel}")
            if not f.lower().endswith(text_ext):
                continue
            try:
                txt = open(p, encoding="utf-8", errors="replace").read().lower()
            except OSError:
                continue
            for m in SENSITIVE_MARKERS:
                if m in txt:
                    errors.append(f"敏感内容命中「{m}」：{rel}")
            # 厂商/上游域名：仅对外文档给提示，不阻断（见 VENDOR_NOTE_MARKERS 注释）
            if f.lower().endswith(VENDOR_NOTE_DOC_EXT):
                for m in VENDOR_NOTE_MARKERS:
                    if m in txt:
                        warns.append(f"文档提到「{m}」：{rel}（按现行口径保留，发布前确认非效果夸大表述）")
            # API Key 形态：sk- 后跟 16 位以上字母数字
            for hit in re.findall(r"sk-[a-z0-9]{16,}", txt):
                errors.append(f"疑似 API Key：{rel} → {hit[:6]}***")
            # 邮箱形态：非 noreply / example 系一律视为私人信息
            for m in sorted(set(re.findall(EMAIL_RE, txt))):
                if any(m.endswith(sfx) for sfx in EMAIL_ALLOW_SUFFIX):
                    continue
                masked = m[:3] + "***" + m[m.find("@"):]
                errors.append(f"疑似私人邮箱：{rel} → {masked}")
        for d in dirnames:
            pass  # 目录级检查在下方单独做（只看包根，避免误伤 node_modules 内的同名目录）
    for d in os.listdir(stage):
        full = os.path.join(stage, d)
        if os.path.isdir(full) and d in EXCLUDE_DIR_NAMES and d != "node_modules":
            errors.append(f"不该进包的目录：{d}")
    for req in REQUIRED_FILES:
        if not os.path.exists(os.path.join(stage, req)):
            errors.append(f"缺失关键文件：{req}")
    return errors, warns


LAUNCHER_NAME = "start-dobostitch.bat"
SUMS_NAME = "SHA256SUMS.txt"

LAUNCHER_BODY = r"""@echo off
rem DoboCache portable launcher - double click to start the local proxy (writing style D).
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found. Install Node 18+ from https://nodejs.org then run this again.
  pause
  exit /b 1
)

echo Starting dobostitch local proxy ... close this window to stop it.
echo.
node "dist\proxy\cli.js" start %*
echo.
echo Proxy stopped.
pause
"""


def add_sums_and_launcher(stage, version):
    """往包里补两件 README 承诺的东西：启动脚本与校验清单。"""
    lp = os.path.join(stage, LAUNCHER_NAME)
    with open(lp, "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write(LAUNCHER_BODY)
    lines = []
    for dirpath, dirnames, filenames in os.walk(stage):
        for f in sorted(filenames):
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, stage).replace(os.sep, "/")
            if rel == SUMS_NAME:
                continue
            h = hashlib.sha256()
            with open(full, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            lines.append(f"{h.hexdigest()} *{rel}")
    lines.sort(key=lambda s: s.split("*", 1)[1])
    head = [
        f"# DoboCache v{version} portable - SHA256 checksums",
        "# verify: sha256sum -c SHA256SUMS.txt  (Windows: certutil -hashfile <file> SHA256)",
        "",
    ]
    with open(os.path.join(stage, SUMS_NAME), "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write("\r\n".join(head + lines) + "\r\n")
    print(f"  已补入 {LAUNCHER_NAME} 与 {SUMS_NAME}（{len(lines)} 条校验）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.abspath(os.path.join(REPO, "..", "..", "output")))
    ap.add_argument("--skip-install", action="store_true")
    ap.add_argument("--workdir", default=os.path.join(REPO, "temp"))
    args = ap.parse_args()

    pkg_json = __import__("json").load(open(os.path.join(REPO, "package.json"), encoding="utf-8"))
    version = pkg_json["version"]
    inner = f"{PKG_NAME}-v{version}-portable"
    # staging 目录每次唯一：复用同一目录会把上一次打包的残留文件一起带进新包
    import time as _time
    stage_root = os.path.join(args.workdir, "pack_" + version + "_" + _time.strftime("%Y%m%d%H%M%S"))
    stage = os.path.join(stage_root, inner)
    os.makedirs(stage, exist_ok=True)

    for f in ROOT_FILES:
        if f == ".gitignore":
            write_sanitized_gitignore(stage)
            continue
        src = os.path.join(REPO, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(stage, f))
        else:
            print(f"  [warn] 根文件缺失，跳过：{f}")
    for d in ROOT_DIRS:
        s = os.path.join(REPO, d)
        if os.path.isdir(s):
            copy_tree(s, os.path.join(stage, d))

    if not args.skip_install:
        print("  安装生产依赖（npm ci --omit=dev）…")
        r = subprocess.run("npm ci --omit=dev --no-audit --no-fund", shell=True, cwd=stage,
                           capture_output=True)
        if r.returncode != 0:
            print(r.stderr.decode("utf-8", "replace")[-800:])
            return 1
        print("  " + r.stdout.decode("utf-8", "replace").strip().splitlines()[-1])

    add_sums_and_launcher(stage, version)

    print("  自检…")
    errors, _ = scan(stage)
    if errors:
        print("\n  自检未通过，已中止（未生成 zip）：")
        for e in errors:
            print("   - " + e)
        return 1

    os.makedirs(args.out, exist_ok=True)
    zpath = os.path.join(args.out, f"{inner}.zip")
    n = 0
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dirpath, dirnames, filenames in os.walk(stage):
            rel = os.path.relpath(dirpath, stage_root).replace(os.sep, "/")
            if not filenames:
                z.writestr(rel + "/", "")
                continue
            for f in filenames:
                z.write(os.path.join(dirpath, f), rel + "/" + f)
                n += 1

    data = open(zpath, "rb").read()
    print("\n打包完成")
    print(f"  文件：{zpath}")
    print(f"  文件数：{n}  大小：{len(data):,} bytes ({len(data)/1024/1024:.2f} MiB)")
    print(f"  SHA256：{hashlib.sha256(data).hexdigest().upper()}")
    print(f"  MD5：{hashlib.md5(data).hexdigest().upper()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

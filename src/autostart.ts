/**
 * autostart.ts —— 让代理"开机自己起来"，三个平台都不需要用户写脚本
 *
 * 为什么放进产品里：
 *   以前用户得自己写 bat / 计划任务 / plist / systemd，这是最劝退的一步。
 *   本模块把注册动作封成一条命令：dobostitch autostart enable|disable|status。
 *
 * 平台实现：
 *   Windows  schtasks 计划任务（登录后延迟 20s，避开开机抢占）
 *   macOS    ~/Library/LaunchAgents/com.dobocache.proxy.plist（RunAtLoad + KeepAlive）
 *   Linux    ~/.config/systemd/user/dobocache-proxy.service（systemd --user，enable --now）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT } from "./proxy/server.js";

/** 计划任务 / 服务名（三平台统一口径，便于用户自查与卸载） */
export const AUTOSTART_NAME = "DoboCache-Proxy";

export interface AutostartStatus {
  supported: boolean;
  registered: boolean;
  detail: string;
  /** 注册载体的位置（Windows 为任务名，其他为文件路径） */
  location: string;
}

function platform(): NodeJS.Platform {
  return process.platform;
}

/** 代理入口：基于本模块自身位置解析，不依赖启动时的 cwd */
function resolveCliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "proxy", "cli.js");
}

/** 代理命令行：node <dist>/proxy/cli.js start --port <port> --rewrite stabilize --inject-usage on --log <file> */
function proxyCommand(port: number): { exe: string; args: string[] } {
  const cli = resolveCliEntry();
  const logFile = path.join(os.homedir(), ".dobocache", "logs", `proxy-${port}.log`);
  return {
    exe: process.execPath,
    args: [cli, "start", "--port", String(port), "--rewrite", "stabilize", "--inject-usage", "on", "--log", logFile],
  };
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
    return { ok: true, out: out ?? "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: [e.stdout, e.stderr, e.message].filter(Boolean).join("\n") };
  }
}

// ---------------------------------------------------------------- Windows

/**
 * Windows 计划任务的 /TR 参数有 261 字符硬上限，直接把 node 全路径 + 一堆参数塞进去
 * 会注册失败（路径长的机器必踩）。所以落一个 launcher.cmd，让 /TR 只指向它。
 */
function winLauncherPath(): string {
  return path.join(os.homedir(), ".dobocache", "bin", "dobocache-proxy.cmd");
}

function ensureWinLauncher(port: number): string {
  const { exe, args } = proxyCommand(port);
  const file = winLauncherPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [
    "@echo off",
    "chcp 65001 >nul",
    `"${exe}" ${args.map((a) => `"${a}"`).join(" ")}`,
    "",
  ].join("\r\n");
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

function winTaskCommand(port: number): string {
  ensureWinLauncher(port);
  return `"${winLauncherPath()}"`;
}

function winStatus(): AutostartStatus {
  const res = run("schtasks", ["/Query", "/TN", AUTOSTART_NAME]);
  return {
    supported: true,
    registered: res.ok,
    detail: res.ok ? "计划任务已注册（登录后自动起代理）" : "尚未注册计划任务",
    location: `计划任务 ${AUTOSTART_NAME}`,
  };
}

// ---------------------------------------------------------------- macOS

function macPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.dobocache.proxy.plist");
}

function macPlistBody(port: number): string {
  const { exe, args } = proxyCommand(port);
  const argXml = args.map((a) => `    <string>${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.dobocache.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exe.replace(/&/g, "&amp;")}</string>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), "Library", "Logs", "dobocache-proxy.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), "Library", "Logs", "dobocache-proxy.err.log")}</string>
</dict>
</plist>
`;
}

function macStatus(): AutostartStatus {
  const file = macPlistPath();
  const exists = fs.existsSync(file);
  return {
    supported: true,
    registered: exists,
    detail: exists ? "LaunchAgent 已写入（登录后自动起代理）" : "尚未注册 LaunchAgent",
    location: file,
  };
}

// ---------------------------------------------------------------- Linux

function linuxUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "dobocache-proxy.service");
}

function linuxUnitBody(port: number): string {
  const { exe, args } = proxyCommand(port);
  return `[Unit]
Description=DoboCache local proxy (dobostitch)
After=default.target

[Service]
Type=simple
ExecStart=${exe} ${args.join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function linuxStatus(): AutostartStatus {
  const file = linuxUnitPath();
  const exists = fs.existsSync(file);
  let active = false;
  if (exists) {
    const res = run("systemctl", ["--user", "is-active", "dobocache-proxy"]);
    active = res.out.trim() === "active";
  }
  return {
    supported: true,
    registered: exists,
    detail: exists ? `systemd --user 单元已写入（当前${active ? "运行中" : "未运行"}）` : "尚未注册 systemd --user 单元",
    location: file,
  };
}

// ---------------------------------------------------------------- 对外接口

export function statusTransport(): AutostartStatus {
  if (platform() === "win32") return winStatus();
  if (platform() === "darwin") return macStatus();
  if (platform() === "linux") return linuxStatus();
  return { supported: false, registered: false, detail: `暂不支持的平台：${platform()}`, location: "-" };
}

export function enable(port: number = DEFAULT_PORT): AutostartStatus {
  if (platform() === "win32") {
    const res = run("schtasks", [
      "/Create", "/F", "/TN", AUTOSTART_NAME, "/SC", "ONLOGON", "/DELAY", "0000:20", "/TR", winTaskCommand(port),
    ]);
    if (!res.ok) return { supported: true, registered: false, detail: `注册失败：${res.out.trim()}`, location: `计划任务 ${AUTOSTART_NAME}` };
    return { supported: true, registered: true, detail: "已注册计划任务（登录后 20 秒自动起代理）", location: `计划任务 ${AUTOSTART_NAME}` };
  }

  if (platform() === "darwin") {
    const file = macPlistPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.mkdirSync(path.join(os.homedir(), "Library", "Logs"), { recursive: true });
      fs.writeFileSync(file, macPlistBody(port), "utf-8");
      run("launchctl", ["unload", file]);
      const res = run("launchctl", ["load", "-w", file]);
      return {
        supported: true,
        registered: true,
        detail: res.ok ? "已加载 LaunchAgent（登录后自动起代理）" : `plist 已写入但 load 失败：${res.out.trim()}`,
        location: file,
      };
    } catch (err) {
      return { supported: true, registered: false, detail: `写入失败：${(err as Error)?.message ?? err}`, location: file };
    }
  }

  if (platform() === "linux") {
    const file = linuxUnitPath();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, linuxUnitBody(port), "utf-8");
      run("systemctl", ["--user", "daemon-reload"]);
      const res = run("systemctl", ["--user", "enable", "--now", "dobocache-proxy"]);
      return {
        supported: true,
        registered: true,
        detail: res.ok ? "已启用 systemd --user 单元（登录后自动起代理）" : `单元已写入但 enable 失败：${res.out.trim()}`,
        location: file,
      };
    } catch (err) {
      return { supported: true, registered: false, detail: `写入失败：${(err as Error)?.message ?? err}`, location: file };
    }
  }

  return { supported: false, registered: false, detail: `暂不支持的平台：${platform()}`, location: "-" };
}

export function disable(): AutostartStatus {
  if (platform() === "win32") {
    const res = run("schtasks", ["/Delete", "/F", "/TN", AUTOSTART_NAME]);
    return {
      supported: true,
      registered: false,
      detail: res.ok ? "已删除计划任务（下次登录不再自动起代理）" : `删除失败或本来就不存在：${res.out.trim()}`,
      location: `计划任务 ${AUTOSTART_NAME}`,
    };
  }

  if (platform() === "darwin") {
    const file = macPlistPath();
    if (!fs.existsSync(file)) return { supported: true, registered: false, detail: "本来就没注册", location: file };
    run("launchctl", ["unload", "-w", file]);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    return { supported: true, registered: false, detail: "已删除 LaunchAgent", location: file };
  }

  if (platform() === "linux") {
    const file = linuxUnitPath();
    run("systemctl", ["--user", "disable", "--now", "dobocache-proxy"]);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    return { supported: true, registered: false, detail: "已停用并删除 systemd --user 单元", location: file };
  }

  return { supported: false, registered: false, detail: `暂不支持的平台：${platform()}`, location: "-" };
}

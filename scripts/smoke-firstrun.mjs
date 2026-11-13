#!/usr/bin/env node
/**
 * 首屏命令冒烟（v0.5.2 起）
 *
 * 为什么单独有这一支：
 * v0.5.1 的对外首屏命令 `npx -y dobocache@<ver> dobostitch start` 是坏的 —— 而单元测试
 * 全绿、check-docs 全绿、CI 全绿，因为**没有任何一支测试真的跑过那条命令**。
 * 文档写的命令和机器跑的路径之间裂开了一条缝，人工复验只能抓一次抓不到第二次。
 *
 * 本脚本把那条缝焊死：用 dist 产物真跑三条路径，并给出硬超时。
 *   ① `node dist/index.js dobostitch status`  —— 入口必须把子命令转给代理（P0 回归）
 *   ② `node dist/proxy/cli.js status`         —— 原 bin 路径不得被转发破坏
 *   ③ `node dist/index.js` + initialize 握手   —— 无参启动必须仍是纯 MCP server（行为不变）
 *
 * 用法：npm run smoke（或 node scripts/smoke-firstrun.mjs）
 * 前置：先 npm run build（需要 dist）
 * 退出码：0 通过；1 失败
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'dist', 'index.js');
const CLI = join(ROOT, 'dist', 'proxy', 'cli.js');
const HARD_TIMEOUT_MS = 25_000;

const failures = [];
const notes = [];

if (!existsSync(ENTRY)) {
  console.error('[smoke] 找不到 dist/index.js，请先执行 npm run build');
  process.exit(1);
}

/** 跑一次命令，返回 { code, stdout, stderr, timedOut } */
function run(args, { stdin = 'close', timeout = HARD_TIMEOUT_MS, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    // stdin=close → 立即 EOF（复现"静默退出"场景）；stdin=open → 保持打开（复现"挂死"场景）
    if (input !== null) child.stdin.end(input);
    else if (stdin === 'close') child.stdin.end();
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/* ---------- ① 入口转发：dobostitch status ---------- */
{
  const r = await run([ENTRY, 'dobostitch', 'status']);
  if (r.timedOut) {
    failures.push('① `node dist/index.js dobostitch status` 挂死 25s —— 入口没有转发子命令（P0 回归）');
  } else if (r.code !== 0) {
    failures.push(`① 子命令转发退出码 ${r.code}，stderr：${r.stderr.trim().slice(0, 300)}`);
  } else if (!/\[dobostitch\]/.test(r.stdout)) {
    failures.push(`① 子命令转发没跑到代理（输出应为 dobostitch 文案）：${r.stdout.trim().slice(0, 300)}`);
  } else if (/unsettled top-level await/.test(r.stderr)) {
    failures.push('① stderr 出现 "Detected unsettled top-level await"，说明转发后仍挂住了顶层 await');
  } else {
    notes.push(`① 入口转发正常：${r.stdout.trim().split('\n')[0].slice(0, 90)}`);
  }
}

/* ---------- ② 原 bin 路径不被破坏 ---------- */
{
  const r = await run([CLI, 'status']);
  if (r.timedOut) failures.push('② `node dist/proxy/cli.js status` 挂死 25s');
  else if (r.code !== 0) failures.push(`② 原 bin 路径退出码 ${r.code}`);
  else if (!/\[dobostitch\]/.test(r.stdout)) failures.push('② 原 bin 路径输出异常');
  else notes.push('② 原 dobostitch bin 路径未受影响');
}

/* ---------- ③ 无参启动仍是纯 MCP server ---------- */
{
  const initReq = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-firstrun', version: '0.0.0' },
    },
  })}\n`;
  const r = await run([ENTRY], { input: initReq, timeout: HARD_TIMEOUT_MS });
  if (r.timedOut) {
    failures.push('③ 无参启动 + initialize 挂死 —— MCP 主路径可能被子命令转发误伤');
  } else if (!r.stdout.trim()) {
    failures.push(`③ 无参启动无任何 JSON-RPC 响应（stderr：${r.stderr.trim().slice(0, 300)}）`);
  } else {
    try {
      const resp = JSON.parse(r.stdout.trim().split('\n').find((l) => l.includes('"result"')) ?? r.stdout.trim().split('\n')[0]);
      const name = resp?.result?.serverInfo?.name;
      if (name !== 'dobocache') failures.push(`③ initialize 返回 serverInfo.name=${String(name)}，应为 dobocache`);
      else notes.push(`③ MCP 主路径正常：serverInfo=${JSON.stringify(resp.result.serverInfo)}`);
    } catch (err) {
      failures.push(`③ initialize 响应无法解析为 JSON：${r.stdout.trim().slice(0, 200)}（${err.message}）`);
    }
  }
}

/* ---------- 输出 ---------- */
console.log('[smoke] 首屏命令冒烟 · v0.5.2 P0 回归守卫');
for (const n of notes) console.log(`  PASS ${n}`);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`\n结果：${failures.length === 0 ? '通过' : `${failures.length} 项失败`}`);
process.exit(failures.length ? 1 : 0);

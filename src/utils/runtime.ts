/**
 * 启动自检（跨机器可跑改造）
 *
 * 只做"能提前失败就提前失败"的最小检查：Node.js 主版本。
 * MCP SDK 1.x 依赖 Node 18+ 的运行时能力，在更老的版本上会在各种奇怪的地方
 * 报出难懂的错（SyntaxError / ERR_UNKNOWN_FILE_EXTENSION 等），用户完全看不懂。
 * 这里在进程启动的第一时间给出人话提示并退出，避免"挂上了但没反应"。
 */

/** 本插件要求的最低 Node.js 主版本 */
export const MIN_NODE_MAJOR = 18;

export interface NodeCheckResult {
  ok: boolean;
  /** 不满足时面向零技术用户的多行提示（可直接打到 stderr） */
  message: string;
}

/** 从 "v18.19.0" 这类版本串里取主版本号；解析失败按 0 处理 */
export function parseNodeMajor(version: string): number {
  const matched = /^v?(\d+)\./.exec(version.trim());
  return matched ? Number(matched[1]) : 0;
}

/**
 * 检查 Node.js 主版本（默认取当前进程）。
 * 说明：package.json 的 engines 只产生 npm warning，挡不住任何机器，
 * 真正能兜住"在老 Node 上被拉起来"的只有运行时自检。
 */
export function checkNodeVersion(version: string = process.versions.node): NodeCheckResult {
  const major = parseNodeMajor(version);
  if (major >= MIN_NODE_MAJOR) return { ok: true, message: "" };

  const message = [
    `[DoboCache] 启动失败：这台电脑的 Node.js 版本太旧（当前 ${version}），本插件需要 Node.js ${MIN_NODE_MAJOR} 或更高版本。`,
    `解决办法：打开 https://nodejs.org 下载安装最新 LTS 版本，装完重启你的编辑器/客户端再试一次。`,
    `如果已经装过新版还是报这个错，说明客户端配置里指向的是旧的 node，请把配置中的 command 改成新版 node 的完整路径。`,
    `[DoboCache] Startup aborted: Node.js ${version} is too old. Node.js >= ${MIN_NODE_MAJOR} is required.`,
    `Install the latest LTS from https://nodejs.org, then restart your client.`,
  ].join("\n");

  return { ok: false, message };
}

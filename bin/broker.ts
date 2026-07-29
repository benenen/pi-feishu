#!/usr/bin/env node
// broker 进程的可执行入口：一个独立的长连接进程，多个 pi 会话经 Unix socket
// 共用它去接飞书。用法见 README「broker 模式」一节。
//
// 本文件直接写 process.stderr 是刻意的、也是唯一例外：log.ts 那条「日志绝不能
// 裸写 stderr/stdout」的规则，前提是 pi 的 TUI 占着终端、console.error 会把渲染区
// 冲花。这里没有 TUI —— broker 是独立进程，stderr 就是它该去的地方。其余所有模块
// （channel.ts / server.ts 等）的日志依旧只经这里传入的 log 函数出，不自己碰 stderr。
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ConfigError, loadConfig, readConfigFile, type Config } from "../extensions/feishu/config.ts";
import { BrokerChannel } from "../extensions/feishu/broker/channel.ts";
import { BrokerServer } from "../extensions/feishu/broker/server.ts";
import type { NotifyLevel } from "../extensions/feishu/log.ts";

// 签名必须与 extensions/feishu/log.ts 的 LogFn 结构兼容（第二个参数可选），
// 否则传给 BrokerChannel / BrokerServer 时类型对不上。
const log = (msg: string, level: NotifyLevel = "info"): void => {
  process.stderr.write(`[broker][${level}] ${msg}\n`);
};

const cwd = process.cwd();
const agentDir = getAgentDir();

let config: Config;
try {
  config = loadConfig({
    files: [
      readConfigFile(path.join(agentDir, "feishu.json")),
      readConfigFile(path.join(cwd, ".pi", "feishu.json")),
    ],
    env: process.env,
    cwd,
    // 不传这个的话 brokerSocket 的默认值会退回 cwd，跟扩展侧用 getAgentDir()
    // 算出来的路径对不上，两边永远连不上同一个 socket。
    agentDir,
  });
} catch (err) {
  log(err instanceof ConfigError ? err.message : `配置加载失败：${String(err)}`, "error");
  process.exit(1);
}

const channel = new BrokerChannel(config, log);
const server = new BrokerServer({
  channel,
  pairingTtlMs: config.pairingTtlMs,
  log,
});
channel.onMessage((msg) => server.deliver(msg));

try {
  await channel.connect();
} catch (err) {
  // 凭据错、网络不通是最常撞的两件事，给出本地化提示而不是让异常冒成裸栈
  log(`飞书连接失败：${String(err)}`, "error");
  process.exit(1);
}

try {
  await server.listen(config.brokerSocket);
} catch (err) {
  log(`监听 socket 失败（${config.brokerSocket}）：${String(err)}`, "error");
  await channel.disconnect().catch(() => {});
  process.exit(1);
}

log(`broker 已就绪：${config.brokerSocket}`);

// SIGINT/SIGTERM 都要接：Ctrl-C、systemd stop、容器编排发 SIGTERM 都得走到这。
// stopping 防重入 —— 关闭过程里 server.close()/channel.disconnect() 都要
// await，这期间连按两次 Ctrl-C 或编排系统重复发信号，绝不能触发第二轮关闭。
let stopping = false;
const stop = async (signal: NodeJS.Signals): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，正在停止…`);
  // 先关 server：新请求先被拒之门外，再断飞书连接，避免关闭过程中飞书那头
  // 还有回调想经 channel 往已经在关闭的连接上写数据。
  try {
    await server.close();
  } catch (err) {
    log(`关闭 server 失败：${String(err)}`, "error");
  }
  try {
    await channel.disconnect();
  } catch (err) {
    log(`断开飞书连接失败：${String(err)}`, "error");
  }
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

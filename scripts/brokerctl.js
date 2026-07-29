#!/usr/bin/env node
/**
 * feishu-broker 进程管理脚本。
 *
 * 用法：
 *   node scripts/brokerctl.js start [--timeout=30]
 *   node scripts/brokerctl.js stop  [--timeout=15]
 *   node scripts/brokerctl.js restart
 *   node scripts/brokerctl.js status
 *   node scripts/brokerctl.js logs [-f] [-n 50]
 *
 * 存活判定用**两个独立信号**，缺一不可：
 *   - socket 探活：能连上 = 确实有 broker 在服务。这是权威信号，与 broker 自己
 *     `listen()` 里防重复启动用的是同一招
 *   - pid 文件：知道是哪个进程、起了多久、能不能 stop
 * 只信 pid 文件会被 pid 复用骗到；只信 socket 则停不掉它。两者不一致时明确报出来，
 * 而不是挑一个信 —— 那种「看起来正常其实不对」的状态最难排查。
 *
 * 纯 JS、零依赖（package.json 的 type 是 module，所以本文件是 ESM）。
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, readConfigFile, ConfigError } from "../extensions/feishu/config.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "bin", "broker.ts");

/** socket 探活的单次超时。本机 unix socket 要么立刻连上要么立刻被拒 */
const PROBE_TIMEOUT_MS = 500;
/** 轮询间隔 */
const POLL_MS = 200;

// ── 配置 ───────────────────────────────────────────────────────────

/**
 * 走扩展和 broker 用的**同一套** loadConfig，保证算出来的 socket 路径三方一致。
 * 自己拼路径迟早会与它们漂开。
 */
function resolvePaths() {
  const agentDir = getAgentDir();
  let socketPath;
  try {
    const cfg = loadConfig({
      files: [
        readConfigFile(path.join(agentDir, "feishu.json")),
        readConfigFile(path.join(REPO, ".pi", "feishu.json")),
      ],
      env: process.env,
      cwd: REPO,
      agentDir,
    });
    socketPath = cfg.brokerSocket;
  } catch (err) {
    // 配置坏了照样要能 status / stop —— 退回默认路径，但把问题说出来
    socketPath = path.join(agentDir, "feishu-broker.sock");
    const why = err instanceof ConfigError ? err.message : String(err);
    process.stderr.write(`⚠️  配置读取失败，socket 路径退回默认值：\n${why}\n\n`);
  }
  return {
    socketPath,
    pidFile: path.join(agentDir, "feishu-broker.pid"),
    logFile: path.join(agentDir, "feishu-broker.log"),
  };
}

// ── 存活探测 ───────────────────────────────────────────────────────

/** 能连上 socket = 有 broker 在服务。与 broker 自己防重复启动用的是同一招 */
function probeSocket(socketPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve(false);
    const sock = net.createConnection(socketPath);
    let settled = false;
    const done = (alive) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function readPid(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** signal 0 只做存在性检查，不真的发信号 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程存在但不属于当前用户 —— 也算活着
    return err?.code === "EPERM";
  }
}

function uptimeOf(pid) {
  try {
    const started = fs.statSync(`/proc/${pid}`).mtimeMs;
    const sec = Math.floor((Date.now() - started) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  } catch {
    return undefined; // 非 Linux 或进程已退出
  }
}

function socketMode(socketPath) {
  try {
    return (fs.statSync(socketPath).mode & 0o777).toString(8).padStart(3, "0");
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tailLog(logFile, n) {
  try {
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ── 命令 ───────────────────────────────────────────────────────────

async function cmdStart({ socketPath, pidFile, logFile }, opts) {
  if (await probeSocket(socketPath)) {
    const pid = readPid(pidFile);
    console.error(`✗ 已经有 broker 在服务：${socketPath}`);
    console.error(pid ? `  pid=${pid}（本脚本启动的）` : "  没有 pid 文件 —— 可能是手动起的");
    console.error("  不要同时跑两个 broker。要重启用 restart。");
    return 1;
  }

  // socket 连不上但 pid 文件还在 = 上次异常退出的残留
  const stale = readPid(pidFile);
  if (stale !== undefined && !pidAlive(stale)) {
    fs.rmSync(pidFile, { force: true });
    console.log(`（清理了上次残留的 pid 文件：${stale} 已不存在）`);
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");
  fs.writeSync(out, `\n===== ${new Date().toISOString()} 启动 =====\n`);

  // detached + unref：本脚本退出后 broker 继续跑
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  console.log(`已拉起 broker：pid=${child.pid}，日志 → ${logFile}`);
  process.stdout.write(`等待就绪（最多 ${opts.timeout}s）`);

  const deadline = Date.now() + opts.timeout * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(child.pid)) {
      console.log("");
      console.error(`✗ broker 进程已退出（pid=${child.pid}）。最后几行日志：\n`);
      for (const l of tailLog(logFile, 20)) console.error(`  ${l}`);
      fs.rmSync(pidFile, { force: true });
      return 1;
    }
    if (await probeSocket(socketPath)) {
      console.log(" ✓");
      console.log(`broker 已就绪：${socketPath}（权限 ${socketMode(socketPath) ?? "?"}）`);
      return 0;
    }
    process.stdout.write(".");
    await sleep(POLL_MS);
  }

  // 超时不杀进程 —— 可能只是慢（比如飞书握手久）。如实报出来让人自己判断
  console.log("");
  console.error(`✗ ${opts.timeout}s 内未就绪，但进程还活着（pid=${child.pid}）。最后几行日志：\n`);
  for (const l of tailLog(logFile, 20)) console.error(`  ${l}`);
  console.error(`\n没有杀掉它 —— 可能只是慢。用 status 继续观察，确认起不来再 stop。`);
  return 1;
}

async function cmdStop({ socketPath, pidFile }, opts) {
  const pid = readPid(pidFile);

  if (pid === undefined) {
    if (await probeSocket(socketPath)) {
      console.error(`✗ 有 broker 在服务（${socketPath}），但没有 pid 文件 —— 不是本脚本启动的。`);
      console.error("  请自己找到它并停掉，例如：pgrep -af 'bin/broker.ts'");
      return 1;
    }
    console.log("broker 未在运行。");
    return 0;
  }

  if (!pidAlive(pid)) {
    fs.rmSync(pidFile, { force: true });
    console.log(`broker 未在运行（清理了残留 pid 文件：${pid}）。`);
    return 0;
  }

  // SIGTERM：broker 会先关 socket 服务端、再断飞书连接、再退出
  process.kill(pid, "SIGTERM");
  process.stdout.write(`已发 SIGTERM（pid=${pid}），等待退出`);

  const deadline = Date.now() + opts.timeout * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      console.log(" ✓");
      fs.rmSync(pidFile, { force: true });
      console.log("broker 已停止。");
      return 0;
    }
    process.stdout.write(".");
    await sleep(POLL_MS);
  }

  console.log("");
  console.error(`⚠️  ${opts.timeout}s 内没退出，改用 SIGKILL。`);
  console.error("   注意：强杀会留下 socket 文件，但下次 start 时 broker 自己会探活并清理死文件。");
  process.kill(pid, "SIGKILL");
  await sleep(500);
  fs.rmSync(pidFile, { force: true });
  return pidAlive(pid) ? 1 : 0;
}

async function cmdStatus({ socketPath, pidFile, logFile }) {
  const serving = await probeSocket(socketPath);
  const pid = readPid(pidFile);
  const alive = pid !== undefined && pidAlive(pid);

  console.log(`socket   : ${socketPath}`);
  console.log(`           ${fs.existsSync(socketPath) ? `存在，权限 ${socketMode(socketPath)}` : "不存在"}`);
  console.log(`日志     : ${logFile}`);
  console.log(`pid 文件 : ${pid === undefined ? "无" : `${pid}（进程${alive ? "存活" : "已不存在"}）`}`);
  if (alive) {
    const up = uptimeOf(pid);
    if (up) console.log(`运行时长 : ${up}`);
  }
  console.log("");

  // 两个信号一致时给结论；不一致时明确指出，别挑一个信
  if (serving && alive) {
    console.log(`✓ 运行中（pid=${pid}），正在服务 socket。`);
    return 0;
  }
  if (serving && !alive) {
    console.log("⚠️  有 broker 在服务，但 pid 文件缺失或指向的进程已不存在。");
    console.log("   多半是手动启动的，或 pid 文件被删了 —— 本脚本 stop 不了它。");
    console.log("   找它：pgrep -af 'bin/broker.ts'");
    return 0;
  }
  if (!serving && alive) {
    console.log(`⚠️  进程 ${pid} 活着，但 socket 连不上。`);
    console.log("   常见原因：还在连飞书（未就绪），或它卡住了。");
    console.log(`   看日志：node scripts/brokerctl.js logs`);
    return 3;
  }
  console.log("✗ 未在运行。");
  return 3;
}

function cmdLogs({ logFile }, opts) {
  if (!fs.existsSync(logFile)) {
    console.error(`没有日志文件：${logFile}`);
    return 1;
  }
  if (!opts.follow) {
    for (const l of tailLog(logFile, opts.lines)) console.log(l);
    return 0;
  }
  // 跟随模式借用 tail -f：自己用 fs.watch 实现要处理截断与轮转，不值得
  const child = spawn("tail", ["-f", "-n", String(opts.lines), logFile], { stdio: "inherit" });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

// ── 入口 ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { timeout: undefined, follow: false, lines: 50 };
  for (const a of argv) {
    if (a === "-f" || a === "--follow") opts.follow = true;
    else if (a.startsWith("--timeout=")) opts.timeout = Number.parseInt(a.slice(10), 10);
    else if (a.startsWith("-n")) opts.lines = Number.parseInt(a.slice(2) || "50", 10);
    else if (a.startsWith("--lines=")) opts.lines = Number.parseInt(a.slice(8), 10);
  }
  return opts;
}

const USAGE = `feishu-broker 管理脚本

  start [--timeout=30]   后台拉起 broker，等到 socket 可连才算成功
  stop  [--timeout=15]   SIGTERM 优雅停止，超时才 SIGKILL
  restart                stop + start
  status                 socket 探活 + pid 双信号，不一致会明确指出
  logs [-f] [-n 50]      看日志，-f 跟随

退出码：0 正常 / 1 出错 / 3 未在运行（status 专用，便于脚本判断）`;

const cmd = process.argv[2];
const opts = parseArgs(process.argv.slice(3));
const paths = resolvePaths();

let code;
switch (cmd) {
  case "start":
    code = await cmdStart(paths, { timeout: opts.timeout ?? 30 });
    break;
  case "stop":
    code = await cmdStop(paths, { timeout: opts.timeout ?? 15 });
    break;
  case "restart":
    code = await cmdStop(paths, { timeout: opts.timeout ?? 15 });
    if (code === 0) code = await cmdStart(paths, { timeout: opts.timeout ?? 30 });
    break;
  case "status":
    code = await cmdStatus(paths);
    break;
  case "logs":
    code = await cmdLogs(paths, opts);
    break;
  default:
    console.log(USAGE);
    code = cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
}
process.exit(code);

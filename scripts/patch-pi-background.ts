import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HOOK = 'globalThis[Symbol.for("pi-feishu:tool-execution")]';
const LOADED = 'globalThis[Symbol.for("pi-feishu:tool-hook-loaded")] = true;\n';
const ORIGINAL = 'prepared.tool.execute(';
const REPLACEMENT = `(${HOOK} ?? ((tool, ...args) => tool.execute(...args)))(prepared.tool, `;
const BACKUP_SUFFIX = '.pi-feishu-background.bak';

/** 只修改公共执行点：所有参数校验、审批及结果后处理都保持在 pi 原来的位置。 */
export function patchSource(source: string): string {
  if (source.startsWith(LOADED) && source.includes(REPLACEMENT)) return source;
  if (!source.includes('async function executePreparedToolCall(') || source.split(ORIGINAL).length !== 2) {
    throw new Error('pi 核心的执行入口与补丁不匹配，未修改任何内容');
  }
  return LOADED + source.replace(ORIGINAL, REPLACEMENT);
}

/** 发现源模块与真正 CLI 使用的 bundle chunk，避免只改 SDK、CLI 却仍然运行旧代码。 */
export function patchTargets(packageRoot: string): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.0.2') {
    throw new Error('此补丁只支持 @earendil-works/pi-coding-agent 1.0.2');
  }
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const core = path.join(path.dirname(require.resolve('@earendil-works/pi-agent-core/package.json')), 'dist/agent-loop.js');
  const targets = [core];
  const chunks = path.join(packageRoot, 'dist/bundle/chunks');
  if (fs.existsSync(chunks)) {
    const bundled = fs.readdirSync(chunks).filter((name) => name.endsWith('.js')).map((name) => path.join(chunks, name))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('async function executePreparedToolCall('));
    if (bundled.length !== 1) throw new Error(`CLI bundle 执行入口数量异常（${bundled.length}），未修改`);
    targets.push(...bundled);
  }
  return [...new Set(targets.map((file) => fs.realpathSync(file)))];
}

export function patchPackage(packageRoot: string, mode: 'apply' | 'check' | 'restore' = 'apply'): string[] {
  const targets = patchTargets(packageRoot);
  // 写入前校验所有入口；遇到不匹配版本或已有不同补丁时完整退出。
  const plan = targets.map((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const patched = patchSource(source);
    const backup = file + BACKUP_SUFFIX;
    if (mode === 'restore' && !fs.existsSync(backup)) throw new Error(`缺少回滚备份：${file}`);
    if (fs.existsSync(backup) && patchSource(fs.readFileSync(backup, 'utf8')) !== patched) {
      throw new Error(`已有备份与当前文件不匹配：${file}`);
    }
    return { file, source, patched, backup };
  });
  if (mode === 'check') {
    if (plan.some((item) => item.source !== item.patched)) throw new Error('后台工具补丁尚未应用');
    return targets;
  }
  for (const item of plan) {
    if (mode === 'restore') {
      fs.writeFileSync(item.file, fs.readFileSync(item.backup));
      fs.unlinkSync(item.backup);
    } else if (item.source !== item.patched) {
      if (!fs.existsSync(item.backup)) fs.copyFileSync(item.file, item.backup, fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(item.file, item.patched);
    }
  }
  return targets;
}

function installedPis(): string[] {
  const found: string[] = [];
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(folder, process.platform === 'win32' ? 'pi.cmd' : 'pi');
    if (!fs.existsSync(bin)) continue;
    let candidate = path.dirname(fs.realpathSync(bin));
    for (;;) {
      const manifest = path.join(candidate, 'package.json');
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === '@earendil-works/pi-coding-agent') { found.push(candidate); break; }
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return [...new Set(found)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const mode = args.includes('--check') ? 'check' : args.includes('--restore') ? 'restore' : 'apply';
    const rootIndex = args.indexOf('--root');
    const roots = rootIndex >= 0
      ? [path.resolve(args[rootIndex + 1])]
      : [...new Set([path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))), ...installedPis()])];
    // 在任意文件写入前先校验所有安装，防止版本不一致时一半成功、一半失败。
    for (const root of roots) for (const file of patchTargets(root)) patchSource(fs.readFileSync(file, 'utf8'));
    for (const root of roots) {
      const changed = patchPackage(root, mode);
      process.stdout.write(`${mode}: ${root}（${changed.length} 个执行入口）\n`);
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

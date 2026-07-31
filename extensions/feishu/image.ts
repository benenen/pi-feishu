import path from "node:path";
import { isInside, type PathResolver } from "./risk.ts";

/** 飞书单张图片上限 10MB */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type ImageGate = { ok: true; path: string } | { ok: false; reason: string };

export interface ImageGateArgs {
  path: string;
  repoRoot: string;
  /**
   * 仓库之外额外允许的目录。**空数组表示只允许仓库内，不是「不限」** ——
   * 与 `groupAllowlist` 的语义刻意相反：那边空数组是「不限」，因为放宽的是
   * 「谁能找我说话」；这边放宽的是「什么文件能被送出这台机器」，默认必须最紧。
   */
  imageDirs: readonly string[];
  resolvePath?: PathResolver;
}

/**
 * 判定一个路径能不能被发出去。纯函数，不碰文件系统 —— 真实的 realpath 由
 * 调用方通过 `resolvePath` 注入，测试才能构造软链场景。
 *
 * 目录判定复用 `risk.ts` 的 `isInside`：它先 resolve 再比 relative，
 * `..` 穿越和「前缀相同的兄弟目录」（`/var/shots-evil` vs `/var/shots`）都挡得住。
 */
export function gateImagePath({ path: p, repoRoot, imageDirs, resolvePath }: ImageGateArgs): ImageGate {
  const abs = path.resolve(repoRoot, p);
  for (const root of [repoRoot, ...imageDirs]) {
    if (isInside(root, abs, resolvePath)) return { ok: true, path: abs };
  }
  const extra = imageDirs.length > 0 ? `，另加 ${imageDirs.join("、")}` : "";
  return { ok: false, reason: `${abs} 不在允许的目录里（仓库根 ${repoRoot}${extra}）` };
}

export type ImageType = "png" | "jpeg" | "gif" | "bmp" | "webp";

/**
 * 按魔数认图片类型，**不看扩展名** —— 扩展名是调用方给的字符串，
 * 把 `/etc/shadow` 改叫 `shadow.png` 就能外发的话，目录白名单形同虚设。
 */
export function sniffImageType(buf: Buffer): ImageType | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  if (buf.length >= 6 && buf.subarray(0, 2).toString("latin1") === "BM") return "bmp";
  return undefined;
}

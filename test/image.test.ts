import { test } from "node:test";
import assert from "node:assert/strict";
import { gateImagePath, sniffImageType, MAX_IMAGE_BYTES } from "../extensions/feishu/image.ts";

const ROOT = "/repo";

function gate(p: string, dirs: readonly string[] = [], resolvePath?: (x: string) => string) {
  return gateImagePath({ path: p, repoRoot: ROOT, imageDirs: dirs, resolvePath });
}

test("仓库里的图片放行", () => {
  const r = gate("/repo/docs/shot.png");
  assert.equal(r.ok, true);
});

test("仓库外的图片默认拒绝 —— 空白名单不等于不限", () => {
  const r = gate("/etc/shadow.png");
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : "", /不在允许的目录/);
});

test("白名单目录里的图片放行", () => {
  const r = gate("/var/shots/a.png", ["/var/shots"]);
  assert.equal(r.ok, true);
});

test("白名单目录之外的兄弟目录不放行 —— 前缀相同不等于在目录里", () => {
  const r = gate("/var/shots-evil/a.png", ["/var/shots"]);
  assert.equal(r.ok, false);
});

test("路径穿越出不去白名单", () => {
  const r = gate("/var/shots/../../etc/passwd.png", ["/var/shots"]);
  assert.equal(r.ok, false);
});

test("符号链接按真实目标判定 —— 指向白名单外就拒", () => {
  // resolvePath 模拟 realpath：白名单内的软链其实指向 /etc
  const resolve = (p: string) => (p === "/var/shots/link.png" ? "/etc/passwd" : p);
  const r = gate("/var/shots/link.png", ["/var/shots"], resolve);
  assert.equal(r.ok, false);
});

test("放行时回传的是解析后的绝对路径", () => {
  const r = gate("/repo/./docs/../shot.png");
  assert.equal(r.ok, true);
  assert.equal(r.ok === true ? r.path : "", "/repo/shot.png");
});

test("相对路径按仓库根解析", () => {
  const r = gate("docs/shot.png");
  assert.equal(r.ok, true);
  assert.equal(r.ok === true ? r.path : "", "/repo/docs/shot.png");
});

test("sniffImageType 认得飞书支持的几种图", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  const gif = Buffer.from("GIF89a\0\0", "latin1");
  const bmp = Buffer.from("BM\0\0\0\0\0\0", "latin1");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  assert.equal(sniffImageType(png), "png");
  assert.equal(sniffImageType(jpeg), "jpeg");
  assert.equal(sniffImageType(gif), "gif");
  assert.equal(sniffImageType(bmp), "bmp");
  assert.equal(sniffImageType(webp), "webp");
});

test("sniffImageType 对非图片返回 undefined —— 改个扩展名蒙不过去", () => {
  assert.equal(sniffImageType(Buffer.from("root:x:0:0:root:/root:/bin/bash\n")), undefined);
  assert.equal(sniffImageType(Buffer.alloc(0)), undefined);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), undefined, "半个魔数不算");
});

test("MAX_IMAGE_BYTES 与飞书的 10MB 上限一致", () => {
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
});

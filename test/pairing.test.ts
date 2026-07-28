import { test } from "node:test";
import assert from "node:assert/strict";
import { Pairing, PAIRING_ALPHABET } from "../extensions/feishu/pairing.ts";

/** 可控时钟 + 可控随机源，测试不依赖真实时间与运气 */
function make(opts: { now?: () => number; rand?: (n: number) => number; ttlMs?: number } = {}) {
  let t = 0;
  return new Pairing({
    now: opts.now ?? (() => t),
    randomInt: opts.rand ?? ((n) => n - 1), // 恒取最后一个字符，输出可预期
    ttlMs: opts.ttlMs ?? 600_000,
  });
}

test("签发的码长度固定，且只含无歧义字符", () => {
  const p = make({ rand: (n) => Math.floor(n / 2) });
  const code = p.issue();
  assert.equal(code.length, 8);
  for (const ch of code) assert.ok(PAIRING_ALPHABET.includes(ch), `非法字符 ${ch}`);
});

test("字母表剔除手机上易混的字符", () => {
  for (const bad of ["0", "O", "1", "I", "l"]) {
    assert.equal(PAIRING_ALPHABET.includes(bad), false, `${bad} 不该在字母表里`);
  }
});

test("裸码匹配成功并消耗掉，第二次不再认", () => {
  const p = make();
  const code = p.issue();
  assert.equal(p.match(code), true);
  assert.equal(p.match(code), false, "一次性：用过即失效");
  assert.equal(p.pending, false);
});

test("匹配忽略大小写与首尾空白", () => {
  const p = make();
  const code = p.issue();
  assert.equal(p.match(`  ${code.toLowerCase()}  `), true);
});

test("也接受 /feishu pair <码> 的写法", () => {
  const p = make();
  const code = p.issue();
  assert.equal(p.match(`/feishu pair ${code}`), true);
});

test("错的码不匹配，也不会把正确的码消耗掉", () => {
  const p = make();
  const code = p.issue();
  assert.equal(p.match("XXXXXXXX"), false);
    assert.equal(p.match("随便说句话"), false);
  assert.equal(p.match(code), true, "正确的码仍然有效");
});

test("超时后码失效", () => {
  let t = 0;
  const p = new Pairing({ now: () => t, randomInt: (n) => n - 1, ttlMs: 1000 });
  const code = p.issue();
  t = 1001;
  assert.equal(p.match(code), false, "过期不认");
  assert.equal(p.pending, false, "过期后不该还处于待配对状态");
});

test("未签发时任何输入都不匹配", () => {
  const p = make();
  assert.equal(p.pending, false);
  assert.equal(p.match("ABCDEFGH"), false);
});

test("重新签发会作废旧码", () => {
  const p = make({ rand: (() => { let i = 0; return (n: number) => (i++) % n; })() });
  const first = p.issue();
  const second = p.issue();
  assert.notEqual(first, second, "两次签发应当不同");
  assert.equal(p.match(first), false, "旧码作废");
  assert.equal(p.match(second), true);
});

test("cancel 清掉待配对状态", () => {
  const p = make();
  const code = p.issue();
  p.cancel();
  assert.equal(p.pending, false);
  assert.equal(p.match(code), false);
});

test("expiresAt 反映签发时刻加 ttl", () => {
  let t = 5_000;
  const p = new Pairing({ now: () => t, randomInt: (n) => n - 1, ttlMs: 60_000 });
  p.issue();
  assert.equal(p.expiresAt, 65_000);
});

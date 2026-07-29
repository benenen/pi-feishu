import { test } from "node:test";
import assert from "node:assert/strict";
import { FeishuGateway } from "../extensions/feishu/feishu.ts";
import { BrokerGateway } from "../extensions/feishu/broker/gateway.ts";

/**
 * TypeScript 抓不到「实现比接口少声明一个参数」——参数更少的函数可以赋值给
 * 参数更多的函数类型，这是结构化类型的标准规则。于是 streamTurn(run) 漏掉
 * 第二个参数 `to` 时编译期完全无感，运行期表现是**所有回合都发去已绑定会话**，
 * 多会话模式下就是「群里问的，答案发到私聊」。
 *
 * Function.length 数的是形参个数，正好能在编译期之外把这类遗漏钉住。
 */
test("streamTurn 的实现必须真的接收收件方参数", () => {
  assert.ok(
    FeishuGateway.prototype.streamTurn.length >= 2,
    `FeishuGateway.streamTurn 只声明了 ${FeishuGateway.prototype.streamTurn.length} 个参数，` +
      "漏掉 to 会让所有回合都发去已绑定会话",
  );
  assert.ok(
    BrokerGateway.prototype.streamTurn.length >= 2,
    `BrokerGateway.streamTurn 只声明了 ${BrokerGateway.prototype.streamTurn.length} 个参数`,
  );
});

test("sendText 的实现同样要接收收件方参数", () => {
  assert.ok(FeishuGateway.prototype.sendText.length >= 2);
  assert.ok(BrokerGateway.prototype.sendText.length >= 2);
});

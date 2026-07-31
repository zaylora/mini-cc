import { expect, test } from "bun:test";
import { createConfirmBridge } from "@/tui/confirmBridge.js";

test("subscribe 的监听者收到 confirm 请求，respond 后 confirm 的 Promise 相应 resolve", async () => {
  const bridge = createConfirmBridge();
  let received: { message: string } | undefined;
  bridge.subscribe((request) => {
    received = { message: request.message };
    request.respond(true);
  });

  const allowed = await bridge.confirm("允许执行 bash 吗？");

  expect(received).toEqual({ message: "允许执行 bash 吗？" });
  expect(allowed).toBe(true);
});

test("respond(false) 时 confirm 的 Promise resolve 为 false", async () => {
  const bridge = createConfirmBridge();
  bridge.subscribe((request) => request.respond(false));

  await expect(bridge.confirm("危险操作")).resolves.toBe(false);
});

test("没有订阅者时 confirm 直接 resolve 为 false", async () => {
  const bridge = createConfirmBridge();
  await expect(bridge.confirm("无人处理")).resolves.toBe(false);
});

import { expect, test } from "bun:test";

test("包入口可以正常加载", async () => {
  await expect(import("../src/index.js")).resolves.toBeDefined();
});

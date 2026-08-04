import { expect, test } from "bun:test";
import { displayWidth, truncateToWidth } from "@/markdown/width.js";

test("displayWidth 对 ASCII 按字符计数", () => {
  expect(displayWidth("hello")).toBe(5);
  expect(displayWidth("")).toBe(0);
});

test("displayWidth 对 CJK 字符计为双宽", () => {
  expect(displayWidth("你好")).toBe(4);
  expect(displayWidth("a你b")).toBe(4);
});

test("displayWidth 对组合记号计为零宽", () => {
  // U+0301 COMBINING ACUTE ACCENT
  expect(displayWidth("é")).toBe(1);
});

test("displayWidth 对全角标点与全角 ASCII 计为双宽", () => {
  expect(displayWidth("，")).toBe(2);
  expect(displayWidth("Ａ")).toBe(2);
});

test("truncateToWidth 按显示宽度截断，不切碎双宽字符", () => {
  expect(truncateToWidth("你好世界", 5)).toBe("你好");
  expect(truncateToWidth("hello world", 5)).toBe("hello");
  expect(truncateToWidth("你好", 10)).toBe("你好");
});

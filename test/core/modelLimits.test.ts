import { expect, test } from "bun:test";
import { maxOutputTokensFor } from "@/core/modelLimits.js";

test("已知 200K 窗口模型返回 64K ceiling", () => {
  expect(maxOutputTokensFor("claude-sonnet-4-5")).toBe(64_000);
  expect(maxOutputTokensFor("claude-sonnet-4-5-20250929")).toBe(64_000);
  expect(maxOutputTokensFor("claude-haiku-4-5")).toBe(64_000);
  expect(maxOutputTokensFor("claude-haiku-4-5-20251001")).toBe(64_000);
  expect(maxOutputTokensFor("claude-opus-4-5")).toBe(64_000);
  expect(maxOutputTokensFor("claude-opus-4-1")).toBe(64_000);
  expect(maxOutputTokensFor("claude-opus-4-0")).toBe(64_000);
  expect(maxOutputTokensFor("claude-sonnet-4-0")).toBe(64_000);
  expect(maxOutputTokensFor("claude-3-7-sonnet")).toBe(64_000);
  expect(maxOutputTokensFor("claude-2.1")).toBe(64_000);
});

test("1M 窗口模型与未收录模型默认返回 128K ceiling", () => {
  expect(maxOutputTokensFor("claude-sonnet-5")).toBe(128_000);
  expect(maxOutputTokensFor("claude-sonnet-5[1m]")).toBe(128_000);
  expect(maxOutputTokensFor("claude-opus-5")).toBe(128_000);
  expect(maxOutputTokensFor("some-future-model-nobody-has-heard-of")).toBe(128_000);
});

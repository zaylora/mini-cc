import { describe, expect, test } from "bun:test";
import { getEvalWorkspaceRoot, getLangfuseConfig } from "@/config.js";

describe("getLangfuseConfig", () => {
  test("无密钥时禁用，完整密钥时返回 Cloud 配置", () => {
    expect(getLangfuseConfig({})).toBeUndefined();
    expect(getLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
    })).toEqual({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://cloud.langfuse.com",
    });
  });

  test("允许显式指定 Cloud 区域地址", () => {
    expect(getLangfuseConfig({
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: "https://us.cloud.langfuse.com",
    })?.baseUrl).toBe("https://us.cloud.langfuse.com");
  });

  test("只配置一个密钥时抛出明确错误", () => {
    expect(() => getLangfuseConfig({ LANGFUSE_PUBLIC_KEY: "pk-test" }))
      .toThrow(
        "Langfuse 需要同时配置 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY",
      );
  });
});

describe("getEvalWorkspaceRoot", () => {
  test("未配置时使用系统临时目录", () => {
    expect(getEvalWorkspaceRoot({})).toContain("Temp");
  });

  test("支持自定义评测工作区父目录并规范化路径", () => {
    expect(getEvalWorkspaceRoot({ EVAL_WORKSPACE_ROOT: "E:\\mini-cc-eval\\..\\eval" }))
      .toBe("E:\\eval");
  });

  test("空白配置回退到系统临时目录", () => {
    expect(getEvalWorkspaceRoot({ EVAL_WORKSPACE_ROOT: "  " })).toContain("Temp");
  });
});

import { describe, expect, test } from "bun:test";
import { createPermissionHook } from "@/hooks/permission.js";

describe("权限 hook", () => {
  const permission = createPermissionHook();

  test("硬拒绝列表直接阻断", async () => {
    expect(
      await permission({ toolName: "bash", input: { command: "sudo reboot" } }),
    ).toEqual({ action: "block", reason: "权限被拒：命中禁止规则 sudo" });
  });

  test("危险 bash 命令请求用户确认", async () => {
    expect(
      await permission({ toolName: "bash", input: { command: "rm temp.txt" } }),
    ).toEqual({
      action: "ask",
      message: "检测到可能具有破坏性的命令：rm temp.txt",
    });
  });

  test("普通工具默认放行", async () => {
    expect(
      await permission({ toolName: "read_file", input: { path: "README.md" } }),
    ).toEqual({ action: "continue" });
  });
});

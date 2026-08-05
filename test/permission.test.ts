import { describe, expect, test } from "bun:test";
import { createPermissionHook } from "@/hooks/permission.js";

describe("权限 hook", () => {
  const permission = createPermissionHook();
  const onWindows = createPermissionHook({ platform: "win32" });
  const onPosix = createPermissionHook({ platform: "linux" });

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

  describe("Windows / PowerShell", () => {
    test("Remove-Item 删除文件需要用户确认", async () => {
      const command =
        'Remove-Item -Path ".minicc\\mini-agent-audit.jsonl" -Force';
      expect(
        await onWindows({ toolName: "bash", input: { command } }),
      ).toEqual({
        action: "ask",
        message: `检测到可能具有破坏性的命令：${command}`,
      });
    });

    test("Remove-Item 的别名同样需要确认", async () => {
      const outcome = await onWindows({
        toolName: "bash",
        input: { command: "del build\\output.txt" },
      });
      expect(outcome.action).toBe("ask");
    });

    test("递归强制删除盘符根目录直接阻断", async () => {
      const outcome = await onWindows({
        toolName: "bash",
        input: { command: "Remove-Item -Path C:\\ -Recurse -Force" },
      });
      expect(outcome).toMatchObject({ action: "block" });
      expect(outcome.action === "block" && outcome.reason).toContain("Remove-Item");
    });

    test("关机命令直接阻断", async () => {
      const outcome = await onWindows({
        toolName: "bash",
        input: { command: "Stop-Computer -Force" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });

    test("磁盘格式化直接阻断", async () => {
      const outcome = await onWindows({
        toolName: "bash",
        input: { command: "Format-Volume -DriveLetter D" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });

    test("只读的目录列举命令放行", async () => {
      expect(
        await onWindows({
          toolName: "bash",
          input: {
            command: 'Get-ChildItem -Path ".minicc\\transcripts\\*" -Force',
          },
        }),
      ).toEqual({ action: "continue" });
    });

    test("Unix 专属规则不会误伤 PowerShell 命令", async () => {
      expect(
        await onWindows({
          toolName: "bash",
          input: { command: "Get-Content /etc/hosts" },
        }),
      ).toEqual({ action: "continue" });
    });
  });

  describe("POSIX / sh", () => {
    test("换了短选项顺序的 rm -fr 依旧被阻断", async () => {
      const outcome = await onPosix({
        toolName: "bash",
        input: { command: "rm -fr /home/user" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });

    test("分开写的 -r -f 依旧被阻断", async () => {
      const outcome = await onPosix({
        toolName: "bash",
        input: { command: "rm -r -f /var/log" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });

    test("删除相对路径只需确认", async () => {
      const outcome = await onPosix({
        toolName: "bash",
        input: { command: "rm -rf ./node_modules" },
      });
      expect(outcome.action).toBe("ask");
    });

    test("格式化文件系统直接阻断", async () => {
      const outcome = await onPosix({
        toolName: "bash",
        input: { command: "mkfs.ext4 /dev/sda1" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });

    test("PowerShell 专属规则不会误伤 Unix 命令", async () => {
      expect(
        await onPosix({
          toolName: "bash",
          input: { command: "git log --format=%H" },
        }),
      ).toEqual({ action: "continue" });
    });
  });

  describe("匹配精度", () => {
    test("pseudo 之类的词不会被当成 sudo", async () => {
      expect(
        await onPosix({
          toolName: "bash",
          input: { command: "cat pseudo-terminal.log" },
        }),
      ).toEqual({ action: "continue" });
    });

    test("大小写不影响拦截", async () => {
      const outcome = await onPosix({
        toolName: "bash",
        input: { command: "SUDO apt install curl" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });

    test("命令中间出现的危险片段也会被识别", async () => {
      const outcome = await onPosix({
        toolName: "bash",
        input: { command: "cd /tmp && sudo rm cache" },
      });
      expect(outcome).toMatchObject({ action: "block" });
    });
  });
});

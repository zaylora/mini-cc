import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ConfirmModal } from "@/tui/components/ConfirmModal.js";
import type { ConfirmRequest } from "@/tui/services/confirmBridge.js";

test("展示确认消息，按 y 触发 respond(true)", async () => {
  let resolved: boolean | undefined;
  const request: ConfirmRequest = {
    message: "允许执行 ls 吗？",
    respond: (value) => {
      resolved = value;
    },
  };
  const { stdin, lastFrame } = render(<ConfirmModal request={request} />);
  await Bun.sleep(10);

  expect(lastFrame()).toContain("允许执行 ls 吗？");
  stdin.write("y");
  await Bun.sleep(0);
  expect(resolved).toBe(true);
});

test("按 n 触发 respond(false)", async () => {
  let resolved: boolean | undefined;
  const request: ConfirmRequest = {
    message: "允许执行 rm 吗？",
    respond: (value) => {
      resolved = value;
    },
  };
  const { stdin } = render(<ConfirmModal request={request} />);
  await Bun.sleep(10);

  stdin.write("n");
  await Bun.sleep(0);
  expect(resolved).toBe(false);
});

test("方向键切换选中项后按 Enter 触发对应的 respond", async () => {
  let resolved: boolean | undefined;
  const request: ConfirmRequest = {
    message: "允许执行 rm 吗？",
    respond: (value) => {
      resolved = value;
    },
  };
  const { stdin } = render(<ConfirmModal request={request} />);
  await Bun.sleep(10);

  stdin.write("\u001b[C");
  await Bun.sleep(0);
  stdin.write("\r");
  await Bun.sleep(0);

  expect(resolved).toBe(false);
});

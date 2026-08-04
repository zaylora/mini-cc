import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TodoPanel } from "@/tui/components/TodoPanel.js";

test("todos 为空时不渲染任何内容", () => {
  const { lastFrame } = render(<TodoPanel todos={[]} />);
  expect(lastFrame()).toBe("");
});

test("按状态展示每一条 todo", () => {
  const { lastFrame } = render(
    <TodoPanel
      todos={[
        { content: "写测试", status: "completed" },
        { content: "写实现", status: "in_progress" },
        { content: "写文档", status: "pending" },
      ]}
    />,
  );
  const frame = lastFrame();
  expect(frame).toContain("[x] 写测试");
  expect(frame).toContain("[>] 写实现");
  expect(frame).toContain("[ ] 写文档");
});

import { expect, test } from "bun:test";
import { describeToolCall, toolDotColor, toolLabel } from "@/tui/toolCallFormat.js";

test("toolLabel 映射已知工具并原样返回未知工具", () => {
  expect(toolLabel("bash")).toBe("Bash");
  expect(toolLabel("read_file")).toBe("Read");
  expect(toolLabel("write_file")).toBe("Write");
  expect(toolLabel("edit_file")).toBe("Edit");
  expect(toolLabel("glob")).toBe("Glob");
  expect(toolLabel("task")).toBe("Task");
  expect(toolLabel("load_skill")).toBe("Skill");
  expect(toolLabel("todo_write")).toBe("Todo");
  expect(toolLabel("custom_tool")).toBe("custom_tool");
});

test("describeToolCall 提取各工具的目标字段", () => {
  expect(describeToolCall("bash", { command: "npm test" })).toBe("npm test");
  expect(describeToolCall("read_file", { path: "src/a.ts" })).toBe("src/a.ts");
  expect(describeToolCall("write_file", { path: "src/a.ts" })).toBe("src/a.ts");
  expect(describeToolCall("edit_file", { path: "src/a.ts" })).toBe("src/a.ts");
  expect(describeToolCall("glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  expect(describeToolCall("task", { description: "检查测试" })).toBe("检查测试");
  expect(describeToolCall("load_skill", { name: "testing" })).toBe("testing");
  expect(describeToolCall("todo_write", { todos: [{ content: "一步" }, { content: "二步" }] })).toBe("2 项");
});

test("describeToolCall 字段缺失或类型不符时使用 JSON 兜底", () => {
  expect(describeToolCall("bash", { other: 1 })).toBe('{"other":1}');
  expect(describeToolCall("read_file", { path: 42 })).toBe('{"path":42}');
  expect(describeToolCall("unknown", { value: true })).toBe('{"value":true}');
  expect(describeToolCall("todo_write", { todos: "not-an-array" })).toBe("0 项");
  expect(describeToolCall("bash", undefined)).toBe("{}");
  expect(describeToolCall("unknown", Symbol("value"))).toBe("{}");
});

test("describeToolCall 把换行替换为空格并截断超过 100 字符的结果", () => {
  expect(describeToolCall("bash", { command: "line1\r\nline2\nline3" })).toBe("line1 line2 line3");
  expect(describeToolCall("bash", { command: "a".repeat(101) })).toBe(`${"a".repeat(100)}…`);
});

test("toolDotColor 按工具结果状态返回颜色", () => {
  expect(toolDotColor({})).toBe("yellow");
  expect(toolDotColor({ result: undefined, isError: true })).toBe("yellow");
  expect(toolDotColor({ result: "ok", isError: true })).toBe("red");
  expect(toolDotColor({ result: "ok", isError: false })).toBe("green");
  expect(toolDotColor({ result: "ok" })).toBe("green");
});

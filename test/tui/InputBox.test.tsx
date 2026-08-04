import { useState } from "react";
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "@/tui/components/InputBox.js";

test("禁用时展示提示文本而不接收输入", () => {
  const { lastFrame } = render(
    <InputBox value="" onChange={() => {}} onSubmit={() => {}} disabled />,
  );
  expect(lastFrame()).toContain("请稍候");
});

test("启用时输入字符会触发 onChange", async () => {
  function Harness() {
    const [value, setValue] = useState("");
    return <InputBox value={value} onChange={setValue} onSubmit={() => {}} disabled={false} />;
  }
  const { stdin, lastFrame } = render(<Harness />);
  await Bun.sleep(10);

  stdin.write("hi");
  await Bun.sleep(0);

  expect(lastFrame()).toContain("hi");
});

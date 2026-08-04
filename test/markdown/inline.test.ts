import { expect, test } from "bun:test";
import { parseInline } from "@/markdown/inline.js";

test("纯文本返回单个 text span", () => {
  expect(parseInline("hello world")).toEqual([{ kind: "text", text: "hello world" }]);
});

test("解析粗体", () => {
  expect(parseInline("a **bold** b")).toEqual([
    { kind: "text", text: "a " },
    { kind: "bold", text: "bold" },
    { kind: "text", text: " b" },
  ]);
});

test("解析斜体（星号与下划线两种写法）", () => {
  expect(parseInline("*it*")).toEqual([{ kind: "italic", text: "it" }]);
  expect(parseInline("_it_")).toEqual([{ kind: "italic", text: "it" }]);
});

test("解析行内代码", () => {
  expect(parseInline("use `code` here")).toEqual([
    { kind: "text", text: "use " },
    { kind: "code", text: "code" },
    { kind: "text", text: " here" },
  ]);
});

test("解析链接", () => {
  expect(parseInline("see [text](http://example.com)")).toEqual([
    { kind: "text", text: "see " },
    { kind: "link", text: "text", href: "http://example.com" },
  ]);
});

test("代码优先级最高，代码内的 ** 不被当作粗体标记", () => {
  expect(parseInline("`a**b`")).toEqual([{ kind: "code", text: "a**b" }]);
});

test("未闭合的标记按纯文本处理", () => {
  expect(parseInline("a **b")).toEqual([{ kind: "text", text: "a **b" }]);
  expect(parseInline("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
});

test("不支持嵌套：粗体内的反引号不解析为代码", () => {
  expect(parseInline("**a `code` b**")).toEqual([
    { kind: "bold", text: "a `code` b" },
  ]);
});

test("空字符串返回空数组", () => {
  expect(parseInline("")).toEqual([]);
});

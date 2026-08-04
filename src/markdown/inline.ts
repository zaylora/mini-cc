export type InlineSpan =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

const LINK_PATTERN = /^\[([^\]]*)\]\(([^)]*)\)/;

export function parseInline(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let textBuffer = "";
  let i = 0;

  function flushText(): void {
    if (textBuffer.length > 0) {
      spans.push({ kind: "text", text: textBuffer });
      textBuffer = "";
    }
  }

  while (i < source.length) {
    const remaining = source.slice(i);

    if (source[i] === "`") {
      const closeIndex = source.indexOf("`", i + 1);
      if (closeIndex !== -1) {
        flushText();
        spans.push({ kind: "code", text: source.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
    }

    if (source.startsWith("**", i)) {
      const closeIndex = source.indexOf("**", i + 2);
      if (closeIndex !== -1) {
        flushText();
        spans.push({ kind: "bold", text: source.slice(i + 2, closeIndex) });
        i = closeIndex + 2;
        continue;
      }
    }

    if (source[i] === "*" || source[i] === "_") {
      const marker = source[i];
      const closeIndex = source.indexOf(marker, i + 1);
      if (closeIndex !== -1 && closeIndex > i + 1) {
        flushText();
        spans.push({ kind: "italic", text: source.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
    }

    if (source[i] === "[") {
      const match = LINK_PATTERN.exec(remaining);
      if (match) {
        flushText();
        spans.push({ kind: "link", text: match[1]!, href: match[2]! });
        i += match[0].length;
        continue;
      }
    }

    textBuffer += source[i];
    i += 1;
  }

  flushText();
  return spans;
}

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compat
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x20000, 0x3fffd], // CJK Extension B+
];

const COMBINING_RANGES: Array<[number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
];

function codePointWidth(codePoint: number): number {
  if (COMBINING_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
    return 0;
  }
  if (WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0)!);
  }
  return width;
}

export function truncateToWidth(text: string, max: number): string {
  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = codePointWidth(char.codePointAt(0)!);
    if (width + charWidth > max) break;
    width += charWidth;
    result += char;
  }
  return result;
}

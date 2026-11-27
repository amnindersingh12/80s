import { describe, expect, it } from "vitest";
import { activeLrcIndex, parseLrc } from "../src/lib/lrc";

describe("LRC synced lyrics parser", () => {
  it("parses standard and multi-timestamp LRC lines in chronological order", () => {
    const raw = `
[ti:Karma Police]
[00:26.78] Karma police
[00:30.50][01:10.00] Arrest this man
[00:34.100] He talks in maths
`;
    const lines = parseLrc(raw);
    expect(lines).toEqual([
      { timeSec: 26.78, text: "Karma police" },
      { timeSec: 30.5, text: "Arrest this man" },
      { timeSec: 34.1, text: "He talks in maths" },
      { timeSec: 70, text: "Arrest this man" },
    ]);
    expect(activeLrcIndex(lines, 10)).toBe(-1);
    expect(activeLrcIndex(lines, 26.8)).toBe(0);
    expect(activeLrcIndex(lines, 32.0)).toBe(1);
    expect(activeLrcIndex(lines, 71.0)).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import { correctionToSeconds, displayFileName, formatBytes } from "./sources";

describe("source display helpers", () => {
  it("formats file sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("extracts names from Windows and Unix paths", () => {
    expect(displayFileName("D:\\DCIM\\IMG_1.CR3")).toBe("IMG_1.CR3");
    expect(displayFileName("/media/card/DCIM/IMG_2.JPG")).toBe("IMG_2.JPG");
  });

  it("converts manual corrections to seconds", () => {
    expect(correctionToSeconds(2, "hours")).toBe(7200);
    expect(correctionToSeconds(-15, "minutes")).toBe(-900);
    expect(correctionToSeconds(30, "seconds")).toBe(30);
  });
});

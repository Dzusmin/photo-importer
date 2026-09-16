import { describe, expect, it } from "vitest";
// @ts-expect-error This project intentionally omits Node typings from browser code.
import { readFileSync } from "node:fs";

const appCss = readFileSync("src/App.css", "utf8");

describe("narrow review action bar CSS contract", () => {
  it("fixes the bar to the review viewport and reserves room for it only at the narrow breakpoint", () => {
    const narrowRules = appCss.slice(
      appCss.lastIndexOf("@media (max-width: 560px)"),
    );

    expect(narrowRules).toMatch(
      /\.scan-results\s*{[^}]*padding-bottom:\s*var\(--review-mobile-cta-height\)/s,
    );
    expect(narrowRules).toMatch(
      /\.review-mobile-cta\s*{[^}]*position:\s*fixed[^}]*right:\s*0[^}]*bottom:\s*0[^}]*left:\s*54px/s,
    );
    expect(appCss).toMatch(/\.review-mobile-cta\s*{\s*display:\s*none;/);
  });
});

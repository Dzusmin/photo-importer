import { describe, expect, it } from "vitest";
import appStyles from "../App.css?raw";
import tokenStyles from "../styles/tokens.css?raw";
import darkTheme from "../styles/themes/dark.css?raw";
import highContrastTheme from "../styles/themes/high-contrast.css?raw";
import lightTheme from "../styles/themes/light.css?raw";

const colorProperty = /--color-[\w-]+\s*:/g;
const colorReference = /var\((--color-[\w-]+)/g;

function propertyNames(styles: string) {
  return new Set(
    [...styles.matchAll(colorProperty)].map((match) =>
      match[0].replace(/\s*:/, ""),
    ),
  );
}

describe("theme styles", () => {
  it("keeps component colors behind semantic tokens", () => {
    expect(appStyles).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(appStyles).not.toMatch(/rgba?\(\s*\d/i);
  });

  it("defines the same token contract for every theme", () => {
    const darkProperties = propertyNames(darkTheme);
    expect(propertyNames(lightTheme)).toEqual(darkProperties);
    expect(propertyNames(highContrastTheme)).toEqual(darkProperties);
  });

  it("defines every color token referenced by component styles", () => {
    const definitions = propertyNames(
      `${tokenStyles}\n${darkTheme}\n${lightTheme}\n${highContrastTheme}`,
    );
    const references = [
      ...`${appStyles}\n${tokenStyles}`.matchAll(colorReference),
    ].map((match) => match[1]);

    expect(references.filter((name) => !definitions.has(name))).toEqual([]);
  });
});

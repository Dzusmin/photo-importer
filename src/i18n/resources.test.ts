import { describe, expect, it } from "vitest";
import en from "./resources/en.json";
import pl from "./resources/pl.json";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("translation resources", () => {
  it("contains the same keys in English and Polish", () => {
    expect(leafKeys(pl).sort()).toEqual(leafKeys(en).sort());
  });
});

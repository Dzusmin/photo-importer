import { describe, expect, it } from "vitest";

import tauriConfig from "../src-tauri/tauri.conf.json";

describe("responsive window contract", () => {
  it("supports a 420 px wide application window", () => {
    expect(tauriConfig.app.windows).not.toHaveLength(0);
    expect(tauriConfig.app.windows[0]?.minWidth).toBe(420);
  });
});

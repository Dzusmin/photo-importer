import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestThumbnail,
  resetThumbnailMemoryCache,
} from "./thumbnailManager";

const { getMediaThumbnail, convertFileSrc } = vi.hoisted(() => ({
  getMediaThumbnail: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));
vi.mock("./sources", () => ({ getMediaThumbnail }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc }));

function payload(path: string) {
  return {
    key: path,
    path: `${path}.jpg`,
    mimeType: "image/jpeg" as const,
    width: 320,
    height: 200,
    cacheHit: false,
    timings: {
      lookupMs: 1,
      decodeMs: 2,
      resizeMs: 1,
      encodeAndPersistMs: 2,
      databaseMs: 1,
      totalMs: 7,
    },
  };
}

describe("thumbnailManager", () => {
  beforeEach(() => {
    resetThumbnailMemoryCache();
    getMediaThumbnail.mockReset();
    convertFileSrc.mockClear();
  });

  it("deduplicates identical requests and keeps the resolved URL in memory", async () => {
    getMediaThumbnail.mockResolvedValue(payload("photo"));

    const [first, second] = await Promise.all([
      requestThumbnail("photo", 320),
      requestThumbnail("photo", 320),
    ]);
    const third = await requestThumbnail("photo", 320);

    expect(getMediaThumbnail).toHaveBeenCalledTimes(1);
    expect(first.url).toBe("asset://photo.jpg");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("limits concurrency, prioritizes preview and drops a cancelled queued request", async () => {
    const pending: Array<{
      path: string;
      resolve: (value: ReturnType<typeof payload>) => void;
    }> = [];
    getMediaThumbnail.mockImplementation(
      (path: string) =>
        new Promise((resolve) => pending.push({ path, resolve })),
    );
    const running = ["one", "two", "three", "four"].map((path) =>
      requestThumbnail(path, 320),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));

    const cancelled = new AbortController();
    const discarded = requestThumbnail("discarded", 320, {
      priority: "prefetch",
      signal: cancelled.signal,
    });
    cancelled.abort();
    await expect(discarded).rejects.toMatchObject({ name: "AbortError" });
    const preview = requestThumbnail("preview", 1_600, {
      priority: "preview",
    });

    pending[0].resolve(payload(pending[0].path));
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    expect(pending[4].path).toBe("preview");
    expect(pending.some((entry) => entry.path === "discarded")).toBe(false);

    for (const entry of pending.slice(1)) entry.resolve(payload(entry.path));
    await Promise.all([...running, preview]);
  });
});

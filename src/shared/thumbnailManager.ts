import { convertFileSrc } from "@tauri-apps/api/core";
import { getMediaThumbnail, type ThumbnailPayload } from "./sources";

const MAX_CONCURRENT_REQUESTS = 4;
const MEMORY_CACHE_LIMIT = 256;
const TIMING_SAMPLE_LIMIT = 200;

export type ThumbnailPriority = "prefetch" | "visible" | "preview";

export interface ManagedThumbnail extends ThumbnailPayload {
  url: string;
}

interface QueueEntry {
  key: string;
  path: string;
  maxDimension: number;
  priority: number;
  sequence: number;
  consumers: number;
  started: boolean;
  promise: Promise<ManagedThumbnail>;
  resolve: (value: ManagedThumbnail) => void;
  reject: (reason: unknown) => void;
}

const queue: QueueEntry[] = [];
const inFlight = new Map<string, QueueEntry>();
const memoryCache = new Map<string, ManagedThumbnail>();
const timingSamples: ThumbnailPayload["timings"][] = [];
let activeRequests = 0;
let nextSequence = 1;

export function requestThumbnail(
  path: string,
  maxDimension: number,
  options: { priority?: ThumbnailPriority; signal?: AbortSignal } = {},
): Promise<ManagedThumbnail> {
  const key = requestKey(path, maxDimension);
  const cached = memoryCache.get(key);
  if (cached) {
    touchMemoryCache(key, cached);
    return abortable(Promise.resolve(cached), options.signal);
  }
  let entry = inFlight.get(key);
  if (!entry) {
    let resolve: (value: ManagedThumbnail) => void = () => undefined;
    let reject: (reason: unknown) => void = () => undefined;
    const promise = new Promise<ManagedThumbnail>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    entry = {
      key,
      path,
      maxDimension,
      priority: priorityValue(options.priority ?? "visible"),
      sequence: nextSequence++,
      consumers: 0,
      started: false,
      promise,
      resolve,
      reject,
    };
    inFlight.set(key, entry);
    queue.push(entry);
  } else {
    entry.priority = Math.max(
      entry.priority,
      priorityValue(options.priority ?? "visible"),
    );
  }
  entry.consumers += 1;
  drainQueue();
  return subscribe(entry, options.signal);
}

export function resetThumbnailMemoryCache() {
  memoryCache.clear();
  for (const entry of queue) {
    if (!entry.started) entry.reject(abortError());
  }
  queue.splice(0, queue.length);
  for (const [key, entry] of inFlight) {
    if (!entry.started) inFlight.delete(key);
  }
}

export function getThumbnailPerformanceSnapshot() {
  const samples = [...timingSamples];
  const totals = samples.map((sample) => sample.totalMs).sort((a, b) => a - b);
  return {
    sampleCount: samples.length,
    p50TotalMs: percentile(totals, 0.5),
    p95TotalMs: percentile(totals, 0.95),
    latest: samples.length > 0 ? samples[samples.length - 1] : null,
  };
}

function subscribe(entry: QueueEntry, signal?: AbortSignal) {
  if (!signal) return entry.promise;
  if (signal.aborted) {
    releaseConsumer(entry);
    return Promise.reject(abortError());
  }
  return new Promise<ManagedThumbnail>((resolve, reject) => {
    const abort = () => {
      releaseConsumer(entry);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) reject(error);
      },
    );
  });
}

function releaseConsumer(entry: QueueEntry) {
  entry.consumers = Math.max(0, entry.consumers - 1);
  if (!entry.started && entry.consumers === 0) {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    inFlight.delete(entry.key);
    entry.reject(abortError());
  }
}

function drainQueue() {
  queue.sort(
    (left, right) =>
      right.priority - left.priority || left.sequence - right.sequence,
  );
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const entry = queue.shift();
    if (!entry || entry.consumers === 0) continue;
    entry.started = true;
    activeRequests += 1;
    void getMediaThumbnail(entry.path, entry.maxDimension)
      .then((payload) => {
        const thumbnail = {
          ...payload,
          url: convertFileSrc(payload.path),
        };
        remember(entry.key, thumbnail);
        rememberTiming(payload.timings);
        entry.resolve(thumbnail);
      })
      .catch(entry.reject)
      .finally(() => {
        activeRequests -= 1;
        inFlight.delete(entry.key);
        drainQueue();
      });
  }
}

function remember(key: string, value: ManagedThumbnail) {
  touchMemoryCache(key, value);
  while (memoryCache.size > MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryCache.delete(oldest);
  }
}

function touchMemoryCache(key: string, value: ManagedThumbnail) {
  memoryCache.delete(key);
  memoryCache.set(key, value);
}

function rememberTiming(value: ThumbnailPayload["timings"]) {
  timingSamples.push(value);
  if (timingSamples.length > TIMING_SAMPLE_LIMIT) timingSamples.shift();
}

function requestKey(path: string, maxDimension: number) {
  return `${path}\0${maxDimension}`;
}

function priorityValue(priority: ThumbnailPriority) {
  if (priority === "preview") return 100;
  if (priority === "visible") return 50;
  return 10;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortError() {
  return new DOMException("Thumbnail request was cancelled", "AbortError");
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  return values[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ];
}

if (typeof window !== "undefined") {
  window.addEventListener("thumbnail-cache-cleared", resetThumbnailMemoryCache);
}

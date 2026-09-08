# Thumbnail performance

## Running the benchmark

```powershell
cargo bench -p importer-thumbnails --bench thumbnail_pipeline
```

The benchmark creates a synthetic 6000 × 4000 px JPEG and separately measures
cold generation and a cache hit at 320 and 1600 px. Run measurements with the
`bench`/release profile; debug results do not represent the performance of the
finished application.

## Reference result — Windows, September 1, 2026

| Scenario                  |           Time |
| ------------------------- | -------------: |
| Cold 24 MP JPEG → 320 px  |   57.8–61.5 ms |
| Warm cache, 320 px        |       49–52 µs |
| Cold 24 MP JPEG → 1600 px | 160.8–183.7 ms |
| Warm cache, 1600 px       |   61.8–65.8 µs |

Results depend on the CPU and storage device, so they serve as a local
reference point rather than a guarantee for every computer.

Development mode retains debug information for the application but compiles
the thumbnail pipeline and codec libraries with `opt-level = 3`. Without it,
the lack of optimization alone increased 320 px thumbnail generation on the
reference machine from about 60–66 ms to about 588 ms.

## Architecture

- JPEG uses the embedded EXIF thumbnail first; when one is unavailable, the
  image is reduced through IDCT scaling during decoding.
- RAW uses an embedded thumbnail or preview first.
- Cache v3 stores JPEG quality 84 and can be rebuilt.
- Up to four different thumbnails can be generated concurrently.
- Identical requests share a single job.
- SQLite uses a single persistent connection, and cache size is tracked by a
  counter.
- The WebView receives an asset URL instead of a byte array serialized to JSON.
- The frontend queue prioritizes the full preview and removes invisible jobs
  that have not yet started.
- A full JPEG preview exposes the original file without creating another cache
  version. RAW still receives a 1600 px preview generated from the embedded
  image.
- Event cards outside the viewport use `content-visibility`, allowing the
  WebView to skip their layout and rendering.

Every backend response contains lookup, decode, resize, encode/persist,
database, and total timings. The latest 200 samples can be retrieved through
`getThumbnailPerformanceSnapshot()`.

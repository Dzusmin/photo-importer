use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use image::{ImageBuffer, Rgb};
use importer_thumbnails::ThumbnailCache;

fn thumbnail_pipeline(criterion: &mut Criterion) {
    let fixtures = tempfile::tempdir().expect("fixture directory");
    let source = fixtures.path().join("large-camera.jpg");
    ImageBuffer::from_fn(6_000, 4_000, |x, y| {
        Rgb([
            u8::try_from(x % 255).unwrap_or(0),
            u8::try_from(y % 255).unwrap_or(0),
            u8::try_from((x + y) % 255).unwrap_or(0),
        ])
    })
    .save(&source)
    .expect("JPEG fixture");

    let mut group = criterion.benchmark_group("thumbnail_pipeline");
    for dimension in [320, 1_600] {
        group.bench_with_input(
            BenchmarkId::new("cold_large_jpeg", dimension),
            &dimension,
            |bencher, &dimension| {
                bencher.iter_batched(
                    || tempfile::tempdir().expect("cache directory"),
                    |cache_directory| {
                        let cache = ThumbnailCache::open(cache_directory.path()).unwrap();
                        cache.get_or_create(&source, dimension).unwrap()
                    },
                    criterion::BatchSize::SmallInput,
                );
            },
        );

        let warm_directory = tempfile::tempdir().expect("warm cache directory");
        let warm_cache = ThumbnailCache::open(warm_directory.path()).unwrap();
        warm_cache.get_or_create(&source, dimension).unwrap();
        group.bench_with_input(
            BenchmarkId::new("warm_cache", dimension),
            &dimension,
            |bencher, &dimension| {
                bencher.iter(|| warm_cache.get_or_create(&source, dimension).unwrap());
            },
        );
    }
    group.finish();
}

criterion_group!(benches, thumbnail_pipeline);
criterion_main!(benches);

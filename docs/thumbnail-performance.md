# Wydajność miniaturek

## Uruchomienie pomiaru

```powershell
cargo bench -p importer-thumbnails --bench thumbnail_pipeline
```

Benchmark tworzy syntetyczny JPEG 6000 × 4000 px i mierzy osobno zimne
generowanie oraz trafienie w cache dla rozmiarów 320 i 1600 px. Pomiary należy
wykonywać w profilu `bench`/release; wyniki debug nie opisują wydajności gotowej
aplikacji.

## Wynik referencyjny — Windows, 1 września 2026

| Scenariusz                 |           Czas |
| -------------------------- | -------------: |
| Zimny JPEG 24 MP → 320 px  |   57,8–61,5 ms |
| Ciepły cache 320 px        |       49–52 µs |
| Zimny JPEG 24 MP → 1600 px | 160,8–183,7 ms |
| Ciepły cache 1600 px       |   61,8–65,8 µs |

Wyniki zależą od CPU i dysku, dlatego służą jako lokalny punkt odniesienia, a
nie gwarancja dla wszystkich komputerów.

Tryb developerski zachowuje informacje debugowe dla aplikacji, ale kompiluje
potok miniaturek i biblioteki kodeków z `opt-level = 3`. Bez tego sam brak
optymalizacji wydłużał na maszynie referencyjnej generowanie miniatury 320 px
z około 60–66 ms do około 588 ms.

## Architektura

- JPEG jest redukowany przez skalowanie IDCT podczas dekodowania.
- RAW korzysta najpierw z osadzonej miniatury lub podglądu.
- Cache v2 przechowuje JPEG quality 84 i jest odtwarzalny.
- Do czterech różnych miniaturek może powstawać równolegle.
- Identyczne żądania współdzielą jedną pracę.
- SQLite jest utrzymywany w jednym połączeniu, a rozmiar cache w liczniku.
- WebView otrzymuje URL asset zamiast tablicy bajtów serializowanej do JSON.
- Kolejka frontendu preferuje pełny podgląd i usuwa niewidoczne, jeszcze
  nierozpoczęte zadania.

Każda odpowiedź backendu zawiera czasy lookup, decode, resize, encode/persist,
database oraz total. Ostatnie 200 próbek można odczytać przez
`getThumbnailPerformanceSnapshot()`.

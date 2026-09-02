# Photo Importer

Wieloplatformowa aplikacja do bezpiecznego importowania zdjęć, grupowania ich w
wydarzenia i wykonywania zweryfikowanych kopii zapasowych.

Projekt ma działający szkielet oraz kompletny pion ustawień: model domenowy,
walidację, zapis atomowy, kopię bezpieczeństwa, komendy Tauri i ekran React.

## Stan bazowy

Stan funkcjonalny na 2 września 2026 r. obejmuje:

- aplikację desktopową Tauri z interfejsem React do konfiguracji, wykrywania i
  skanowania źródeł, grupowania materiału w wydarzenia oraz podglądu miniatur,
- deterministyczne planowanie i wznawialne wykonywanie importu z kontrolą
  kolizji, sumami SHA-256 i trwałym manifestem SQLite,
- monitorowanie kart pamięci, pracę w zasobniku, autostart i powiadomienia,
- lokalne, wersjonowane i weryfikowane kopie zapasowe biblioteki,
- testy jednostkowe i integracyjne frontendu oraz wszystkich crates Rust,
  uruchamiane również przez usługę `ci` w Docker Compose.

Aktualne ograniczenia: HEIC i filmy mają placeholder zamiast generowanej
miniatury, Docker weryfikuje aplikację w Linuksie, ale nie tworzy natywnych
instalatorów, a obsługa NAS i udziałów sieciowych nie jest jeszcze
zaimplementowana. Dane uruchomieniowe (ustawienia, manifest i cache miniatur)
powstają w systemowych katalogach aplikacji, nie w repozytorium.

## Wymagania na Windows

- Node.js 24
- Rust 1.98 przez `rustup`
- Visual Studio z workloadem **Desktop development with C++**
- WebView2 Runtime (standardowo obecny w Windows 10/11)

Po pierwszej instalacji Rusta należy otworzyć nowy terminal, aby Cargo znalazło
się w `PATH`.

## Uruchomienie

```powershell
npm ci
npm run desktop:dev
```

## Kontrole jakości

```powershell
npm run check
npm run test:coverage
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo bench -p importer-thumbnails --bench thumbnail_pipeline
```

Opis pomiarów i wynik referencyjny znajduje się w
[`docs/thumbnail-performance.md`](docs/thumbnail-performance.md).

Testy frontendu używają Vitest, Testing Library i mockowanego IPC Tauri. Raport
HTML trafia do `coverage/`; progi pokrycia są egzekwowane przez `npm run check`
i workflow CI. Rustowe testy obejmują osobne crates oraz pełny przepływ
`skan → grupowanie → plan → import → ponowne rozpoznanie w manifeście`.

## Docker

Kontener uruchamia testy frontendu i Rust w środowisku Linux:

```powershell
docker compose run --build --rm ci
```

Polecenie korzysta z plików blokad `package-lock.json`, `Cargo.lock` i
przypiętego toolchaina Rust 1.98, dzięki czemu stan bazowy jest odtwarzalny.

Docker nie buduje instalatorów dla wszystkich platform. Artefakty Windows,
macOS i Linux muszą być budowane przez natywne runnery odpowiednich systemów.
Workflow w `.github/workflows/ci.yml` wykonuje kontrole Rust na trzech systemach.

## Architektura

- `src/` — interfejs React/TypeScript
- `src-tauri/` — cienka integracja aplikacji z systemem operacyjnym
- `crates/importer-domain/` — reguły biznesowe niezależne od Tauri i systemu
- `crates/importer-background/` — stan i decyzje monitora nośników niezależne od Tauri
- `crates/importer-backup/` — rejestr dysków i wersjonowane, weryfikowane kopie lokalne
- `crates/importer-import/` — transakcyjne kopiowanie, weryfikacja i wznawianie sesji
- `crates/importer-manifest/` — historia importów i rozpoznawanie zawartości
- `crates/importer-media/` — wykrywanie nośników, skan plików i grupowanie wydarzeń
- `crates/importer-plan/` — bezpieczne, deterministyczne planowanie ścieżek importu
- `crates/importer-settings/` — wersjonowany odczyt i atomowy zapis ustawień JSON
- `crates/importer-thumbnails/` — wersjonowany, usuwalny cache podglądów JPEG

Repozytorium ustawień otrzymuje katalog konfiguracji od warstwy aplikacji. Przy
drugim i każdym kolejnym zapisie poprzedni poprawny `settings.json` trafia do
`settings.json.bak`. Uszkodzony plik główny nie jest automatycznie nadpisywany,
a odzyskanie danych z kopii wymaga jawnego wywołania operacji przywracania.

Ekran ustawień pozwala skonfigurować bibliotekę, zachowanie importu, podział na
wydarzenia, nazwy folderów, profile aparatów, korekty czasu oraz preferencje
lokalne. Eksportowany JSON zawiera tylko część przenośną — pomija lokalne ścieżki,
autostart, minimalizację i identyfikatory nośników. Import jest walidowany i
zapisywany tym samym bezpiecznym mechanizmem co zwykła edycja.

Ekran startowy odświeża listę nośników co 5 sekund, wykrywa karty wymienne oraz
woluminy zawierające `DCIM` i pozwala skanować ręcznie wskazane katalogi. Skaner
rozpoznaje popularne JPEG, HEIC, formaty RAW, filmy i XMP. Pliki RAW+JPEG oraz ich
sidecar są składane w jedną pozycję, a pozycje trafiają do wydarzeń według
przerwy skonfigurowanej przez użytkownika. Czas wykonania jest odczytywany z EXIF
lub metadanych filmu, z kontrolowanym fallbackiem do czasu modyfikacji pliku.
Wynik skanu pozwala skorygować czas jednej lub wielu pozycji i natychmiast
ponownie grupuje wydarzenia.

`crates/importer-manifest/` przechowuje wersjonowaną bazę SQLite plików już
zaimportowanych. Porównanie zaczyna się od rozmiaru, a dla potencjalnych trafień
wykorzystuje SHA-256 zawartości. Dzięki temu zmiana nazwy pliku lub użycie innej
karty nie powoduje ponownego importu tego samego materiału.
Odczyt EXIF jest wykonywany przez ograniczoną pulę 2–4 pracowników, z osobnym
parserem dla każdego pracownika. Wyniki zachowują kolejność odkrycia. Pełne
haszowanie na jednym nośniku pozostaje sekwencyjne i korzysta ze wskazówki
sekwencyjnego odczytu na Windows. Po zweryfikowaniu pliku manifest zapisuje cache
powiązany z tożsamością nośnika, ścieżką, rozmiarem, czasem modyfikacji oraz
SHA-256 pierwszych i ostatnich 128 KiB. Ponowny skan niezmienionego źródła nie
musi dzięki temu ponownie czytać całej zawartości pliku.

Po skanowaniu można nadać nazwy wydarzeniom, wykluczyć całe wydarzenia lub
pojedyncze pozycje i przygotować plan importu bez zapisywania czegokolwiek w
bibliotece. Planner rozwija szablon folderów, neutralizuje nazwy niedozwolone na
Windows/macOS/Linux, blokuje ścieżki absolutne i `..`, pomija pliki rozpoznane w
manifeście oraz pokazuje dokładną ścieżkę każdego pliku. Kolizje zatrzymują plan
albo dostają wspólny kolejny numer dla całej pary RAW+JPEG+XMP — zgodnie z
ustawieniem użytkownika.

Gotowy plan można zapisać jako trwałą sesję importu i uruchomić. Każdy plik jest
kopiowany do należącego do sesji pliku `.partial`, synchronizowany, porównywany
z oryginałem przez SHA-256 i publikowany bez nadpisywania istniejącej ścieżki.
Manifest jest aktualizowany dopiero po udanej weryfikacji. Postęp, błędy oraz
żądania pauzy i anulowania są przechowywane w SQLite, dzięki czemu przerwany
import można wznowić po ponownym uruchomieniu aplikacji. Tryb przenoszenia usuwa
źródła dopiero po zweryfikowaniu wszystkich zaplanowanych kopii i wymaga
dodatkowego potwierdzenia.

Skanowanie działa jako zadanie raportujące kolejne fazy. Podczas odkrywania
plików interfejs pokazuje animowany pasek, a po ustaleniu liczby obsługiwanych
plików przechodzi na dokładny postęp procentowy. Zadanie można anulować, a drugi
skan tego samego źródła nie jest uruchamiany równolegle.
Etap porównywania z historią pokazuje dodatkowo liczbę bajtów odczytanych z
nośnika, trafienia cache i liczbę pełnych odczytów. Wynik skanu zawiera czasy
odkrywania plików i odczytu metadanych, co umożliwia porównywanie wydajności na
rzeczywistych kartach.

Miniatury są generowane na żądanie tylko dla elementów zbliżających się do
widocznego obszaru. Trafiają jako JPEG do systemowego katalogu cache aplikacji,
w `thumbnails/v2`, obok lokalnego `index.sqlite3`. Cache ma limit 5 GB i usuwa
najdawniej używane wpisy. Kolejka deduplikuje identyczne żądania, wykonuje do
czterech prac równolegle i daje pierwszeństwo pełnemu podglądowi. JPEG jest
dekodowany ze wstępnym skalowaniem, a dla RAW aplikacja najpierw pobiera osadzoną
miniaturę lub podgląd przez `rawler`, bez dekodowania matrycy. Pliki cache są
udostępniane WebView bez kosztownej serializacji bajtów do JSON. Nieobsługiwane
HEIC i filmy otrzymują placeholder bez wpływu na skanowanie lub import. Cache
można bezpiecznie wyczyścić na ekranie ustawień.

Monitor nośników działa w osobnym zadaniu także wtedy, gdy główne okno jest
ukryte. Co pięć sekund porównuje migawkę woluminów, reaguje tylko na faktyczne
podłączenie znanej karty i ponownie pozwala na reakcję dopiero po jej odłączeniu.
Zachowanie `zapytaj`, `skanuj automatycznie` lub `ignoruj` pochodzi z profilu
aparatu przypisanego do odcisku nośnika. Automatyczny skan korzysta z tej samej
kolejki, deduplikacji i paska postępu co skan ręczny. Panel na ekranie startowym
pokazuje stan automatu, liczbę kart, aktywne skany i ostatnie zdarzenie.

Aplikacja ma ikonę zasobnika z akcjami pokazania okna, natychmiastowej kontroli
nośników i zakończenia programu. Zamknięcie okna ukrywa je, gdy włączono opcję
minimalizacji do zasobnika; przy wyłączonej opcji kończy aplikację. Trwająca
sesja importu blokuje przypadkowe zamknięcie, aby kopiowanie nie zostało przerwane
w połowie pliku. Ustawienie autostartu jest synchronizowane z systemem, a start
przy logowaniu używa argumentu `--background`, dzięki czemu przy włączonej
minimalizacji okno pozostaje ukryte. Powiadomienia systemowe informują o znanej
karcie oczekującej na decyzję oraz o wyniku automatycznego skanu. Na Windows
pełna identyfikacja i ikona powiadomień są dostępne w zainstalowanym buildzie;
w trybie developerskim system może pokazać nazwę PowerShell.

Silnik kopii zapasowych rejestruje dyski pod trwałym UUID zapisanym zarówno w
lokalnym rejestrze, jak i na nośniku. Chroni to przed zapisaniem kopii na innym
dysku, który przypadkiem dostał tę samą literę. Biblioteka jest odwzorowana w
czytelnym `Photo Backup/Photos`, a manifest SQLite, znacznik dysku i starsze
wersje znajdują się w `Photo Backup/.photo-importer`. Plan porównuje SHA-256
źródła, manifestu i bieżącej kopii, więc pomija niezmienione pliki oraz wykrywa
uszkodzenie kopii. Nowa zawartość jest zapisywana do pliku tymczasowego,
synchronizowana i weryfikowana przed publikacją; zastępowana wersja trafia do
ukrytego archiwum i nie jest kasowana.

Kolejnym etapem będą adaptery NAS i udziałów sieciowych.

Kolejne komponenty silnika będą dodawane jako niezależne crates, aby można było
je testować również bez uruchamiania interfejsu desktopowego.

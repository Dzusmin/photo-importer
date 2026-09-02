# Automatyczne przygotowanie importu po podłączeniu karty

## Cel

Po wykryciu karty aplikacja ma rozpoznać znany nośnik, odczytać profile aparatów
z EXIF, wykonać skan w tle i przygotować plan importu. Sam import zawsze wymaga
jawnego zatwierdzenia planu przez użytkownika.

Zakres tego etapu obejmuje karty źródłowe. Automatyczny backup biblioteki na
zewnętrzny dysk pozostaje osobnym, późniejszym etapem.

## Uzgodnione zachowanie

- Zachowanie jest konfigurowane osobno dla każdej karty: `ask`,
  `autoPreparePlan` albo `ignore`.
- Nieznana karta zawsze wymaga zatwierdzenia wykrytych profili aparatów.
- Profil otrzymuje domyślną nazwę z `Make` i `Model`, ale użytkownik może ją
  zmienić przed zapisem.
- Kilka kart może korzystać z tego samego profilu aparatu.
- Jedna karta może zawierać materiały z wielu aparatów. Powstaje jeden plan z
  widocznymi sekcjami aparatów.
- Materiały bez dopasowania trafiają do sekcji „Nieznany aparat” i można je
  przypisać ręcznie.
- Obecność `DCIM` powoduje automatyczne rozpoznanie potencjalnej karty. Nośnik
  bez `DCIM` można przeskanować i zapamiętać ręcznie.
- Powiadomienie systemowe otwiera aplikację, ale nie zastępuje trwałego panelu
  oczekującej karty. Stan oczekiwania trwa do rozpoczęcia skanu, jawnego
  zignorowania albo odłączenia nośnika.
- Domyślnie aplikacja nie wymusza pokazania okna. Opcja „Pokaż okno po
  przygotowaniu planu” jest konfigurowalna.
- Pauza i anulowanie są honorowane pomiędzy całymi zestawami mediów
  (np. RAW+JPEG+XMP), nie pomiędzy plikami jednego zestawu.
- Odłączenie karty zatrzymuje sesję jako błąd możliwy do wznowienia.
- Ponowne podłączenie tej samej karty wskazuje pasującą sesję bez pełnego
  ponownego skanowania.
- Po restarcie domyślnie wymagane jest potwierdzenie wznowienia. Użytkownik może
  włączyć automatyczne wznowienie.
- Anulowanie pozwala zachować ukończone pliki albo wycofać wyłącznie pliki
  dodane przez daną sesję.
- Domyślny limit równoległych importów wynosi 2 i może zostać zwiększony w
  ustawieniach.
- Funkcja ma działać na Windows, macOS i Linux.

## Model domenowy i migracja ustawień

### Schemat ustawień v2

Zwiększyć `CURRENT_SETTINGS_SCHEMA_VERSION` do 2 i dodać jawną migrację v1 →
v2. Obecny dekoder odrzuca każdą starszą wersję, dlatego migracja musi nastąpić
na wartości JSON przed deserializacją i walidacją.

`CameraProfile` powinien opisywać aparat, a nie zachowanie karty:

```text
CameraProfile
  id
  name
  exifMatchers[] { make, model, serialNumber }
  defaultTimeOffsetSeconds
```

Usunąć `onConnect` z profilu. Zachowanie przenieść do lokalnego powiązania
konkretnego nośnika:

```text
SourceBinding
  id
  sourceIdentity
  displayName
  behavior: ask | autoPreparePlan | ignore
  cameraProfileIds[]
  markerState
  lastSeenAtUnixMs
```

`cameraProfileIds` zastępuje pojedyncze `cameraProfileId`, ponieważ jedna karta
może zawierać zdjęcia z wielu aparatów. Dane powiązań pozostają lokalne i nie są
eksportowane wraz z ustawieniami przenośnymi.

Do `LocalSettings` dodać:

```text
maxConcurrentImports: 2
resumeAfterRestart: ask | automatic
showWindowWhenPlanReady: false
notificationsEnabled: true
```

Migracja zachowuje dotychczasowe działanie: dla każdego starego
`SourceBinding` kopiuje `CameraProfile.onConnect` do nowego `behavior`, a
pojedynczy identyfikator profilu zamienia na listę. Globalne
`knownSourceBehavior` pozostaje wyłącznie wartością domyślną dla nowo
rejestrowanej karty albo zostaje przemianowane na `defaultSourceBehavior`.

### Walidacja

- Identyfikator źródła i `SourceBinding.id` muszą być unikalne.
- Wszystkie `cameraProfileIds` muszą wskazywać istniejące profile.
- Limit równoległości musi mieścić się w bezpiecznym zakresie, np. 1–8.
- Profil EXIF musi mieć co najmniej jedno z pól: producent, model lub numer
  seryjny.
- Ten sam zarejestrowany nośnik nie może jednocześnie pełnić roli karty
  źródłowej i celu backupu. W tym etapie należy przygotować wspólny typ roli
  nośnika; kontrolę z rejestrem `importer-backup` podłączyć podczas realizacji
  automatycznego backupu.

## Identyfikacja karty

Wprowadzić `SourceIdentity`, która przechowuje dostępne sygnały zamiast jednego
odcisku wyliczanego z nazwy i pojemności:

```text
SourceIdentity
  markerUuid?
  platformVolumeId?
  fallbackFingerprint
```

Kolejność dopasowania:

1. UUID znacznika aplikacji zapisany na karcie.
2. Stabilny identyfikator woluminu udostępniany przez system.
3. Obecny odcisk nazwy, systemu plików i pojemności jako fallback wymagający
   ostrożniejszego potwierdzenia.

Znacznik powinien być małym, wersjonowanym plikiem, np.
`.photo-importer/source.json`. Jego zapis jest opcjonalny. Karta tylko do odczytu
albo karta, na której zapis się nie powiedzie, nadal może zostać zarejestrowana.

Adaptery identyfikatora woluminu umieścić za wspólnym traitem w
`importer-media`, z implementacjami dla Windows, macOS i Linux. Nie opierać
logiki domenowej na literze dysku lub ścieżce montowania.

Po sformatowaniu lub zmianie identyfikatorów karta może zostać przedstawiona
jako prawdopodobnie znana. Aplikacja pokazuje wtedy ponowne potwierdzenie zamiast
automatycznie uruchamiać pracę.

## Odczyt i dopasowanie EXIF

Rozszerzyć `importer-media::metadata` z `CaptureTimeReader` do czytnika pełnych
metadanych potrzebnych podczas skanu:

```text
MediaMetadata
  captureTimestamp?
  cameraIdentity? { make, model, serialNumber }
```

Czytać `Make`, `Model` i dostępne tagi numeru seryjnego. Wartości normalizować
przez usunięcie zbędnych spacji i porównywać bez uwzględniania wielkości liter,
ale zachowywać oryginalną pisownię do prezentacji.

Każdy `MediaItem` otrzymuje `cameraIdentity` i `cameraProfileId?`. Dla zestawu
RAW+JPEG+XMP:

- metadane czytać z RAW i JPEG,
- XMP dziedziczy aparat zestawu,
- zgodne wyniki scalać,
- sprzeczne wyniki oznaczać ostrzeżeniem i przypisywać do „Nieznany aparat” do
  czasu decyzji użytkownika.

Dopasowanie do profilu:

1. dokładny numer seryjny, jeśli jest dostępny,
2. producent + model,
3. brak jednoznacznego dopasowania → „Nieznany aparat”.

Nie tworzyć profili bez akceptacji użytkownika. Kreator rejestracji pokazuje
liczbę pozycji dla każdej znalezionej tożsamości, proponowaną nazwę oraz pola
EXIF. Pozwala użyć istniejącego profilu, utworzyć nowy lub pozostawić materiały
jako nieznane.

## Monitor kart i trwały stan oczekiwania

Rozszerzyć `importer-background` tak, aby obserwował:

- znane karty,
- nieznane potencjalne karty z `DCIM`,
- ręcznie wskazane nośniki bez `DCIM`, gdy użytkownik wybierze ich skanowanie.

`SourceConnection` powinno zwracać powiązanie karty i zachowanie per karta,
zamiast nazwy pojedynczego profilu.

Wprowadzić stan przepływu źródła:

```text
detected
awaitingDecision
scanning
awaitingProfileConfirmation
preparingPlan
planReady
importing
disconnected
failedRecoverable
ignoredUntilDisconnect
```

Lista oczekujących kart powinna być częścią `BackgroundStatus`, a nie tylko
ulotnym wpisem w historii zdarzeń. Dzięki temu React może odtworzyć panel po
ponownym otwarciu okna. Po restarcie aplikacji podłączona karta zostanie ponownie
wykryta i wróci do odpowiedniego stanu.

Tryb `ask` tworzy `awaitingDecision`. `autoPreparePlan` rozpoczyna skan, ale dla
niezatwierdzonych zmian profili zatrzymuje się na
`awaitingProfileConfirmation`. `ignore` ustawia `ignoredUntilDisconnect`.

Polecenie „Tym razem ignoruj” nigdy nie zapisuje trwałej zmiany zachowania.

## Automatyczne przygotowanie planu

Po zakończeniu skanu automat powinien użyć tej samej ścieżki domenowej i IPC co
skan ręczny:

1. porównać zawartość z manifestem importów,
2. dopasować albo zatwierdzić profile aparatów,
3. utworzyć domyślne nazwy wydarzeń,
4. przygotować plan,
5. zapisać plan jako oczekujący do zatwierdzenia,
6. wysłać zdarzenie `plan-ready` i powiadomienie systemowe.

`ImportPlan` trzeba rozszerzyć o sekcje aparatów albo stabilne
`cameraProfileId` przy pozycjach. Kontekst zmiennych nazewnictwa
(`camera_make`, `camera_model`, `camera_alias`) musi być liczony per pozycja, a
nie — jak obecnie — raz dla całego skanu.

Plan nie może automatycznie uruchomić kopiowania. Użytkownik może zmienić
przypisania aparatów, nazwy wydarzeń i wykluczenia, a każda taka zmiana unieważnia
poprzedni plan i wymaga jego ponownego przeliczenia.

Stan gotowego planu należy zapisać trwale, najlepiej w SQLite obok sesji
importów. Nie przechowywać wyłącznie obiektu React lub pamięci procesu. Zapis
powinien zawierać tożsamość źródła, wynik skanu potrzebny do odtworzenia widoku,
wersję ustawień/nazewnictwa i status zatwierdzenia.

## Sesje importu, pauza i odporność na odłączenie

Obecny executor zapisuje operacje per plik i sprawdza żądania sterujące przed
każdą operacją. Zmienić jednostkę sterowania na `item_key`:

- rozpoczęty zestaw RAW+JPEG+XMP kończy się w całości,
- pauza lub anulowanie jest wykonywane przed następnym `item_key`,
- postęp nadal może być raportowany per plik,
- w trybie przenoszenia źródła zestawu usuwać dopiero po zweryfikowaniu całego
  zestawu.

Błędy I/O sklasyfikować. Brak źródła lub zmiana punktu montowania daje
`sourceUnavailable` i status `failedRecoverable`, a nie ogólny błąd. Częściowy
plik docelowy nie jest publikowany; przy wznowieniu bieżąca operacja zaczyna się
ponownie i przechodzi pełną weryfikację SHA-256.

Przy ponownym podłączeniu karty monitor wyszukuje nieukończone sesje po
`SourceIdentity`, aktualizuje bieżący root źródła i sprawdza przed wznowieniem:

- czy wszystkie oczekujące ścieżki względne istnieją,
- czy rozmiary są zgodne z zapisanym planem,
- czy ukończone pliki docelowe nadal odpowiadają manifestowi.

Brak pełnego reskanu nie oznacza pominięcia tej kontroli integralności.

Po uruchomieniu aplikacji istniejące sesje `running` nadal są odzyskiwane jako
wstrzymane. Warstwa aplikacji pokazuje decyzję „Wznów”, chyba że ustawiono
`resumeAfterRestart = automatic` i właściwa karta jest dostępna.

## Anulowanie i bezpieczne wycofanie

Rozszerzyć komendę anulowania o tryb:

```text
keepCompleted
rollbackSession
```

Do manifestu dodać powiązanie zaimportowanego rekordu z sesją. Wycofanie może
usunąć plik tylko wtedy, gdy:

- został opublikowany przez wskazaną sesję,
- nadal znajduje się pod zapisaną ścieżką docelową,
- jego bieżący SHA-256 odpowiada wartości zapisanej po imporcie.

Jeśli użytkownik zmienił plik po imporcie, aplikacja nie usuwa go i raportuje
konflikt wymagający ręcznej decyzji. Usunięcie pliku i rekordu manifestu powinno
być rejestrowane etapami, aby przerwany rollback można było wznowić. Nie usuwać
folderów, chyba że są puste i zostały utworzone przez tę sesję.

Dla trybu `MoveAfterVerification` rollback nie może obiecywać odtworzenia pliku
na karcie, jeśli źródło zostało już usunięte. UI musi wtedy jasno pokazać, że
możliwe jest tylko usunięcie kopii z biblioteki, co oznaczałoby utratę jedynej
kopii. Domyślnie rollback dla takich zestawów powinien być zablokowany albo
wymagać dodatkowego ostrzeżenia.

## Równoległość i rezerwacja ścieżek

Zastąpić bezpośrednie uruchamianie każdej sesji kolejką zarządzaną przez
`ImportService`:

- limit globalny pochodzi z `maxConcurrentImports`, domyślnie 2,
- jedna karta może mieć najwyżej jedną aktywną sesję,
- różne karty mogą importować równolegle,
- zmiana limitu wpływa na nowe uruchomienia, bez przerywania trwających zestawów.

Plany przygotowane równolegle mogą wskazać tę samą ścieżkę. Dodać trwałą
rezerwację ścieżek docelowych dla aktywnych planów/sesji. Zatwierdzenie planu
wykonuje atomową kontrolę kolizji z systemem plików i rezerwacjami innych sesji.
Rezerwacje zwalniać po zakończeniu, anulowaniu lub skutecznym rollbacku.

## UX

### Panel oczekujących kart

Na ekranie startowym dodać trwałą listę kart wymagających uwagi. Każda karta
pokazuje nazwę, pojemność, punkt montowania, stan oraz akcje właściwe dla stanu.

Dla `awaitingDecision`:

- „Skanuj i przygotuj plan”,
- „Tym razem ignoruj”,
- „Zmień zachowanie tej karty”.

Dla `awaitingProfileConfirmation`:

- lista znalezionych aparatów i liczba pozycji,
- wybór istniejącego profilu lub utworzenie nowego,
- edytowalna proponowana nazwa,
- sekcja „Nieznany aparat”.

Dla `planReady`:

- „Otwórz plan”,
- krótkie podsumowanie liczby aparatów, wydarzeń, plików i rozmiaru.

### Plan

Wynik grupować najpierw według aparatu, następnie według wydarzenia. Sekcja
„Nieznany aparat” ma akcję zbiorczego lub pojedynczego przypisania profilu.
Przeniesienie pozycji między profilami natychmiast unieważnia plan.

### Sterowanie sesją

- Pasek pokazuje postęp bajtów i zestawów oraz aktualny plik.
- „Pauza” wyświetla „Zatrzymywanie po bieżącym zestawie…”.
- „Anuluj” otwiera wybór „Zachowaj ukończone” / „Wycofaj tę sesję”.
- `sourceUnavailable` pokazuje nazwę oczekiwanej karty i przycisk „Wznów” po jej
  ponownym podłączeniu.
- Po restarcie sesja ma czytelny status „Przerwano przez zamknięcie aplikacji”.

## Powiadomienia systemowe

Wysyłać powiadomienia dla:

- wykrycia znanej karty w trybie `ask`,
- wymaganej akceptacji nowych profili,
- gotowego planu,
- rozpoczęcia importu działającego w tle,
- pauzy lub odłączenia źródła,
- błędu, w tym braku miejsca i błędu weryfikacji,
- zakończenia i wyniku rollbacku.

Kliknięcie powiadomienia otwiera właściwą kartę/panel w aplikacji. Powiadomienia
nie zatwierdzają planu ani nie wykonują destrukcyjnych akcji. Wyłączenie
powiadomień nie usuwa informacji z trwałego panelu i historii zdarzeń.

## API Tauri i zdarzenia

Docelowe komendy:

- `list_source_workflows`
- `start_source_workflow`
- `ignore_source_until_disconnect`
- `confirm_source_profiles`
- `update_source_behavior`
- `get_pending_import_plan`
- `assign_items_to_camera_profile`
- `approve_import_plan`
- `resume_import_session`
- `cancel_import_session { mode }`
- `retry_import_rollback`

Zdarzenia:

- `source-workflow-changed`
- `source-profile-confirmation-required`
- `plan-ready`
- `import-progress`
- `import-source-unavailable`
- `rollback-progress`

Komendy i zdarzenia powinny używać tych samych serializowanych modeli, aby
odświeżenie okna dawało ten sam stan co aktualizacje na żywo.

## Kolejność realizacji

### Etap 1 — model i migracje

- Schemat ustawień v2 i migracja v1 → v2.
- Zachowanie per karta i lista profili per powiązanie.
- Nowe ustawienia lokalne.
- Migracje SQLite dla trwałych planów, powiązania rekordów z sesją i rezerwacji.

Kryterium odbioru: istniejący `settings.json` i manifest otwierają się bez utraty
ustawień ani historii importów.

### Etap 2 — identyfikacja nośników

- `SourceIdentity` i logika dopasowania.
- Opcjonalny marker UUID.
- Adaptery systemowe i fallback.
- Rozpoznawanie prawdopodobnie znanej karty po zmianie identyfikatora.

Kryterium odbioru: ta sama karta jest rozpoznawana po zmianie litery/punktu
montowania, a dwie podobne karty nie są bez potwierdzenia traktowane jako jedna.

### Etap 3 — EXIF i profile

- Pełny `MediaMetadataReader`.
- Tożsamość aparatu przy `MediaItem`.
- Dopasowanie wielu profili i obsługa sprzeczności.
- Kreator zatwierdzania profili.

Kryterium odbioru: skan mieszanej karty tworzy poprawne sekcje aparatów i
„Nieznany aparat”, bez automatycznego zapisania profilu.

### Etap 4 — automat skan → plan

- Nowa maszyna stanów monitora.
- Trwały panel kart wymagających decyzji.
- Automatyczne przygotowanie i utrwalenie planu.
- Kontekst nazewnictwa per pozycja.

Kryterium odbioru: tryb automatyczny kończy się na gotowym, niezatwierdzonym
planie także przy ukrytym oknie aplikacji.

### Etap 5 — odporna sesja importu

- Sterowanie na granicach `item_key`.
- Klasyfikacja odłączenia źródła.
- Ponowne powiązanie rootu po podłączeniu.
- Weryfikacja stanu i wznowienie po odłączeniu/restarcie.

Kryterium odbioru: odłączenie podczas dużego zestawu nie publikuje uszkodzonego
pliku, a wznowienie kończy import z poprawnymi hashami.

### Etap 6 — rollback i równoległość

- Dwa tryby anulowania.
- Bezpieczny, wznawialny rollback.
- Kolejka importów, limit i rezerwacje ścieżek.

Kryterium odbioru: dwie karty mogą importować równolegle bez kolizji, a rollback
nie usuwa pliku zmienionego poza aplikacją.

### Etap 7 — integracja systemowa i finalne UX

- Powiadomienia z nawigacją do właściwego panelu.
- Ustawienia autostartu, automatycznego wznowienia i pokazywania okna.
- Dopracowanie zasobnika i historii zdarzeń.
- Testy instalowanych buildów na wszystkich systemach.

Kryterium odbioru: cały scenariusz działa z ukrytym oknem i po restarcie
aplikacji na Windows, macOS i Linux.

## Strategia testów

### Rust — testy jednostkowe

- migracja ustawień v1 → v2,
- walidacja zachowania i profili per karta,
- priorytety `SourceIdentity`,
- normalizacja oraz dopasowanie EXIF,
- mieszane aparaty i sprzeczny RAW/JPEG,
- przejścia maszyny stanów monitora,
- pauza/anulowanie wyłącznie między `item_key`,
- bezpieczne warunki rollbacku,
- limit kolejki i rezerwacje ścieżek.

### Rust — testy integracyjne

- skan → zatwierdzenie profili → plan → import,
- odłączenie przez zniknięcie katalogu źródłowego → ponowne podłączenie pod inną
  ścieżką → wznowienie,
- restart pomiędzy kopiowaniem i weryfikacją,
- dwa równoległe importy do jednej biblioteki,
- kolizja planów przygotowanych równolegle,
- rollback pełny, częściowy i przerwany,
- ochrona pliku zmienionego po imporcie.

### React/Vitest

- panel oczekującej karty nie znika po zamknięciu powiadomienia,
- „Tym razem ignoruj” działa do odłączenia,
- obowiązkowe zatwierdzenie profili,
- sekcje wielu aparatów i ręczne przypisanie nieznanych pozycji,
- unieważnienie planu po edycji,
- komunikaty pauzy, odłączenia, wznowienia i rollbacku,
- odtworzenie stanu po ponownym zamontowaniu komponentu.

### Testy platformowe

Na każdym systemie sprawdzić build instalowany, nie tylko tryb developerski:

- wykrycie i usunięcie karty,
- stabilność identyfikatora po zmianie punktu montowania,
- kartę tylko do odczytu,
- powiadomienia i kliknięcie prowadzące do aplikacji,
- autostart w tle,
- usypianie i wybudzanie systemu,
- brak uprawnień oraz brak miejsca w bibliotece.

## Warunki ukończenia funkcji

Funkcja jest gotowa, gdy:

1. żadna ścieżka automatyczna nie rozpoczyna importu bez zatwierdzenia planu,
2. profile wykryte z EXIF nigdy nie są zapisywane bez potwierdzenia,
3. zachowanie jest niezależne per karta,
4. pauza i anulowanie nie rozdzielają zestawu RAW+JPEG+XMP,
5. odłączenie i restart nie prowadzą do uszkodzonego ani uznanego za ukończony
   pliku,
6. wznowienie sprawdza tożsamość karty i integralność oczekujących danych,
7. rollback usuwa wyłącznie niezmienione wyniki wskazanej sesji,
8. limit równoległości i rezerwacje chronią wspólną bibliotekę,
9. stan wymagający uwagi jest dostępny w aplikacji niezależnie od powiadomień,
10. scenariusze odbiorcze przechodzą na Windows, macOS i Linux.

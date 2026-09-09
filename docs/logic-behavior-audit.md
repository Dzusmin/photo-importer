# Audyt logicznych zachowań aplikacji

Data przeglądu: 2026-09-09  
Zakres: ekran główny, źródła i skanowanie, plany, import, historia, kopie zapasowe, ustawienia, monitor działający w tle i nawigacja.  
Charakter dokumentu: backlog problemów. Ten przegląd nie wprowadza zmian w zachowaniu aplikacji.

## Jak czytać backlog

- `P0` — ryzyko utraty spójności danych albo wykonania operacji na niewłaściwym stanie.
- `P1` — zachowanie wyraźnie mylące, blokujące lub sprzeczne z przyjętym modelem aplikacji.
- `P2` — istotna niespójność UX albo brak obsługi błędu.
- `P3` — mniejszy problem, niedopowiedzenie lub dług techniczno-produktowy.
- `Potwierdzone` oznacza, że zachowanie wynika bezpośrednio z obecnego kodu.
- `Do decyzji` oznacza, że kod jest spójny sam ze sobą, ale brakuje jednoznacznej reguły produktu.

## Reguły produktu przyjęte jako punkt odniesienia

1. Ekran główny pokazuje bieżący stan fizycznie podłączonych kart oraz aktywne operacje.
2. Odłączony plan pozostaje zapisany w panelu **Plany**, ale nie zajmuje ekranu głównego.
3. Karta jest rozpoznawana po trwałej tożsamości, a nie po literze dysku.
4. Automatyczny import nie rozpoczyna się przy konflikcie ani bez pewnej tożsamości źródła.
5. Operacja zakończona komunikatem sukcesu musi być również trwale zapisana.
6. Jeżeli backend dopuszcza kilka równoległych zadań, interfejs musi każde z nich pokazać i pozwolić nim zarządzać.
7. Błąd działania automatycznego nie może pozostać niewidoczny.

## Uporządkowany backlog

### LOG-001 — wynik skanu pozostaje na stronie głównej po odłączeniu karty

- Priorytet: `P1`
- Stan: `Potwierdzone`; pierwszy problem do naprawy
- Obecnie: backend oznacza zapisany workflow jako `disconnected`, ale frontend po zdarzeniu odświeża wyłącznie listę workflow. Lokalny `scanResult` pozostaje aktywny i sekcja **Review scan results** jest renderowana niezależnie od obecności źródła.
- Skutek: użytkownik widzi plan, którego nie może wiarygodnie przygotować ani uruchomić, i może odnieść wrażenie, że karta nadal jest dostępna.
- Oczekiwane: po odłączeniu właściwej karty ekran główny zamyka jej szczegóły i wraca do czystego stanu. Workflow zostaje w **Plany** i można go ponownie otworzyć po podłączeniu tej samej karty.
- Ślady w kodzie: `src/features/sources/SourceScanner.tsx` — listener `source-workflows-invalidated`, `refreshSources` i warunek renderowania `scanResult`; `src-tauri/src/sources.rs` — przejście workflow do `disconnected`.

### LOG-002 — edycja planu może zapisać poprzednią, a nie najnowszą wartość

- Priorytet: `P0`
- Stan: `Potwierdzone`
- Obecnie: handlery najpierw wywołują `setEventNames`, `setExcludedImportKeys` lub `setItemProfileAssignments`, a następnie `invalidatePlan()`. Funkcja zapisuje wartości z poprzedniego renderu Reacta. Kolejne zapisy są uruchamiane bez kolejki i mogą zakończyć się w innej kolejności.
- Skutek: po restarcie może wrócić starsza nazwa wydarzenia, wybór zdjęć albo przypisanie aparatu.
- Oczekiwane: każdy zapis otrzymuje jawny, najnowszy snapshot edytora, a zapisy dla jednego planu są serializowane albo wersjonowane.
- Ślad: `src/features/sources/SourceScanner.tsx` — `invalidatePlan` i handlery edytora wyników skanu.

### LOG-003 — można przygotować nowy plan dla odłączonego źródła

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: `prepareImportPlan()` nie wymaga, by źródło wyniku skanu nadal znajdowało się na liście wykrytych woluminów. Gdy go nie ma, zapisuje workflow jako `unverified:<ścieżka>`.
- Skutek: zapisany plan karty może zostać zdublowany planem opartym na starej literze dysku; litera nie identyfikuje karty.
- Oczekiwane: plan karty wolno przeliczać tylko po potwierdzeniu jej tożsamości. Ręcznie wybrany katalog lub udział sieciowy musi mieć osobny, jawny model źródła.
- Ślad: `src/features/sources/SourceScanner.tsx` — `prepareImportPlan`.

### LOG-004 — import może zostać utworzony bez tożsamości i bez dostępnego źródła

- Priorytet: `P0`
- Stan: `Potwierdzone`
- Obecnie: `beginImport()` dopuszcza brak aktualnie wykrytego źródła i tworzy sesję z pustą tożsamością. `start_import_session` sprawdza obecność karty tylko wtedy, gdy przekazano tożsamość albo katalog źródłowy.
- Skutek: sesja startuje ze starymi ścieżkami plików, kończy się błędem i nie ma danych potrzebnych do bezpiecznego wznowienia po ponownym podłączeniu karty.
- Oczekiwane: import z karty wymaga podłączonej, zgodnej karty. Import z ręcznego katalogu przekazuje i waliduje jawny katalog źródłowy.
- Ślady: `src/features/sources/SourceScanner.tsx` — `beginImport`; `src-tauri/src/imports.rs` — `start_import_session` i `session_source_matches`.

### LOG-005 — plan jest kasowany przed potwierdzeniem, że import rzeczywiście wystartował

- Priorytet: `P0`
- Stan: `Potwierdzone`
- Obecnie: po utworzeniu sesji frontend usuwa pending workflow, a dopiero potem wywołuje `startImportSession`. Błąd usunięcia planu jest ignorowany.
- Skutek: gdy uruchomienie sesji się nie powiedzie, plan może zniknąć mimo że kopiowanie nie ruszyło.
- Oczekiwane: plan przechodzi atomowo do stanu importu albo jest usuwany dopiero po przyjęciu sesji do wykonania. Błędu kasowania nie należy połykać.
- Ślad: `src/features/sources/SourceScanner.tsx` — `beginImport`.

### LOG-006 — UI pokazuje tylko jedną sesję importu, choć backend obsługuje wiele

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: ustawienie pozwala na maksymalnie 8 równoległych importów, backend ma kolejkę i zbiór aktywnych sesji, ale frontend przechowuje pojedyncze `importSession`. Każde zdarzenie postępu ją nadpisuje.
- Skutek: postęp i przyciski pauzy/anulowania mogą przeskakiwać między sesjami; część aktywnych importów jest niewidoczna.
- Oczekiwane: UI utrzymuje kolekcję sesji po ID i pokazuje każdą aktywną lub oczekującą operację.
- Ślady: `src-tauri/src/imports.rs` — `ImportRuntime`; `src/features/sources/SourceScanner.tsx` — `importSession` i listener `import-progress`.

### LOG-007 — UI pokazuje tylko jeden skan, choć równoległe skany różnych źródeł są możliwe

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: backend deduplikuje wyłącznie skan tej samej ścieżki, a frontend ma pojedyncze `scanJob` i `scanResult`. Zdarzenie dowolnego skanu nadpisuje bieżący ekran.
- Skutek: automatyczny skan drugiej karty może przejąć ekran ręcznie rozpoczętego skanu pierwszej karty.
- Oczekiwane: stan skanów jest indeksowany po ID/źródle; ekran główny wyświetla listę aktywnych operacji albo jednoznacznie wybiera tę dotyczącą otwartej karty.
- Ślady: `src-tauri/src/scan_jobs.rs` — `HashMap` zadań; `src/features/sources/SourceScanner.tsx` — `scanJob` i listener `scan-progress`.

### LOG-008 — stale zamontowany ekran główny może użyć starych ustawień i nadpisać nowe

- Priorytet: `P0`
- Stan: `Potwierdzone`
- Obecnie: `SourceScanner` pozostaje zamontowany przy zmianie zakładki i ładuje ustawienia tylko przy montowaniu. Panel **Plany** i **Ustawienia** zapisują ustawienia niezależnie. Późniejsze zatwierdzenie profili w skanerze zapisuje cały, potencjalnie stary obiekt ustawień.
- Skutek: zmiana wykonana w innym panelu może zostać cofnięta bez ostrzeżenia.
- Oczekiwane: jeden współdzielony store ustawień albo zapis zmian cząstkowych z kontrolą rewizji. Wszystkie widoki reagują na zmianę ustawień.
- Ślady: `src/App.tsx` — `persistent-home`; `src/features/sources/SourceScanner.tsx` — ładowanie i `confirmDetectedProfiles`; `src/features/plans/PlansPanel.tsx` — `updateBehavior`.

### LOG-009 — sukces identyfikacji karty jest pokazywany mimo nieudanego zapisu UUID

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: błąd `ensureMediaSourceMarker` jest zamieniany na `null`, po czym UI informuje, że profile i karta zostały zatwierdzone.
- Skutek: użytkownik sądzi, że karta jest trwale rozpoznawana, choć automatyczny import może nie być dla niej bezpiecznie dostępny.
- Oczekiwane: częściowy sukces jest nazwany wprost; zapis UUID można ponowić, a automatyzacja wymagająca UUID pozostaje wyłączona.
- Ślad: `src/features/sources/SourceScanner.tsx` — `confirmDetectedProfiles`.

### LOG-010 — ważność planu uwzględnia tylko ustawienia nazewnictwa

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: `settingsRevision` jest wyliczana tylko z `settings.portable.naming`.
- Skutek: zmiana katalogu biblioteki, trybu kopiuj/przenieś, aliasu aparatu, korekty czasu lub innych danych wpływających na wynik może pozostawić stary plan oznaczony jako aktualny.
- Oczekiwane: fingerprint obejmuje wszystkie dane wejściowe planera albo backend jawnie wersjonuje zależności planu.
- Ślad: `src/features/sources/SourceScanner.tsx` — zapis i sprawdzanie `settingsRevision`.

### LOG-011 — ukończony import na stałe zajmuje ekran główny

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: terminalna `importSession` pozostaje w stanie komponentu, a ekran nie oferuje akcji zamknięcia/powrotu do czystego widoku.
- Skutek: strona startowa nie wraca do założonego bieżącego podsumowania kart.
- Oczekiwane: po sukcesie krótki komunikat i możliwość przejścia do historii; zakończona sesja nie blokuje podstawowego widoku.
- Ślad: `src/features/sources/SourceScanner.tsx` — render `importSession`.

### LOG-012 — panel Planów może być pusty mimo istniejących rekordów

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: grupowanie nie obejmuje stanu `ignoredUntilDisconnect`. Jednocześnie pusty ekran pokazuje się tylko, gdy `plans.length === 0`.
- Skutek: użytkownik widzi pustą przestrzeń bez planów i bez wyjaśnienia.
- Oczekiwane: każdy stan workflow należy do widocznej grupy albo nie jest zwracany jako plan.
- Ślad: `src/features/plans/PlansPanel.tsx` — `groups` i warunek pustego ekranu.

### LOG-013 — błędy usuwania planów nie są obsługiwane

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: `remove` i `removeDisconnected` mają `try/finally`, ale nie mają `catch`.
- Skutek: odrzucona komenda może dać nieobsłużony Promise i brak komunikatu, dlaczego plan nadal istnieje.
- Oczekiwane: zachować plan na liście i pokazać czytelny błąd z możliwością ponowienia.
- Ślad: `src/features/plans/PlansPanel.tsx`.

### LOG-014 — utworzenie automatyzacji z panelu Planów może zgubić powiązanie z aparatem

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: jeżeli binding nie istnieje, panel tworzy go z pustym `cameraProfileIds`.
- Skutek: karta ma zachowanie automatyczne, ale traci informację, które profile aparatów były z nią związane; plan może używać ogólnych aliasów lub wymagać ponownego przypisania.
- Oczekiwane: utworzenie bindingu zachowuje/pozyskuje profile ze skanu albo wymaga ich jawnego wyboru.
- Ślad: `src/features/plans/PlansPanel.tsx` — `updateBehavior`.

### LOG-015 — potwierdzenie autoimportu w Ustawieniach nie sprawdza faktycznej zmiany

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: warunek szuka tekstu `"autoImport"` w serializowanym całym obiekcie. Jeżeli autoimport był już włączony gdziekolwiek, włączenie go dla kolejnej karty lub aparatu może nie wymagać potwierdzenia.
- Skutek: ryzykowna automatyzacja może zostać rozszerzona bez oczekiwanego ostrzeżenia.
- Oczekiwane: porównać stare i nowe zachowanie każdego zakresu: globalnego, karty oraz aparatu.
- Ślad: `src/features/settings/SettingsPanel.tsx` — `persist`.

### LOG-016 — niezapisana zmiana języka działa od razu i nie cofa się przy wyjściu

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: selektor wywołuje `setAppLanguage` przed zapisaniem ustawień. Opuszczenie panelu usuwa formularz, ale język interfejsu pozostaje zmieniony do ponownego wczytania.
- Skutek: znacznik „niezapisane” nie odpowiada temu, co realnie działa w aplikacji.
- Oczekiwane: albo język jest ustawieniem natychmiastowym i od razu zapisywanym, albo podlega zwykłym akcjom Zapisz/Anuluj.
- Ślad: `src/features/settings/SettingsPanel.tsx` — obsługa `uiLanguage`.

### LOG-017 — wyjście z Ustawień bez zapisu po cichu porzuca zmiany

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: nawigacja nie sprawdza `dirty`, a panel jest odmontowywany.
- Skutek: użytkownik może stracić rozbudowaną konfigurację bez ostrzeżenia.
- Oczekiwane: potwierdzenie opuszczenia albo centralnie zarządzany draft zachowany między zakładkami.
- Ślady: `src/App.tsx` — nawigacja; `src/features/settings/SettingsPanel.tsx` — lokalny `dirty`.

### LOG-018 — import konfiguracji i przywrócenie kopii mogą zastąpić bieżące ustawienia bez potwierdzenia

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: obie operacje zapisują/odtwarzają konfigurację bez końcowego potwierdzenia zakresu zmian. Import jest możliwy również przy lokalnym, niezapisanym formularzu.
- Skutek: można utracić bieżące ustawienia lub niezapisany draft.
- Oczekiwane: pokazać zakres zastępowanych danych i wymagać potwierdzenia; przy `dirty` najpierw rozstrzygnąć los draftu.
- Ślad: `src/features/settings/SettingsPanel.tsx` — `importConfiguration`, `restoreBackup`.

### LOG-019 — zmiana katalogu biblioteki nie ostrzega o wpływie na plany i historię

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: ścieżka jest zmieniana jak zwykłe pole.
- Skutek: historia zaczyna skanować inne drzewo, stare plany mogą kierować do poprzedniej biblioteki, a użytkownik nie wie, czy dane mają być przeniesione.
- Oczekiwane: pokazać wpływ i wymusić przeliczenie planów; określić, czy zmiana oznacza nową bibliotekę czy migrację.
- Ślad: `src/features/settings/SettingsPanel.tsx` — `chooseLibrary` i zapis.

### LOG-020 — historia nie odświeża się po ukończeniu importu

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: panel ładuje listę tylko przy montowaniu i po ręcznym kliknięciu **Odśwież**. Nie słucha zakończenia importu.
- Skutek: zakończony import nie pojawia się, gdy użytkownik ma już otwartą Historię.
- Oczekiwane: odświeżyć listę po terminalnym zdarzeniu importu albo pokazać przycisk z informacją o nowych danych.
- Ślad: `src/features/history/ImportHistoryPanel.tsx`.

### LOG-021 — import może zakończyć się sukcesem bez metadanych śledzenia wydarzenia

- Priorytet: `P0`
- Stan: `Potwierdzone`
- Obecnie: zapis `.photo-importer-event.json` jest wykonywany jako `let _ = ...`; błąd jest ignorowany.
- Skutek: pliki są skopiowane, ale wydarzenie znika z Historii i nie może być wiarygodnie śledzone po zmianie nazwy folderu.
- Oczekiwane: zapis markera jest częścią finalizacji transakcji albo sesja kończy się ostrzeżeniem wymagającym naprawy metadanych.
- Ślad: `crates/importer-import/src/lib.rs` — wywołanie `write_event_marker`.

### LOG-022 — zmiana nazwy wydarzenia może pozostawić częściowo zmieniony stan

- Priorytet: `P0`
- Stan: `Potwierdzone`
- Obecnie: kod najpierw fizycznie zmienia nazwę folderu, potem zapisuje marker, a na końcu aktualizuje manifest. Brak rollbacku.
- Skutek: błąd drugiego lub trzeciego kroku zwraca porażkę, mimo że folder już ma nową nazwę; marker i historia mogą wskazywać różne ścieżki.
- Oczekiwane: transakcja kompensacyjna albo bezpieczna kolejność ze stanem „wymaga naprawy”.
- Ślad: `src-tauri/src/events.rs` — `rename_import_event`.

### LOG-023 — zewnętrzna zmiana nazwy może wyglądać na naprawioną mimo błędu zapisu

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: podczas skanowania historii aplikacja wykrywa nową nazwę, ale ignoruje błędy zapisu markera i aktualizacji manifestu, po czym zwraca zmieniony wynik do UI.
- Skutek: w bieżącym widoku wszystko wygląda poprawnie, a po restarcie lub kolejnym skanie niespójność wraca.
- Oczekiwane: raportować błąd synchronizacji i nie przedstawiać stanu jako trwale naprawionego.
- Ślad: `src-tauri/src/events.rs` — `collect_events`.

### LOG-024 — liczba plików w Historii nie oznacza liczby zaimportowanych mediów

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: licznik obejmuje wszystkie bezpośrednie wpisy katalogu poza markerem, w tym podkatalogi i obce pliki; nie liczy rekurencyjnie.
- Skutek: prezentowana liczba może różnić się od planu i od rzeczywistej liczby zdjęć/filmów.
- Oczekiwane: użyć manifestu albo jasno zdefiniowanego rekurencyjnego filtra wspieranych mediów.
- Ślad: `src-tauri/src/events.rs` — `summary`.

### LOG-025 — uszkodzone markery wydarzeń są po cichu pomijane

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: `collect_events` dodaje wydarzenie tylko, gdy `read_marker` się powiedzie; błąd nie trafia do wyniku ani do diagnostyki UI.
- Skutek: wydarzenie znika z historii bez informacji, jak je naprawić.
- Oczekiwane: osobna lista „wymaga uwagi” z katalogiem i przyczyną.
- Ślad: `src-tauri/src/events.rs` — `collect_events`.

### LOG-026 — historia jest sortowana po ścieżce folderu, nie po czasie importu

- Priorytet: `P3`
- Stan: `Potwierdzone`
- Obecnie: sortowanie malejące używa `folder_path`.
- Skutek: kolejność zależy od szablonu nazwy katalogu i nie musi odpowiadać kolejności importów ani wykonania zdjęć.
- Oczekiwane: jawny wybór sortowania; domyślnie ostatni import albo data wydarzenia.
- Ślad: `src-tauri/src/events.rs` — `list_import_events`.

### LOG-027 — ręczne „Sprawdź teraz” nie oznacza zakończenia sprawdzania

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: komenda tylko ustawia flagę odświeżenia i natychmiast zwraca dotychczasowy status; frontend czeka stałe 500 ms.
- Skutek: użytkownik może nadal widzieć poprzedni czas sprawdzenia i nie wie, czy skan faktycznie się zakończył.
- Oczekiwane: przycisk pokazuje stan żądania do momentu nowej rewizji/statusu lub komenda czeka na zakończenie jednego cyklu.
- Ślad: `src-tauri/src/background.rs` — `refresh_background_monitor`; `src/features/background/BackgroundMonitor.tsx`.

### LOG-028 — dwa nieoznaczone, podobne nośniki mogą zostać uznane za jedno źródło

- Priorytet: `P1`
- Stan: `Potwierdzone ograniczenie modelu`
- Obecnie: zanim karta otrzyma marker UUID, fallback fingerprint opiera się na cechach woluminu. Identyczne karty o tej samej etykiecie, systemie plików i pojemności mogą się zderzyć.
- Skutek: rekord oczekującego źródła może zostać scalony z inną kartą.
- Oczekiwane: traktować fallback wyłącznie jako słabą wskazówkę i nie przenosić na jego podstawie automatyzacji ani planu między sesjami bez potwierdzenia.
- Ślady: `crates/importer-media/src/discovery.rs`; `src-tauri/src/background.rs`.

### LOG-029 — błędy automatycznego działania bywają tylko zapisane, bez widocznego alarmu

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: część ścieżek monitora ignoruje błędy zapisu/emisji lub jedynie zmienia workflow na `failedRecoverable`. Użytkownik zobaczy problem dopiero po wejściu do Planów.
- Skutek: automatyczne kopiowanie może się nie rozpocząć, a główny ekran nadal wygląda spokojnie.
- Oczekiwane: trwały czerwony stan „wymaga uwagi” na głównej stronie i w nawigacji, z możliwością przejścia do konkretnego workflow.
- Ślad: `src-tauri/src/background.rs` — ścieżki automatycznego skanu/importu i ignorowane wyniki `emit`/zapisu.

### LOG-030 — przywrócony plan może blokować skonfigurowany autoimport

- Priorytet: `P2`
- Stan: `Do decyzji`
- Obecnie: po ponownym podłączeniu karty monitor przywraca zapisany workflow i kończy obsługę tego źródła, zamiast przejść do reguły `autoImport`.
- Skutek: karta ustawiona na automatyczne kopiowanie nie zawsze kopiuje automatycznie, jeżeli ma pozostałość poprzedniego planu.
- Oczekiwane do ustalenia: zapisany plan ma zawsze pierwszeństwo i wymaga decyzji albo po zgodnej karcie i bez konfliktów autoimport kontynuuje ten plan.
- Ślad: `src-tauri/src/background.rs` — obsługa znanego źródła i przywracanie workflow.

### LOG-031 — zadania backupu mogą przejmować UI innego wybranego celu

- Priorytet: `P1`
- Stan: `Potwierdzone`
- Obecnie: backend przechowuje wiele zadań po ID, ale panel ma pojedynczy `job`. Przy inicjalizacji wybiera pierwsze aktywne/najnowsze zadanie niezależnie od wybranego celu, a każde zdarzenie `backup-progress` je nadpisuje.
- Skutek: postęp i przyciski sterujące mogą dotyczyć innego dysku niż ten widoczny w selektorze.
- Oczekiwane: zadania indeksowane po celu/ID; szczegóły i sterowanie zawsze odpowiadają wybranemu targetowi.
- Ślady: `src-tauri/src/backups.rs` — mapa zadań; `src/features/backups/BackupPanel.tsx` — `job`, inicjalizacja i listener.

### LOG-032 — odświeżanie dysków backupu może uruchamiać nakładające się zapytania

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: timer co 5 s i zdarzenie focus wywołują `refreshVolumes` bez blokady in-flight. Błędy obu wywołań są ignorowane.
- Skutek: wolniejsze rozpoznawanie może zakończyć się w odwrotnej kolejności, a lista po błędzie pozostaje stara bez ostrzeżenia.
- Oczekiwane: współdzielony single-flight, numer rewizji i widoczny stan błędu/ostatniego udanego odświeżenia.
- Ślad: `src/features/backups/BackupPanel.tsx` — timer i `refreshOnFocus`.

### LOG-033 — panel backupu nie pozwala usunąć zarejestrowanego celu

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: backend i warstwa TS mają `remove_backup_target`, ale panel nie udostępnia tej operacji.
- Skutek: stary albo błędnie zarejestrowany dysk pozostaje na liście bez sposobu zarządzania nim.
- Oczekiwane: akcja „Usuń cel” z potwierdzeniem; usuwa rejestrację, nie pliki backupu.
- Ślady: `src-tauri/src/backups.rs`; `src/shared/backups.ts`; brak użycia w `src/features/backups/BackupPanel.tsx`.

### LOG-034 — rozpoczęcie backupu usuwa z ekranu poprzedni audyt i historię

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: efekt audytu czyści `snapshot` i `history`, kiedy `busy` jest prawdziwe.
- Skutek: podczas długiej kopii znika kontekst, na podstawie którego użytkownik ją zatwierdził.
- Oczekiwane: zachować ostatni snapshot jako oznaczony „sprzed uruchomienia”; bieżący postęp pokazać obok.
- Ślad: `src/features/backups/BackupPanel.tsx` — efekt zależny od `busy`.

### LOG-035 — panel obiecuje przyszłe przywracanie, którego UI jeszcze nie oferuje

- Priorytet: `P3`
- Stan: `Potwierdzone`
- Obecnie: opis mówi o starszych wersjach dostępnych do przyszłego restore, ale w aplikacji nie ma przepływu przywracania.
- Skutek: użytkownik może oczekiwać gotowej funkcji odzyskiwania.
- Oczekiwane: oznaczyć funkcję jako planowaną albo dostarczyć kontrolowany przepływ restore.
- Ślad: `src/features/backups/BackupPanel.tsx` — opis poprzednich wersji.

### LOG-036 — status „Import engine: Ready” jest deklarowany na stałe

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: widok diagnostyczny prezentuje gotowość silnika importu jako stały tekst, niezależnie od kolejki, błędów manifestu czy niedostępnej biblioteki.
- Skutek: diagnostyka może przeczyć faktycznemu stanowi aplikacji.
- Oczekiwane: status wyliczany z realnego health checku i ostatniego błędu podsystemu.
- Ślad: `src/App.tsx` — `ActivityView`.

### LOG-037 — startowa synchronizacja historii połyka wszystkie błędy

- Priorytet: `P2`
- Stan: `Potwierdzone`
- Obecnie: aplikacja wywołuje `listImportEvents().catch(() => undefined)` przy starcie, aby wykryć zewnętrzne zmiany nazw.
- Skutek: błąd dostępu do biblioteki albo niespójność historii jest niewidoczna i nie wpływa na status systemu.
- Oczekiwane: zapis diagnostyczny i widoczny stan wymagający uwagi, bez blokowania startu aplikacji.
- Ślad: `src/App.tsx` — startowy efekt `listImportEvents`.

### LOG-038 — poszczególne zakładki inaczej zachowują stan po powrocie

- Priorytet: `P3`
- Stan: `Potwierdzone / do ujednolicenia`
- Obecnie: ekran główny pozostaje zamontowany, a Plany, Backup, Historia i Ustawienia są odmontowywane i ponownie pobierają dane lub tracą draft.
- Skutek: użytkownik nie może przewidzieć, czy po powrocie zobaczy poprzedni kontekst, ekran ładowania czy pusty formularz.
- Oczekiwane: jawna polityka per widok: trwały stan dla aktywnych operacji, ostrzeżenie dla draftów, cache z rewizją dla danych tylko do odczytu.
- Ślad: `src/App.tsx` — warunkowe renderowanie widoków.

### LOG-039 — brak jednego miejsca pokazującego wszystkie aktywne operacje

- Priorytet: `P2`
- Stan: `Do decyzji`, problem architektoniczny potwierdzony przez modele wielozadaniowe
- Obecnie: skany, importy i backupy mają osobne, pojedyncze stany UI, mimo że backend dopuszcza wiele operacji.
- Skutek: trudne jest ustalenie, co faktycznie działa w tle i która operacja wymaga uwagi.
- Oczekiwane: wspólny model zadań lub przynajmniej licznik/centrum aktywności w nawigacji, z przejściem do konkretnego zadania.
- Ślady: `SourceScanner`, `BackupPanel`, backendowe serwisy zadań.

### LOG-040 — dokumentacja opisuje starsze zachowanie niż aplikacja

- Priorytet: `P3`
- Stan: `Potwierdzone`
- Obecnie: dokument planu automatycznego importu nadal zakłada każdorazową akceptację, mimo że istnieje `autoImport`; README wspomina użycie PowerShell do wykrywania źródeł, chociaż ta ścieżka została usunięta.
- Skutek: kolejne decyzje i testy mogą być oparte na nieaktualnym kontrakcie.
- Oczekiwane: po ustabilizowaniu reguł zaktualizować dokumentację i oznaczyć obowiązujące źródło prawdy.
- Ślady: `docs/automatic-card-import-plan.md`, `README.md`, obecny kod monitora i discovery.

## Kolejność proponowanych napraw

1. `LOG-001` — zamykanie szczegółów odłączonej karty przy zachowaniu planu w panelu Planów.
2. `LOG-002`, `LOG-003`, `LOG-004`, `LOG-005`, `LOG-008`, `LOG-021`, `LOG-022` — spójność i bezpieczeństwo danych.
3. `LOG-006`, `LOG-007`, `LOG-031`, `LOG-039` — jeden jawny model wielu operacji.
4. `LOG-009`, `LOG-010`, `LOG-012`–`LOG-019`, `LOG-027`–`LOG-030`, `LOG-032`–`LOG-038` — przewidywalne zachowanie i obsługa błędów.
5. `LOG-020`, `LOG-023`–`LOG-026`, `LOG-040` — historia, diagnostyka i dokumentacja.

## Warunek rozpoczęcia wdrażania

Przed każdą zmianą wybieramy konkretny identyfikator `LOG-xxx`, doprecyzowujemy zachowanie i kryteria akceptacji, a dopiero potem modyfikujemy kod. Dla pozycji oznaczonych `Do decyzji` najpierw potrzebna jest decyzja produktowa.

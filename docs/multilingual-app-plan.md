# Application internationalization plan

## Goal

Photo Importer should be prepared to support multiple languages. The first
multilingual release will provide the complete interface in English (`en`) and
Polish (`pl`). English will be the base language and safe fallback, and users
will be able to change the language in settings without restarting the
application.

The scope includes the React interface, validation and error messages, Tauri
system dialogs, the tray menu, notifications, and tests. Product names, paths,
file extensions, EXIF data, and technical identifiers are not translated.

## Agreed behavior

- Initially supported languages are `en` and `pl`.
- The application uses English on first launch.
- Settings include a `Language / Język` field with `English` and `Polski`
  values. Language names are displayed in their own language.
- A language change takes effect immediately throughout the interface and is
  stored as a local setting on the computer.
- A missing key or unsupported language code always falls back to English.
- Dates, numbers, and file sizes use the active locale, while technical values
  and filename templates remain stable.
- User-entered data, such as camera-profile and event names, is not translated
  automatically.
- Error and status codes in React–Rust communication remain
  language-independent. The presentation layer is translated, not the IPC
  contract.

## Architecture

### React layer

Use `i18next` and `react-i18next`. The library provides fallback,
interpolation, pluralization, and the ability to add more locales without
changing component APIs.

Proposed structure:

```text
src/i18n/
  index.ts
  locale.ts
  resources/
    en.json
    pl.json
```

`index.ts` initializes i18next before the application is rendered. `locale.ts`
contains the `SupportedLocale = "en" | "pl"` type, the language list,
validation of values read from settings, and formatting helpers based on
`Intl`.

Translation keys should describe meaning rather than wording:

```json
{
  "navigation": {
    "mainLabel": "Main navigation",
    "activity": "Activity",
    "settings": "Settings"
  },
  "common": {
    "retry": "Try again",
    "save": "Save"
  },
  "errors": {
    "backendUnavailable": {
      "title": "Backend unavailable",
      "impact": "Media monitoring and scanning are unavailable."
    }
  }
}
```

Do not assemble sentences from several translated fragments. Pass dynamic
values as interpolation parameters and handle inflection of counts through the
library's pluralization mechanism.

### Settings and persistence of the selection

Add the following to `LocalSettings`:

```text
uiLanguage: en | pl
```

The field remains local and is not included in portable settings exports.
Increment the settings schema version and add a migration that sets `en` for
existing installations, as well as a default value for new installations. The
frontend loads the language as early as possible; until settings have been
read, it may use English without blocking application startup.

A `system` value may eventually be added, but it is not needed in the first
stage. Explicit `en` or `pl` values provide predictable behavior on all three
operating systems.

### Rust backend and native elements

Messages returned by commands should have a stable `code` and optional data
(`params`) instead of a ready-made Polish sentence as their only information.
The frontend maps the code to a translation key. A technical message field may
be retained for diagnostic details and should not be treated as UI text.

Text that must originate in Rust without React—the tray menu, tooltip, and
system notifications—will receive a small `en`/`pl` catalog on the Tauri side.
The backend will read `uiLanguage` from settings. The keys for these messages
should correspond to those used in the UI, and a test will verify that both
catalogs are complete.

Enum names and codes such as `planReady`, `permissionDenied`, and
`moveAfterVerification` must not be translated; they are part of the contract,
and only the view converts them into user-facing text.

## Implementation stages

### 1. Foundation and language setting

- Add the `i18next` and `react-i18next` dependencies.
- Create initialization and the `en.json` and `pl.json` catalogs.
- Add `uiLanguage` to the TypeScript and Rust models, default values,
  validation, migrations, and settings-repository tests.
- Add a language selector at the start of the “Application behavior” section.
- After saving or changing the field, call `i18n.changeLanguage(...)` so the
  switch takes effect immediately.
- Set the `lang` attribute of the `html` element to the active language code.

Result: the infrastructure works, the selection persists, and a sample UI
section can be switched between languages.

### 2. Migrate the entire React interface

Move text to translation functions while retaining small, topic-specific key
namespaces:

1. `App.tsx`, navigation, view headings, and diagnostics.
2. `ErrorNotice.tsx`, `appStatus.ts`, and every error description.
3. `SettingsPanel.tsx` and validation messages in `shared/settings.ts`.
4. `SourceScanner.tsx`, including scanning stages, the import plan, event
   editing, time adjustment, and import progress.
5. `BackupPanel.tsx`, file statuses, planning, history, and drive registration.
6. `BackgroundMonitor.tsx`, activity, statuses, and recovery actions.
7. Titles of system file and directory selection dialogs.

Replace constants that map statuses to Polish labels with functions that
accept a translator, for example `getStatusLabel(status, t)`. Do not store a
translation result in React state, so that the text updates after changing the
language.

Result: component files contain no user-facing text other than the product
name and justified technical data.

### 3. Errors, tray, and Tauri notifications

- Inventory Polish messages in `settings.rs`, `sources.rs`, `scan_jobs.rs`,
  `imports.rs`, `backups.rs`, `thumbnails.rs`, and `background.rs`.
- Separate diagnostic data from the message intended for display.
- Add translations for the “show,” “refresh,” and “quit” menu items, the
  tooltip, and all source, import-plan, error, and operation-completion
  notifications.
- Rebuild the tray menu after a language change or apply the new language on
  the next launch; immediate refresh is preferred.
- For unknown errors, show a localized generic description and retain the raw
  technical details so they can be copied.

Result: an application running in the background displays no Polish text when
English is active, or vice versa.

### 4. Locale-aware formatting

- Replace manual date and number formatting with `Intl.DateTimeFormat`,
  `Intl.NumberFormat`, and `Intl.RelativeTimeFormat`.
- Pass the active locale when formatting file sizes and durations.
- Retain machine formats wherever they affect paths or exports.
- Add test cases for Polish plural rules, such as 1 file, 2 files, and 5 files,
  and their English equivalents.

### 5. Tests and completeness checks

- Configure a deterministic language in component tests, using `en` by
  default.
- Update test selectors so they do not depend unnecessarily on a single
  translation; prefer roles, accessibility labels, and `data-testid` only when
  a role is insufficient.
- Add an `en` and `pl` rendering test for every major view.
- Add a test requiring an identical set of keys in both locale files.
- Add a fallback test for a missing key and unsupported locale.
- Add a settings migration test and verify that the selection persists after a
  restart.
- Add backend tests for both versions of the menu and notifications.
- Run `npm run check`, Cargo tests, and a manual smoke test of the Tauri build on
  Windows. Also verify macOS and Linux before release.

## Proposed change breakdown

1. **PR 1 — infrastructure and settings:** dependencies, catalogs, provider,
   `uiLanguage`, schema migration, and selector.
2. **PR 2 — main interface and settings:** `App`, shared errors,
   `SettingsPanel`, and their tests.
3. **PR 3 — import and sources:** `SourceScanner`, plan messages, and tests.
4. **PR 4 — backup and monitor:** `BackupPanel`, `BackgroundMonitor`, and tests.
5. **PR 5 — native elements:** IPC errors, tray, notifications, and Rust tests.
6. **PR 6 — formatting and audit:** `Intl`, completeness checks, tests for both
   languages, and translator documentation.

Every change should leave the application operational and its tests passing.
The work may be condensed into fewer PRs, but the order is worth preserving
because it limits the intermixing of contract, content, and test changes.

## Acceptance criteria for the first release

- Users can select English or Polish and see the change without restarting.
- The selected language remains active after restarting.
- All visible screens, empty states, errors, validation messages, dialogs, tray
  menus, and notifications are available in both languages.
- English is the default language and fallback.
- No missing translation causes an empty label or application failure.
- Dates, numbers, sizes, and plurals are correct for `en` and `pl`.
- Exported portable settings do not contain the language preference.
- Frontend and backend tests pass for both locales.

## Rules for adding more languages

Adding a language should require only adding it to `SupportedLocale`, creating
a complete catalog and native Tauri messages, and passing the completeness
test. English remains the source of meaning for keys. Each new text first
receives an English key and base version, followed by the other translations in
the same PR.

Before including a new locale, review it in the running application because
label length may reveal layout issues that a catalog completeness test alone
cannot detect.

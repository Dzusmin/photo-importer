import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { clearThumbnailCache } from "../../shared/sources";
import {
  exportPortableSettings,
  importPortableSettings,
  loadSettings,
  normalizeSettingsError,
  renderFolderPreview,
  restoreSettingsBackup,
  saveSettings,
  validateSettings,
  type AppSettings,
  type CameraProfile,
  type SettingsCommandError,
} from "../../shared/settings";

type Notice = { kind: "success" | "error" | "info"; text: string };

export function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [backupAvailable, setBackupAvailable] = useState(false);
  const [loadError, setLoadError] = useState<SettingsCommandError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const validationErrors = useMemo(
    () => (settings ? validateSettings(settings) : []),
    [settings],
  );
  const dirty = settings !== null && JSON.stringify(settings) !== savedSnapshot;

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    setBusy(true);
    setLoadError(null);
    try {
      const response = await loadSettings();
      acceptResponse(response.settings, response.backupAvailable);
      setNotice({
        kind: "info",
        text:
          response.source === "defaults"
            ? "Wczytano bezpieczne ustawienia domyślne. Zapis utworzy plik użytkownika."
            : "Wczytano ustawienia użytkownika.",
      });
    } catch (error) {
      const normalized = normalizeSettingsError(error);
      setLoadError(normalized);
      setBackupAvailable(normalized.backupAvailable === true);
      setNotice({ kind: "error", text: normalized.message });
    } finally {
      setBusy(false);
    }
  }

  function acceptResponse(value: AppSettings, hasBackup: boolean) {
    setSettings(value);
    setSavedSnapshot(JSON.stringify(value));
    setBackupAvailable(hasBackup);
    setLoadError(null);
  }

  async function persist() {
    if (!settings || validationErrors.length > 0) return;
    setBusy(true);
    try {
      const response = await saveSettings(settings);
      acceptResponse(response.settings, response.backupAvailable);
      setNotice({
        kind: "success",
        text: "Ustawienia zostały bezpiecznie zapisane.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: normalizeSettingsError(error).message });
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup() {
    setBusy(true);
    try {
      const response = await restoreSettingsBackup();
      acceptResponse(response.settings, response.backupAvailable);
      setNotice({
        kind: "success",
        text: "Przywrócono poprzednią wersję ustawień.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: normalizeSettingsError(error).message });
    } finally {
      setBusy(false);
    }
  }

  async function chooseLibrary() {
    if (!settings) return;
    const path = await open({
      directory: true,
      multiple: false,
      title: "Wybierz główny katalog biblioteki",
    });
    if (path) {
      setSettings({
        ...settings,
        local: { ...settings.local, libraryPath: path },
      });
    }
  }

  async function exportConfiguration() {
    const path = await save({
      title: "Eksportuj ustawienia Photo Importer",
      defaultPath: "photo-importer-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      await exportPortableSettings(path);
      setNotice({
        kind: "success",
        text: "Wyeksportowano przenośne ustawienia.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: normalizeSettingsError(error).message });
    } finally {
      setBusy(false);
    }
  }

  async function importConfiguration() {
    const path = await open({
      multiple: false,
      title: "Importuj ustawienia Photo Importer",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const response = await importPortableSettings(path);
      acceptResponse(response.settings, response.backupAvailable);
      setNotice({
        kind: "success",
        text: "Zaimportowano i zapisano przenośne ustawienia.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: normalizeSettingsError(error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clearPreviews() {
    setBusy(true);
    try {
      await clearThumbnailCache();
      setNotice({
        kind: "success",
        text: "Cache miniaturek został wyczyszczony. Podglądy zostaną wygenerowane ponownie.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: normalizeSettingsError(error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <section className="settings-empty" aria-live="polite">
        <p>{busy ? "Wczytywanie ustawień…" : "Nie można wczytać ustawień."}</p>
        {notice && <NoticeView notice={notice} />}
        <div className="button-row">
          <button type="button" onClick={() => void reload()} disabled={busy}>
            Spróbuj ponownie
          </button>
          {backupAvailable && (
            <button
              type="button"
              className="secondary"
              onClick={() => void restoreBackup()}
              disabled={busy}
            >
              Przywróć kopię
            </button>
          )}
        </div>
        {loadError?.code === "corruptedPrimary" && (
          <p className="help-text">
            Uszkodzony plik pozostawiono bez zmian, aby nie utracić danych.
          </p>
        )}
      </section>
    );
  }

  const updatePortableImport = (
    patch: Partial<AppSettings["portable"]["import"]>,
  ) =>
    setSettings({
      ...settings,
      portable: {
        ...settings.portable,
        import: { ...settings.portable.import, ...patch },
      },
    });
  const updateNaming = (patch: Partial<AppSettings["portable"]["naming"]>) =>
    setSettings({
      ...settings,
      portable: {
        ...settings.portable,
        naming: { ...settings.portable.naming, ...patch },
      },
    });

  return (
    <section className="settings-layout">
      <div className="settings-heading">
        <div>
          <p className="section-label">KONFIGURACJA</p>
          <h2>Ustawienia importu</h2>
          <p>
            Ustawienia lokalne zostają na tym komputerze. Profile i reguły można
            eksportować.
          </p>
        </div>
        <span className={dirty ? "dirty-badge" : "saved-badge"}>
          {dirty ? "Niezapisane zmiany" : "Zapisano"}
        </span>
      </div>

      {notice && <NoticeView notice={notice} />}
      {validationErrors.length > 0 && (
        <div className="notice notice--error" role="alert">
          {validationErrors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      )}

      <SettingsSection
        title="Biblioteka"
        description="Lokalne położenie zdjęć na tym komputerze."
      >
        <Field label="Główny katalog biblioteki" wide>
          <div className="path-control">
            <input
              readOnly
              value={settings.local.libraryPath ?? ""}
              placeholder="Nie wybrano katalogu"
            />
            <button
              type="button"
              className="secondary"
              onClick={() => void chooseLibrary()}
            >
              Wybierz
            </button>
            {settings.local.libraryPath && (
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  setSettings({
                    ...settings,
                    local: { ...settings.local, libraryPath: null },
                  })
                }
              >
                Wyczyść
              </button>
            )}
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Import"
        description="Domyślne zachowanie po wykryciu znanego nośnika."
      >
        <Field label="Operacja na plikach">
          <select
            value={settings.portable.import.defaultOperation}
            onChange={(event) =>
              updatePortableImport({
                defaultOperation: event.target
                  .value as AppSettings["portable"]["import"]["defaultOperation"],
              })
            }
          >
            <option value="copy">Kopiuj (zalecane)</option>
            <option value="moveAfterVerification">
              Przenieś po weryfikacji
            </option>
          </select>
        </Field>
        <Field label="Po podłączeniu znanej karty">
          <SourceBehaviorSelect
            value={settings.portable.import.defaultSourceBehavior}
            onChange={(defaultSourceBehavior) =>
              updatePortableImport({ defaultSourceBehavior })
            }
          />
        </Field>
        <Field label="Nowe wydarzenie po przerwie">
          <div className="number-with-unit">
            <input
              type="number"
              min={1}
              max={10080}
              value={settings.portable.import.eventGapMinutes}
              onChange={(event) =>
                updatePortableImport({
                  eventGapMinutes: Number(event.target.value),
                })
              }
            />
            <span>minut</span>
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Nazewnictwo"
        description="Foldery wydarzeń przechodzących przez północ nadal użyją daty początku wydarzenia."
      >
        <Field label="Szablon folderu" wide>
          <input
            value={settings.portable.naming.folderTemplate}
            onChange={(event) =>
              updateNaming({ folderTemplate: event.target.value })
            }
          />
          <p className="help-text">
            Dostępne: {"{year}"}, {"{month}"}, {"{day}"}, {"{date}"},{" "}
            {"{event_name}"}, {"{camera_alias}"}
          </p>
          <code className="template-preview">
            {renderFolderPreview(settings.portable.naming.folderTemplate)}
          </code>
        </Field>
        <Field label="Konflikt nazwy">
          <select
            value={settings.portable.naming.collisionPolicy}
            onChange={(event) =>
              updateNaming({
                collisionPolicy: event.target
                  .value as AppSettings["portable"]["naming"]["collisionPolicy"],
              })
            }
          >
            <option value="ask">Zatrzymaj i zapytaj</option>
            <option value="appendSequence">Dodaj kolejny numer</option>
          </select>
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Profile aparatów"
        description="EXIF pomoże rozpoznać aparat niezależnie od użytej karty."
      >
        <div className="profiles" data-wide>
          {settings.portable.cameraProfiles.length === 0 && (
            <p className="empty-copy">
              Brak profili. Możesz dodać pierwszy aparat ręcznie.
            </p>
          )}
          {settings.portable.cameraProfiles.map((profile, index) => (
            <CameraProfileEditor
              key={profile.id}
              profile={profile}
              onChange={(profile) => {
                const cameraProfiles = [...settings.portable.cameraProfiles];
                cameraProfiles[index] = profile;
                setSettings({
                  ...settings,
                  portable: { ...settings.portable, cameraProfiles },
                });
              }}
              onRemove={() => {
                const cameraProfiles = settings.portable.cameraProfiles.filter(
                  (item) => item.id !== profile.id,
                );
                const sourceBindings = settings.local.sourceBindings.map(
                  (binding) => ({
                    ...binding,
                    cameraProfileIds: binding.cameraProfileIds.filter(
                      (id) => id !== profile.id,
                    ),
                  }),
                );
                setSettings({
                  ...settings,
                  portable: { ...settings.portable, cameraProfiles },
                  local: { ...settings.local, sourceBindings },
                });
              }}
            />
          ))}
          <button
            type="button"
            className="secondary add-button"
            onClick={() => {
              const profile: CameraProfile = {
                id: crypto.randomUUID(),
                name: `Aparat ${settings.portable.cameraProfiles.length + 1}`,
                exifMatchers: [],
                defaultTimeOffsetSeconds: 0,
              };
              setSettings({
                ...settings,
                portable: {
                  ...settings.portable,
                  cameraProfiles: [
                    ...settings.portable.cameraProfiles,
                    profile,
                  ],
                },
              });
            }}
          >
            + Dodaj profil aparatu
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Powiązane nośniki"
        description="Powiązania powstaną podczas rozpoznawania kart; można je tutaj usunąć."
      >
        <div className="bindings" data-wide>
          {settings.local.sourceBindings.length === 0 ? (
            <p className="empty-copy">
              Nie zapamiętano jeszcze żadnego nośnika.
            </p>
          ) : (
            settings.local.sourceBindings.map((binding) => (
              <div className="binding-row" key={binding.id}>
                <code>
                  {binding.displayName ||
                    binding.sourceIdentity.fallbackFingerprint}
                </code>
                <span>
                  {binding.cameraProfileIds
                    .map(
                      (id) =>
                        settings.portable.cameraProfiles.find(
                          (profile) => profile.id === id,
                        )?.name,
                    )
                    .filter(Boolean)
                    .join(", ") || "Nieznany aparat"}
                </span>
                <SourceBehaviorSelect
                  value={binding.behavior}
                  onChange={(behavior) =>
                    setSettings({
                      ...settings,
                      local: {
                        ...settings.local,
                        sourceBindings: settings.local.sourceBindings.map(
                          (item) =>
                            item.id === binding.id
                              ? { ...item, behavior }
                              : item,
                        ),
                      },
                    })
                  }
                />
                <button
                  type="button"
                  className="danger-quiet"
                  onClick={() =>
                    setSettings({
                      ...settings,
                      local: {
                        ...settings.local,
                        sourceBindings: settings.local.sourceBindings.filter(
                          (item) => item.id !== binding.id,
                        ),
                      },
                    })
                  }
                >
                  Usuń
                </button>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Zachowanie aplikacji"
        description="Ustawienia specyficzne dla bieżącego użytkownika i komputera."
      >
        <Toggle
          label="Uruchamiaj przy logowaniu"
          checked={settings.local.startAtLogin}
          onChange={(startAtLogin) =>
            setSettings({
              ...settings,
              local: { ...settings.local, startAtLogin },
            })
          }
        />
        <Toggle
          label="Minimalizuj do zasobnika systemowego"
          checked={settings.local.minimizeToTray}
          onChange={(minimizeToTray) =>
            setSettings({
              ...settings,
              local: { ...settings.local, minimizeToTray },
            })
          }
        />
        <Toggle
          label="Pokaż okno, gdy plan importu jest gotowy"
          checked={settings.local.showWindowWhenPlanReady}
          onChange={(showWindowWhenPlanReady) =>
            setSettings({
              ...settings,
              local: { ...settings.local, showWindowWhenPlanReady },
            })
          }
        />
        <Toggle
          label="Powiadomienia systemowe"
          checked={settings.local.notificationsEnabled}
          onChange={(notificationsEnabled) =>
            setSettings({
              ...settings,
              local: { ...settings.local, notificationsEnabled },
            })
          }
        />
        <Field label="Po restarcie aplikacji">
          <select
            value={settings.local.resumeAfterRestart}
            onChange={(event) =>
              setSettings({
                ...settings,
                local: {
                  ...settings.local,
                  resumeAfterRestart: event.target.value as "ask" | "automatic",
                },
              })
            }
          >
            <option value="ask">Zapytaj przed wznowieniem</option>
            <option value="automatic">Wznów automatycznie</option>
          </select>
        </Field>
        <Field label="Równoległe importy">
          <input
            type="number"
            min={1}
            max={8}
            value={settings.local.maxConcurrentImports}
            onChange={(event) =>
              setSettings({
                ...settings,
                local: {
                  ...settings.local,
                  maxConcurrentImports: Number(event.target.value),
                },
              })
            }
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Miniatury"
        description="Lokalny cache znajduje się w systemowym katalogu cache aplikacji i nie zmienia biblioteki zdjęć."
      >
        <div className="button-row" data-wide>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void clearPreviews()}
          >
            Wyczyść cache miniaturek
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Przenoszenie ustawień"
        description="Eksport nie zawiera ścieżek ani powiązań nośników tego komputera."
      >
        <div className="button-row" data-wide>
          <button
            type="button"
            className="secondary"
            onClick={() => void exportConfiguration()}
            disabled={busy || dirty}
            title={dirty ? "Najpierw zapisz zmiany" : undefined}
          >
            Eksportuj JSON
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void importConfiguration()}
            disabled={busy}
          >
            Importuj JSON
          </button>
          {backupAvailable && (
            <button
              type="button"
              className="ghost"
              onClick={() => void restoreBackup()}
              disabled={busy}
            >
              Przywróć poprzednią wersję
            </button>
          )}
        </div>
      </SettingsSection>

      <footer className="settings-actions">
        <button
          type="button"
          className="ghost"
          onClick={() => void reload()}
          disabled={busy || !dirty}
        >
          Odrzuć zmiany
        </button>
        <button
          type="button"
          onClick={() => void persist()}
          disabled={busy || !dirty || validationErrors.length > 0}
        >
          {busy ? "Zapisywanie…" : "Zapisz ustawienia"}
        </button>
      </footer>
    </section>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-section">
      <div className="settings-section__intro">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="settings-grid">{children}</div>
    </div>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="field" data-wide={wide || undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function SourceBehaviorSelect({
  value,
  onChange,
}: {
  value: "ask" | "autoPreparePlan" | "ignore";
  onChange: (value: "ask" | "autoPreparePlan" | "ignore") => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as typeof value)}
    >
      <option value="ask">Pokaż powiadomienie i zapytaj</option>
      <option value="autoPreparePlan">Przygotuj plan automatycznie</option>
      <option value="ignore">Ignoruj</option>
    </select>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function CameraProfileEditor({
  profile,
  onChange,
  onRemove,
}: {
  profile: CameraProfile;
  onChange: (profile: CameraProfile) => void;
  onRemove: () => void;
}) {
  const matcher = profile.exifMatchers[0] ?? {
    make: null,
    model: null,
    serialNumber: null,
  };
  const updateMatcher = (patch: Partial<typeof matcher>) => {
    const next = { ...matcher, ...patch };
    const empty = [next.make, next.model, next.serialNumber].every(
      (value) => !value?.trim(),
    );
    onChange({ ...profile, exifMatchers: empty ? [] : [next] });
  };
  return (
    <div className="profile-card">
      <div className="profile-card__title">
        <input
          aria-label="Nazwa profilu"
          value={profile.name}
          onChange={(event) =>
            onChange({ ...profile, name: event.target.value })
          }
        />
        <button type="button" className="danger-quiet" onClick={onRemove}>
          Usuń profil
        </button>
      </div>
      <div className="profile-fields">
        <Field label="Producent EXIF">
          <input
            value={matcher.make ?? ""}
            onChange={(event) =>
              updateMatcher({ make: event.target.value || null })
            }
          />
        </Field>
        <Field label="Model EXIF">
          <input
            value={matcher.model ?? ""}
            onChange={(event) =>
              updateMatcher({ model: event.target.value || null })
            }
          />
        </Field>
        <Field label="Numer seryjny EXIF">
          <input
            value={matcher.serialNumber ?? ""}
            onChange={(event) =>
              updateMatcher({ serialNumber: event.target.value || null })
            }
          />
        </Field>
        <Field label="Domyślna korekta czasu (sekundy)">
          <input
            type="number"
            value={profile.defaultTimeOffsetSeconds}
            onChange={(event) =>
              onChange({
                ...profile,
                defaultTimeOffsetSeconds: Number(event.target.value),
              })
            }
          />
        </Field>
      </div>
    </div>
  );
}

function NoticeView({ notice }: { notice: Notice }) {
  return (
    <div
      className={`notice notice--${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.text}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { clearThumbnailCache } from "../../shared/sources";
import { describeOperationalError } from "../../shared/appStatus";
import { ErrorNotice } from "../../shared/ErrorNotice";
import { useTranslation } from "react-i18next";
import { setAppLanguage } from "../../i18n";
import {
  themePreferences,
  useTheme,
  type ThemePreference,
} from "../../theme/ThemeProvider";
import {
  exportPortableSettings,
  importPortableSettings,
  loadSettings,
  localizeSettingsError,
  normalizeSettingsError,
  renderFileNamePreview,
  renderFolderPreview,
  restoreSettingsBackup,
  saveSettings,
  validateSettings,
  type AppSettings,
  type CameraProfile,
  type SettingsCommandError,
} from "../../shared/settings";

type Notice =
  | {
      kind: "success" | "error" | "info";
      translationKey: string;
      text?: never;
    }
  | {
      kind: "success" | "error" | "info";
      text: string;
      translationKey?: never;
      error?: never;
    }
  | {
      kind: "error";
      error: unknown;
      text?: never;
      translationKey?: never;
    };

export function SettingsPanel() {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [backupAvailable, setBackupAvailable] = useState(false);
  const [loadError, setLoadError] = useState<SettingsCommandError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const validationErrors = useMemo(
    () => (settings ? validateSettings(settings) : []),
    [settings, i18n.resolvedLanguage],
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
        translationKey:
          response.source === "defaults"
            ? "settings.notices.loadedDefaults"
            : "settings.notices.loadedUser",
      });
    } catch (error) {
      const normalized = normalizeSettingsError(error);
      setLoadError(normalized);
      setBackupAvailable(normalized.backupAvailable === true);
      setNotice({ kind: "error", error });
    } finally {
      setBusy(false);
    }
  }

  function acceptResponse(value: AppSettings, hasBackup: boolean) {
    setSettings(value);
    setSavedSnapshot(JSON.stringify(value));
    setBackupAvailable(hasBackup);
    setLoadError(null);
    void setAppLanguage(value.local.uiLanguage);
  }

  async function persist() {
    if (!settings || validationErrors.length > 0) return;
    if (
      JSON.stringify(settings).includes('"autoImport"') &&
      !savedSnapshot.includes('"autoImport"') &&
      !window.confirm(t("settings.sourceBehavior.autoImportConfirmation"))
    )
      return;
    setBusy(true);
    try {
      const response = await saveSettings(settings);
      acceptResponse(response.settings, response.backupAvailable);
      setNotice({
        kind: "success",
        translationKey: "settings.notices.saved",
      });
    } catch (error) {
      setNotice({ kind: "error", error });
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
        translationKey: "settings.notices.restored",
      });
    } catch (error) {
      setNotice({ kind: "error", error });
    } finally {
      setBusy(false);
    }
  }

  async function chooseLibrary() {
    if (!settings) return;
    const path = await open({
      directory: true,
      multiple: false,
      title: t("settings.library.dialogTitle"),
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
      title: t("settings.transfer.exportDialog"),
      defaultPath: "photo-importer-settings.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      await exportPortableSettings(path);
      setNotice({
        kind: "success",
        translationKey: "settings.notices.exported",
      });
    } catch (error) {
      setNotice({ kind: "error", error });
    } finally {
      setBusy(false);
    }
  }

  async function importConfiguration() {
    const path = await open({
      multiple: false,
      title: t("settings.transfer.importDialog"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const response = await importPortableSettings(path);
      acceptResponse(response.settings, response.backupAvailable);
      setNotice({
        kind: "success",
        translationKey: "settings.notices.imported",
      });
    } catch (error) {
      setNotice({ kind: "error", error });
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
        translationKey: "settings.notices.cacheCleared",
      });
    } catch (error) {
      setNotice({ kind: "error", error });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <section className="settings-layout">
        <AppearanceSettings />
        <div className="settings-empty" aria-live="polite">
          <p>{busy ? t("settings.loading") : t("settings.loadFailed")}</p>
          {loadError ? (
            <ErrorNotice
              error={describeOperationalError(loadError, "settings")}
              onRetry={() => void reload()}
            />
          ) : (
            notice && <NoticeView notice={notice} />
          )}
          <div className="button-row">
            <button type="button" onClick={() => void reload()} disabled={busy}>
              {t("common.retry")}
            </button>
            {backupAvailable && (
              <button
                type="button"
                className="secondary"
                onClick={() => void restoreBackup()}
                disabled={busy}
              >
                {t("settings.restoreBackup")}
              </button>
            )}
          </div>
          {loadError?.code === "corruptedPrimary" && (
            <p className="help-text">{t("settings.corruptFilePreserved")}</p>
          )}
        </div>
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
          <p className="section-label">{t("settings.heading.eyebrow")}</p>
          <h2>{t("settings.heading.title")}</h2>
          <p>{t("settings.heading.description")}</p>
        </div>
        <span className={dirty ? "dirty-badge" : "saved-badge"}>
          {dirty ? t("settings.heading.dirty") : t("settings.heading.saved")}
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

      <AppearanceSettings />

      <SettingsSection
        title={t("settings.library.title")}
        description={t("settings.library.description")}
      >
        <Field label={t("settings.library.path")} wide>
          <div className="path-control">
            <input
              readOnly
              value={settings.local.libraryPath ?? ""}
              placeholder={t("settings.library.placeholder")}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => void chooseLibrary()}
            >
              {t("common.choose")}
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
                {t("common.clear")}
              </button>
            )}
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection
        title={t("settings.import.title")}
        description={t("settings.import.description")}
      >
        <Field label={t("settings.import.operation")}>
          <select
            value={settings.portable.import.defaultOperation}
            onChange={(event) =>
              updatePortableImport({
                defaultOperation: event.target
                  .value as AppSettings["portable"]["import"]["defaultOperation"],
              })
            }
          >
            <option value="copy">{t("settings.import.copy")}</option>
            <option value="moveAfterVerification">
              {t("settings.import.move")}
            </option>
          </select>
        </Field>
        <Field label={t("settings.import.knownCard")}>
          <SourceBehaviorSelect
            value={settings.portable.import.defaultSourceBehavior}
            onChange={(defaultSourceBehavior) =>
              updatePortableImport({ defaultSourceBehavior })
            }
          />
        </Field>
        <Field label={t("settings.import.eventGap")}>
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
            <span>{t("settings.import.minutes")}</span>
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection
        title={t("settings.naming.title")}
        description={t("settings.naming.description")}
      >
        <Field label={t("settings.naming.folderTemplate")} wide>
          <input
            value={settings.portable.naming.folderTemplate}
            onChange={(event) =>
              updateNaming({ folderTemplate: event.target.value })
            }
          />
          <p className="help-text">{t("settings.naming.folderHelp")}</p>
          <code className="template-preview">
            {renderFolderPreview(settings.portable.naming.folderTemplate)}
          </code>
        </Field>
        <Field label={t("settings.naming.fileTemplate")} wide>
          <input
            value={settings.portable.naming.fileNameTemplate}
            onChange={(event) =>
              updateNaming({ fileNameTemplate: event.target.value })
            }
          />
          <p className="help-text">{t("settings.naming.fileHelp")}</p>
          <code className="template-preview">
            {renderFileNamePreview(settings.portable.naming.fileNameTemplate)}
          </code>
        </Field>
        <Field label={t("settings.naming.collision")}>
          <select
            value={settings.portable.naming.collisionPolicy}
            onChange={(event) =>
              updateNaming({
                collisionPolicy: event.target
                  .value as AppSettings["portable"]["naming"]["collisionPolicy"],
              })
            }
          >
            <option value="ask">{t("settings.naming.collisionAsk")}</option>
            <option value="appendSequence">
              {t("settings.naming.collisionSequence")}
            </option>
          </select>
        </Field>
      </SettingsSection>

      <SettingsSection
        title={t("settings.profiles.title")}
        description={t("settings.profiles.description")}
      >
        <div className="profiles" data-wide>
          {settings.portable.cameraProfiles.length === 0 && (
            <p className="empty-copy">{t("settings.profiles.empty")}</p>
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
                name: t("settings.profiles.defaultName", {
                  number: settings.portable.cameraProfiles.length + 1,
                }),
                exifMatchers: [],
                defaultTimeOffsetSeconds: 0,
                sourceBehavior: null,
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
            {t("settings.profiles.add")}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.bindings.title")}
        description={t("settings.bindings.description")}
      >
        <div className="bindings" data-wide>
          {settings.local.sourceBindings.length === 0 ? (
            <p className="empty-copy">{t("settings.bindings.empty")}</p>
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
                    .join(", ") || t("settings.profiles.unknownCamera")}
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
                  {t("common.remove")}
                </button>
              </div>
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.behavior.title")}
        description={t("settings.behavior.description")}
      >
        <Field label={t("settings.language.label")}>
          <select
            value={settings.local.uiLanguage}
            aria-label={t("settings.language.label")}
            aria-describedby="ui-language-description"
            onChange={(event) => {
              const uiLanguage = event.target
                .value as AppSettings["local"]["uiLanguage"];
              setSettings({
                ...settings,
                local: { ...settings.local, uiLanguage },
              });
              void setAppLanguage(uiLanguage);
            }}
          >
            <option value="en">English</option>
            <option value="pl">Polski</option>
          </select>
          <p className="help-text" id="ui-language-description">
            {t("settings.language.description")}
          </p>
        </Field>
        <Toggle
          label={t("settings.behavior.startAtLogin")}
          checked={settings.local.startAtLogin}
          onChange={(startAtLogin) =>
            setSettings({
              ...settings,
              local: { ...settings.local, startAtLogin },
            })
          }
        />
        <Toggle
          label={t("settings.behavior.minimizeToTray")}
          checked={settings.local.minimizeToTray}
          onChange={(minimizeToTray) =>
            setSettings({
              ...settings,
              local: { ...settings.local, minimizeToTray },
            })
          }
        />
        <Toggle
          label={t("settings.behavior.showWhenPlanReady")}
          checked={settings.local.showWindowWhenPlanReady}
          onChange={(showWindowWhenPlanReady) =>
            setSettings({
              ...settings,
              local: { ...settings.local, showWindowWhenPlanReady },
            })
          }
        />
        <Toggle
          label={t("settings.behavior.notifications")}
          checked={settings.local.notificationsEnabled}
          onChange={(notificationsEnabled) =>
            setSettings({
              ...settings,
              local: { ...settings.local, notificationsEnabled },
            })
          }
        />
        <Field label={t("settings.behavior.afterRestart")}>
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
            <option value="ask">{t("settings.behavior.resumeAsk")}</option>
            <option value="automatic">
              {t("settings.behavior.resumeAutomatic")}
            </option>
          </select>
        </Field>
        <Field label={t("settings.behavior.concurrency")}>
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
        title={t("settings.thumbnails.title")}
        description={t("settings.thumbnails.description")}
      >
        <div className="button-row" data-wide>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void clearPreviews()}
          >
            {t("settings.thumbnails.clear")}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("settings.transfer.title")}
        description={t("settings.transfer.description")}
      >
        <div className="button-row" data-wide>
          <button
            type="button"
            className="secondary"
            onClick={() => void exportConfiguration()}
            disabled={busy || dirty}
            title={dirty ? t("settings.transfer.saveFirst") : undefined}
          >
            {t("settings.transfer.export")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void importConfiguration()}
            disabled={busy}
          >
            {t("settings.transfer.import")}
          </button>
          {backupAvailable && (
            <button
              type="button"
              className="ghost"
              onClick={() => void restoreBackup()}
              disabled={busy}
            >
              {t("settings.transfer.restorePrevious")}
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
          {t("settings.actions.discard")}
        </button>
        <button
          type="button"
          onClick={() => void persist()}
          disabled={busy || !dirty || validationErrors.length > 0}
        >
          {busy ? t("settings.actions.saving") : t("settings.actions.save")}
        </button>
      </footer>
    </section>
  );
}

function AppearanceSettings() {
  const { t } = useTranslation();
  const { preference, resolvedTheme, setPreference } = useTheme();

  return (
    <SettingsSection
      title={t("settings.appearance.title")}
      description={t("settings.appearance.description")}
    >
      <Field label={t("settings.appearance.theme")}>
        <select
          aria-label={t("settings.appearance.theme")}
          aria-describedby="theme-active-description"
          value={preference}
          onChange={(event) =>
            setPreference(event.target.value as ThemePreference)
          }
        >
          {themePreferences.map((theme) => (
            <option key={theme} value={theme}>
              {t(`settings.appearance.options.${theme}`)}
            </option>
          ))}
        </select>
        <p className="help-text" id="theme-active-description">
          {t("settings.appearance.active", {
            theme: t(`settings.appearance.resolved.${resolvedTheme}`),
          })}
        </p>
      </Field>
    </SettingsSection>
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
  value: "ask" | "autoPreparePlan" | "autoImport" | "ignore";
  onChange: (
    value: "ask" | "autoPreparePlan" | "autoImport" | "ignore",
  ) => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as typeof value)}
    >
      <option value="ask">{t("settings.sourceBehavior.ask")}</option>
      <option value="autoPreparePlan">
        {t("settings.sourceBehavior.autoPreparePlan")}
      </option>
      <option value="autoImport">
        {t("settings.sourceBehavior.autoImport")}
      </option>
      <option value="ignore">{t("settings.sourceBehavior.ignore")}</option>
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
  const { t } = useTranslation();
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
          aria-label={t("settings.profiles.name")}
          value={profile.name}
          onChange={(event) =>
            onChange({ ...profile, name: event.target.value })
          }
        />
        <button type="button" className="danger-quiet" onClick={onRemove}>
          {t("settings.profiles.remove")}
        </button>
      </div>
      <div className="profile-fields">
        <Field label={t("settings.profiles.automation")}>
          <select
            value={profile.sourceBehavior ?? ""}
            onChange={(event) =>
              onChange({
                ...profile,
                sourceBehavior: event.target.value
                  ? (event.target.value as NonNullable<
                      CameraProfile["sourceBehavior"]
                    >)
                  : null,
              })
            }
          >
            <option value="">{t("settings.sourceBehavior.inherit")}</option>
            <option value="ask">{t("settings.sourceBehavior.ask")}</option>
            <option value="autoPreparePlan">
              {t("settings.sourceBehavior.autoPreparePlan")}
            </option>
            <option value="autoImport">
              {t("settings.sourceBehavior.autoImport")}
            </option>
            <option value="ignore">
              {t("settings.sourceBehavior.ignore")}
            </option>
          </select>
        </Field>
        <Field label={t("settings.profiles.make")}>
          <input
            value={matcher.make ?? ""}
            onChange={(event) =>
              updateMatcher({ make: event.target.value || null })
            }
          />
        </Field>
        <Field label={t("settings.profiles.model")}>
          <input
            value={matcher.model ?? ""}
            onChange={(event) =>
              updateMatcher({ model: event.target.value || null })
            }
          />
        </Field>
        <Field label={t("settings.profiles.serial")}>
          <input
            value={matcher.serialNumber ?? ""}
            onChange={(event) =>
              updateMatcher({ serialNumber: event.target.value || null })
            }
          />
        </Field>
        <Field label={t("settings.profiles.timeOffset")}>
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
  const { t } = useTranslation();
  return (
    <div
      className={`notice notice--${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {"error" in notice
        ? localizeSettingsError(notice.error)
        : notice.translationKey
          ? t(notice.translationKey)
          : notice.text}
    </div>
  );
}

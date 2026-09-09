import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  listImportEvents,
  renameImportEvent,
  type ImportEventSummary,
} from "../../shared/sources";
import { normalizeSettingsError } from "../../shared/settings";

export function ImportHistoryPanel() {
  const { i18n } = useTranslation();
  const polish = i18n.resolvedLanguage?.startsWith("pl") ?? false;
  const l = (en: string, pl: string) => (polish ? pl : en);
  const [events, setEvents] = useState<ImportEventSummary[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setEvents((await listImportEvents()) ?? []);
      setError(null);
    } catch (cause) {
      setError(normalizeSettingsError(cause).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function save(event: ImportEventSummary) {
    setBusy(true);
    try {
      await renameImportEvent(event.eventId, draft);
      setEditing(null);
      await refresh();
    } catch (cause) {
      setError(normalizeSettingsError(cause).message);
      setBusy(false);
    }
  }

  return (
    <section className="history-panel">
      <div className="panel-heading">
        <div>
          <p className="section-label">
            {l("LIBRARY HISTORY", "HISTORIA BIBLIOTEKI")}
          </p>
          <h2>{l("Imported events", "Zaimportowane wydarzenia")}</h2>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? l("Refreshing…", "Odświeżanie…") : l("Refresh", "Odśwież")}
        </button>
      </div>
      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}
      {events.length === 0 ? (
        <p className="plans-empty">
          {l(
            "No imported events with tracking metadata.",
            "Brak zaimportowanych wydarzeń z metadanymi śledzenia.",
          )}
        </p>
      ) : (
        <div className="history-events">
          {events.map((event) => (
            <article className="history-event" key={event.eventId}>
              <div>
                {editing === event.eventId ? (
                  <input
                    value={draft}
                    autoFocus
                    aria-label={l("Event name", "Nazwa wydarzenia")}
                    onChange={(change) => setDraft(change.target.value)}
                  />
                ) : (
                  <h3>{event.name}</h3>
                )}
                <p>{event.folderPath}</p>
                <small>
                  {event.fileCount} {l("files", "plików")}
                </small>
              </div>
              <div className="source-card__actions">
                {editing === event.eventId ? (
                  <>
                    <button
                      type="button"
                      disabled={busy || !draft.trim()}
                      onClick={() => void save(event)}
                    >
                      {l("Save", "Zapisz")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      {l("Cancel", "Anuluj")}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setEditing(event.eventId);
                      setDraft(event.name);
                    }}
                  >
                    {l("Rename", "Zmień nazwę")}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

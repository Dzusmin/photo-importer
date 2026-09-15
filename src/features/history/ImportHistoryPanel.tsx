import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  listImportEvents,
  renameImportEvent,
  type ImportEventAttention,
  type ImportEventSort,
  type ImportEventSummary,
  type ImportSession,
} from "../../shared/sources";
import { normalizeSettingsError } from "../../shared/settings";

export function ImportHistoryPanel({
  refreshRevision = 0,
}: {
  refreshRevision?: number;
}) {
  const { i18n } = useTranslation();
  const polish = i18n.resolvedLanguage?.startsWith("pl") ?? false;
  const l = (en: string, pl: string) => (polish ? pl : en);
  const [events, setEvents] = useState<ImportEventSummary[]>([]);
  const [sort, setSort] = useState<ImportEventSort>("latestImport");
  const [needsAttention, setNeedsAttention] = useState<ImportEventAttention[]>(
    [],
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await listImportEvents(sort);
      setEvents(result.events ?? []);
      setNeedsAttention(result.needsAttention ?? []);
      setError(null);
    } catch (cause) {
      setError(normalizeSettingsError(cause).message);
    } finally {
      setBusy(false);
    }
  }, [sort]);

  useEffect(() => void refresh(), [refresh, refreshRevision]);

  useEffect(() => {
    let active = true;
    const unlisten = listen<ImportSession>("import-progress", (event) => {
      if (
        active &&
        (["completed", "cancelled"] as ImportSession["status"][]).includes(
          event.payload.status,
        )
      ) {
        void refresh();
      }
    });

    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, [refresh]);

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
        <div className="history-panel__controls">
          <label>
            <span>{l("Sort by", "Sortuj według")}</span>
            <select
              value={sort}
              disabled={busy}
              onChange={(change) =>
                setSort(change.target.value as ImportEventSort)
              }
            >
              <option value="latestImport">
                {l("Latest import", "Najnowszy import")}
              </option>
              <option value="eventName">
                {l("Event name", "Nazwa wydarzenia")}
              </option>
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? l("Refreshing…", "Odświeżanie…") : l("Refresh", "Odśwież")}
          </button>
        </div>
      </div>
      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}
      {needsAttention.length > 0 && (
        <section
          className="history-attention"
          aria-labelledby="history-attention-heading"
        >
          <div>
            <h3 id="history-attention-heading">
              {l("Needs attention", "Wymaga uwagi")}
            </h3>
            <small>
              {l(
                "Repair or replace the event marker to restore this event to history.",
                "Napraw lub zastąp marker wydarzenia, aby przywrócić je do historii.",
              )}
            </small>
          </div>
          {needsAttention.map((item) => (
            <article key={item.folderPath}>
              <p>{item.folderPath}</p>
              <small>{item.reason}</small>
            </article>
          ))}
        </section>
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

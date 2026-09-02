import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emit } from "@tauri-apps/api/event";
import {
  getBackgroundStatus,
  acknowledgePendingSource,
  refreshBackgroundMonitor,
  startSourceWorkflow,
  ignoreSourceUntilDisconnect,
  type BackgroundStatus,
} from "../../shared/background";

export function BackgroundMonitor() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    void getBackgroundStatus().then((value) => active && setStatus(value));
    const unlisten = listen<BackgroundStatus>("background-status", (event) => {
      if (active) setStatus(event.payload);
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setStatus(await refreshBackgroundMonitor());
    } finally {
      window.setTimeout(() => setRefreshing(false), 500);
    }
  }

  return (
    <section className="background-monitor" aria-live="polite">
      <div className="background-monitor__summary">
        <span
          className={`automation-dot ${status?.running ? "automation-dot--active" : ""}`}
        />
        <div>
          <p className="section-label">AUTOMAT W TLE</p>
          <strong>
            {status?.activeAutoScanCount
              ? `Skanowanie ${status.activeAutoScanCount} źródła`
              : "Monitor nośników działa"}
          </strong>
          <small>
            {status
              ? `${status.connectedKnownSourceCount} znanych nośników · ostatnia kontrola ${formatTime(status.lastCheckedAtUnixMs)}`
              : "Odczytywanie stanu…"}
          </small>
        </div>
      </div>
      <div className="background-monitor__actions">
        <span className={status?.startAtLoginEnabled ? "status-on" : undefined}>
          Autostart: {status?.startAtLoginEnabled ? "włączony" : "wyłączony"}
        </span>
        <button
          type="button"
          className="secondary"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? "Sprawdzanie…" : "Sprawdź teraz"}
        </button>
      </div>
      {status?.lastError && (
        <p className="background-monitor__error">{status.lastError}</p>
      )}
      {status?.pendingSources.map((source) => (
        <div className="background-monitor__event" key={source.fingerprint}>
          <span>SD</span>
          <div>
            <strong>{source.name} czeka na decyzję</strong>
            <small>{source.sourcePath}</small>
            {source.probableMatch && (
              <small>
                Tożsamość karty zmieniła się — wymagane potwierdzenie.
              </small>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              void startSourceWorkflow(source.sourcePath);
              void acknowledgePendingSource(source.sourcePath).then(setStatus);
            }}
          >
            Skanuj i przygotuj plan
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void ignoreSourceUntilDisconnect(source.sourcePath).then(
                setStatus,
              )
            }
          >
            Tym razem ignoruj
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void emit("open-settings")}
          >
            Zmień zachowanie tej karty
          </button>
        </div>
      ))}
      {status?.events[0] && (
        <div className="background-monitor__event">
          <span>{eventIcon(status.events[0].kind)}</span>
          <div>
            <strong>{status.events[0].title}</strong>
            <small>{status.events[0].detail}</small>
          </div>
          <time>{formatTime(status.events[0].occurredAtUnixMs)}</time>
        </div>
      )}
    </section>
  );
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return "jeszcze nie wykonano";
  return new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function eventIcon(kind: string): string {
  if (kind === "scanCompleted") return "✓";
  if (kind === "scanFailed") return "!";
  if (kind === "sourceDisconnected") return "−";
  return "+";
}

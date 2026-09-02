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
import {
  describeOperationalError,
  type AppStatus,
} from "../../shared/appStatus";
import { ErrorNotice } from "../../shared/ErrorNotice";

const ignoreHealthChange = () => undefined;

export function BackgroundMonitor({
  appStatus = "ready",
  onHealthChange = ignoreHealthChange,
}: {
  appStatus?: AppStatus;
  onHealthChange?: (healthy: boolean) => void;
} = {}) {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    if (appStatus === "connecting" || appStatus === "error") {
      setStatus(null);
      return;
    }
    let active = true;
    void getBackgroundStatus()
      .then((value) => {
        if (!active) return;
        setStatus(value);
        setLoadError(null);
        onHealthChange(value.running && !value.lastError);
      })
      .catch((error) => {
        if (!active) return;
        setStatus(null);
        setLoadError(error);
        onHealthChange(false);
      });
    const unlisten = listen<BackgroundStatus>("background-status", (event) => {
      if (active) {
        setStatus(event.payload);
        setLoadError(null);
        onHealthChange(event.payload.running && !event.payload.lastError);
      }
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, [appStatus === "connecting" || appStatus === "error", onHealthChange]);

  async function refresh() {
    setRefreshing(true);
    try {
      const value = await refreshBackgroundMonitor();
      setStatus(value);
      setLoadError(null);
      onHealthChange(value.running && !value.lastError);
    } catch (error) {
      setStatus(null);
      setLoadError(error);
      onHealthChange(false);
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
            {appStatus === "connecting"
              ? "Łączenie…"
              : appStatus === "error"
                ? "Monitor niedostępny"
                : status?.activeAutoScanCount
                  ? `Skanowanie ${status.activeAutoScanCount} źródła`
                  : status?.running && status.lastError
                    ? "Monitor działa z ograniczeniami"
                    : status?.running
                      ? "Monitor nośników działa"
                      : status
                        ? "Monitor jest zatrzymany"
                        : "Sprawdzanie monitora…"}
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
          disabled={
            refreshing || appStatus === "connecting" || appStatus === "error"
          }
          onClick={() => void refresh()}
        >
          {refreshing ? "Sprawdzanie…" : "Sprawdź teraz"}
        </button>
      </div>
      {loadError !== null && (
        <ErrorNotice
          error={describeOperationalError(loadError, "read")}
          onRetry={() => void refresh()}
        />
      )}
      {status?.lastError && (
        <ErrorNotice
          error={describeOperationalError(status.lastError, "read")}
          onRetry={() => void refresh()}
        />
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

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getSystemStatus, type SystemStatus } from "./shared/systemStatus";
import { SettingsPanel } from "./features/settings/SettingsPanel";
import { SourceScanner } from "./features/sources/SourceScanner";
import { BackgroundMonitor } from "./features/background/BackgroundMonitor";
import "./App.css";

type LoadingState = "loading" | "ready" | "error";

function App() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>("loading");
  const [activeView, setActiveView] = useState<"home" | "settings">("home");

  useEffect(() => {
    let cancelled = false;
    const loadSystemStatus = async () => {
      try {
        const systemStatus = await getSystemStatus();
        if (cancelled) return;
        if (!systemStatus) {
          setLoadingState("error");
          return;
        }
        setStatus(systemStatus);
        setLoadingState("ready");
      } catch {
        if (!cancelled) setLoadingState("error");
      }
    };
    void loadSystemStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen("open-settings", () => setActiveView("settings"));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ view: "home"; sourcePath: string | null }>(
      "notification-route",
      () => setActiveView("home"),
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          PI
        </div>
        <div>
          <p className="eyebrow">PHOTO IMPORTER</p>
          <h1>Twoje zdjęcia, bezpiecznie na miejscu.</h1>
        </div>
        <span className={`health health--${loadingState}`}>
          <span className="health__dot" />
          {loadingState === "ready" && "Backend działa"}
          {loadingState === "loading" && "Łączenie…"}
          {loadingState === "error" && "Brak połączenia"}
        </span>
      </header>

      <nav className="main-nav" aria-label="Główna nawigacja">
        <button
          type="button"
          className={activeView === "home" ? "main-nav__active" : undefined}
          onClick={() => setActiveView("home")}
        >
          Start
        </button>
        <button
          type="button"
          className={activeView === "settings" ? "main-nav__active" : undefined}
          onClick={() => setActiveView("settings")}
        >
          Ustawienia
        </button>
      </nav>

      {activeView === "settings" ? (
        <SettingsPanel />
      ) : (
        <>
          <BackgroundMonitor />
          <SourceScanner />

          <section className="diagnostics" aria-label="Diagnostyka aplikacji">
            <Diagnostic label="Produkt" value={status?.productName ?? "—"} />
            <Diagnostic label="Wersja" value={status?.appVersion ?? "—"} />
            <Diagnostic
              label="System"
              value={
                status
                  ? `${status.operatingSystem} / ${status.architecture}`
                  : "—"
              }
            />
            <Diagnostic
              label="Silnik importu"
              value="Szkielet gotowy"
              highlight
            />
          </section>
        </>
      )}
    </main>
  );
}

function Diagnostic({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="diagnostic">
      <span>{label}</span>
      <strong className={highlight ? "diagnostic__highlight" : undefined}>
        {value}
      </strong>
    </div>
  );
}

export default App;

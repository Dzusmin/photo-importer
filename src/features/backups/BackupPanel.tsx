import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelBackupJob,
  listBackupJobs,
  listBackupTargets,
  normalizeBackupError,
  pauseBackupJob,
  prepareBackupPlan,
  recognizeBackupTarget,
  registerBackupTarget,
  resumeBackupJob,
  startBackupJob,
  type BackupJob,
  type BackupPhase,
  type BackupPlan,
  type BackupTarget,
} from "../../shared/backups";
import { loadSettings } from "../../shared/settings";
import { listMediaSources, type SourceVolume } from "../../shared/sources";

const phaseLabels: Record<BackupPhase, string> = {
  scanningLibrary: "Skanowanie biblioteki",
  hashing: "Obliczanie skrótów",
  copying: "Kopiowanie",
  verifying: "Weryfikacja",
  finalizing: "Finalizacja",
};

export function BackupPanel() {
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [volumes, setVolumes] = useState<SourceVolume[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [job, setJob] = useState<BackupJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [newTargetPath, setNewTargetPath] = useState("");
  const [newTargetLabel, setNewTargetLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshVolumes = useCallback(async () => {
    const discovered = await listMediaSources();
    setVolumes(discovered);
    const recognized = await Promise.all(
      discovered.map((volume) =>
        recognizeBackupTarget(volume.mountPath).catch(() => null),
      ),
    );
    const connected = recognized.filter(
      (target): target is BackupTarget => target !== null,
    );
    if (connected.length > 0) {
      setTargets((known) =>
        known.map(
          (target) =>
            connected.find((candidate) => candidate.id === target.id) ?? target,
        ),
      );
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      listBackupTargets(),
      listBackupJobs(),
      loadSettings(),
      listMediaSources(),
    ])
      .then(async ([knownTargets, jobs, settings, discovered]) => {
        const recognized = await Promise.all(
          discovered.map((volume) =>
            recognizeBackupTarget(volume.mountPath).catch(() => null),
          ),
        );
        if (disposed) return;
        const refreshedTargets = knownTargets.map(
          (target) =>
            recognized.find((candidate) => candidate?.id === target.id) ??
            target,
        );
        const firstConnected = refreshedTargets.find((target) =>
          discovered.some((volume) =>
            samePath(volume.mountPath, target.lastKnownRoot),
          ),
        );
        setTargets(refreshedTargets);
        setVolumes(discovered);
        setSelectedTargetId(
          firstConnected?.id ?? refreshedTargets[0]?.id ?? "",
        );
        setLibraryPath(settings.settings.local.libraryPath);
        setJob(
          jobs.find((item) => ["running", "paused"].includes(item.status)) ??
            jobs[0] ??
            null,
        );
      })
      .catch((reason) => {
        if (!disposed) setError(normalizeBackupError(reason).message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(
      () => void refreshVolumes().catch(() => undefined),
      5000,
    );
    const refreshOnFocus = () => void refreshVolumes().catch(() => undefined);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refreshVolumes]);

  useEffect(() => {
    let disposed = false;
    const unlisten = listen<BackupJob>("backup-progress", (event) => {
      if (!disposed) setJob(event.payload);
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const selectedTarget = targets.find(
    (target) => target.id === selectedTargetId,
  );
  const selectedVolume = selectedTarget
    ? volumes.find((volume) =>
        samePath(volume.mountPath, selectedTarget.lastKnownRoot),
      )
    : undefined;
  const active = job?.status === "running" || job?.status === "paused";
  const insufficientSpace = Boolean(
    plan &&
    selectedVolume &&
    plan.totalCopyBytes > selectedVolume.availableBytes,
  );

  async function chooseTargetDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setNewTargetPath(selected);
  }

  async function registerTarget() {
    if (!newTargetPath.trim() || !newTargetLabel.trim()) return;
    setRegistering(true);
    setError(null);
    try {
      const target = await registerBackupTarget(
        newTargetPath.trim(),
        newTargetLabel.trim(),
      );
      setTargets((current) => [
        target,
        ...current.filter((item) => item.id !== target.id),
      ]);
      setSelectedTargetId(target.id);
      setVolumes(await listMediaSources());
      setPlan(null);
      setRegistrationOpen(false);
      setNewTargetPath("");
      setNewTargetLabel("");
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    } finally {
      setRegistering(false);
    }
  }

  async function preparePlan() {
    if (!selectedTarget || !selectedVolume || !libraryPath) return;
    setPlanning(true);
    setPlan(null);
    setError(null);
    try {
      setPlan(
        await prepareBackupPlan(
          selectedTarget.id,
          selectedVolume.mountPath,
          libraryPath,
        ),
      );
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    } finally {
      setPlanning(false);
    }
  }

  async function start() {
    if (
      !selectedTarget ||
      !selectedVolume ||
      !libraryPath ||
      !plan ||
      insufficientSpace
    )
      return;
    setError(null);
    try {
      setJob(await startBackupJob(plan, selectedVolume.mountPath));
      setPlan(null);
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!job) return;
    setControlling(true);
    setError(null);
    try {
      const updated =
        action === "pause"
          ? await pauseBackupJob(job.id)
          : action === "resume"
            ? await resumeBackupJob(job.id)
            : await cancelBackupJob(job.id);
      setJob(updated);
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    } finally {
      setControlling(false);
    }
  }

  const runningTargetConnected =
    !active ||
    volumes.some((volume) => samePath(volume.mountPath, job?.targetPath ?? ""));

  return (
    <section className="backup-layout">
      <div className="backup-heading">
        <div>
          <p className="section-label">BACKUP</p>
          <h2>Bezpieczna kopia całej biblioteki.</h2>
          <p>
            Najpierw sprawdzimy zawartość i pokażemy plan. Kopiowanie rozpocznie
            się dopiero po Twoim zatwierdzeniu.
          </p>
        </div>
      </div>

      {error && (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      )}
      {!runningTargetConnected && (
        <div className="notice notice--error" role="alert">
          Dysk backupu został odłączony. Podłącz go ponownie; nie uruchamiaj
          nowego zadania na innym nośniku pod tą samą literą.
        </div>
      )}

      <div className="backup-targets">
        <div className="backup-section-heading">
          <div>
            <h3>Cele backupu</h3>
            <p>Znane dyski i ich aktualny stan połączenia.</p>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={active}
            onClick={() => setRegistrationOpen((value) => !value)}
          >
            Zarejestruj nowy dysk
          </button>
        </div>

        {registrationOpen && (
          <div className="backup-registration">
            <label className="field">
              <span>Nazwa dysku</span>
              <input
                value={newTargetLabel}
                placeholder="np. Archiwum domowe"
                onChange={(event) => setNewTargetLabel(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Katalog główny dysku</span>
              <div className="path-control">
                <input
                  value={newTargetPath}
                  readOnly
                  placeholder="Wybierz podłączony dysk"
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void chooseTargetDirectory()}
                >
                  Wybierz…
                </button>
              </div>
            </label>
            <button
              type="button"
              disabled={
                registering || !newTargetLabel.trim() || !newTargetPath.trim()
              }
              onClick={() => void registerTarget()}
            >
              {registering ? "Rejestrowanie…" : "Zarejestruj dysk"}
            </button>
          </div>
        )}

        <div
          className="backup-target-list"
          role="radiogroup"
          aria-label="Cel backupu"
        >
          {targets.map((target) => {
            const volume = volumes.find((item) =>
              samePath(item.mountPath, target.lastKnownRoot),
            );
            return (
              <label
                className={`backup-target${selectedTargetId === target.id ? " backup-target--selected" : ""}`}
                key={target.id}
              >
                <input
                  type="radio"
                  name="backup-target"
                  value={target.id}
                  checked={selectedTargetId === target.id}
                  disabled={active}
                  onChange={() => {
                    setSelectedTargetId(target.id);
                    setPlan(null);
                  }}
                />
                <span
                  className={`connection-dot connection-dot--${volume ? "online" : "offline"}`}
                />
                <span>
                  <strong>{target.label}</strong>
                  <code>{volume?.mountPath ?? target.lastKnownRoot}</code>
                </span>
                <small>
                  {volume
                    ? `Podłączony · wolne ${formatBytes(volume.availableBytes)}`
                    : "Niepodłączony"}
                </small>
              </label>
            );
          })}
        </div>
        {!loading && targets.length === 0 && (
          <p className="backup-empty">
            Nie masz jeszcze zarejestrowanego dysku backupu.
          </p>
        )}
      </div>

      {!active && (
        <div className="backup-planner">
          <div className="backup-source">
            <span>Biblioteka źródłowa</span>
            <code>
              {libraryPath ?? "Nie skonfigurowano katalogu biblioteki"}
            </code>
          </div>
          <button
            type="button"
            disabled={
              loading ||
              planning ||
              !selectedTarget ||
              !selectedVolume ||
              !libraryPath
            }
            onClick={() => void preparePlan()}
          >
            {planning ? "Analizowanie…" : "Przygotuj plan backupu"}
          </button>
          {selectedTarget && !selectedVolume && (
            <p className="backup-inline-warning" role="alert">
              Podłącz wybrany dysk, aby przygotować plan.
            </p>
          )}
        </div>
      )}

      {plan && selectedVolume && (
        <BackupPlanPreview
          plan={plan}
          availableBytes={selectedVolume.availableBytes}
          insufficientSpace={insufficientSpace}
          onStart={start}
        />
      )}
      {job && (
        <BackupProgress
          job={job}
          controlling={controlling}
          onControl={control}
        />
      )}
    </section>
  );
}

function BackupPlanPreview({
  plan,
  availableBytes,
  insufficientSpace,
  onStart,
}: {
  plan: BackupPlan;
  availableBytes: number;
  insufficientSpace: boolean;
  onStart: () => Promise<void>;
}) {
  const count = (kind: "new" | "changed" | "repair") =>
    plan.operations.filter((operation) => operation.kind === kind).length;
  return (
    <div className="backup-plan" aria-label="Podsumowanie planu backupu">
      <div className="backup-section-heading">
        <div>
          <p className="section-label">PLAN GOTOWY</p>
          <h3>Sprawdź i zatwierdź kopiowanie</h3>
        </div>
      </div>
      <div className="backup-plan-grid">
        <Metric label="Nowe pliki" value={String(count("new"))} />
        <Metric label="Zmienione pliki" value={String(count("changed"))} />
        <Metric label="Pliki do naprawy" value={String(count("repair"))} />
        <Metric
          label="Niezmienione pliki"
          value={String(plan.unchangedFileCount)}
        />
        <Metric
          label="Wymagane miejsce"
          value={formatBytes(plan.totalCopyBytes)}
        />
      </div>
      {insufficientSpace ? (
        <div className="backup-space-warning" role="alert">
          Za mało miejsca na dysku. Potrzeba {formatBytes(plan.totalCopyBytes)},
          a dostępne jest {formatBytes(availableBytes)}.
        </div>
      ) : (
        <p className="backup-space-ok">
          Dostępne miejsce: {formatBytes(availableBytes)}
        </p>
      )}
      <div className="backup-plan-actions">
        <p>Po zatwierdzeniu pliki zostaną skopiowane i zweryfikowane.</p>
        <button
          type="button"
          disabled={insufficientSpace}
          onClick={() => void onStart()}
        >
          Zatwierdź i rozpocznij backup
        </button>
      </div>
    </div>
  );
}

function BackupProgress({
  job,
  controlling,
  onControl,
}: {
  job: BackupJob;
  controlling: boolean;
  onControl: (action: "pause" | "resume" | "cancel") => Promise<void>;
}) {
  const indeterminate = job.totalBytes === null;
  const percent = useMemo(() => {
    if (job.totalBytes === null) return null;
    if (job.totalBytes === 0) return 100;
    return Math.min(
      100,
      Math.round((job.processedBytes / job.totalBytes) * 100),
    );
  }, [job.processedBytes, job.totalBytes]);
  const terminal = ["completed", "failed", "cancelled"].includes(job.status);
  const statusLabel =
    job.status === "completed"
      ? "Backup zakończony pomyślnie"
      : job.status === "cancelled"
        ? "Backup został anulowany"
        : job.status === "failed"
          ? "Backup nie powiódł się"
          : job.status === "paused"
            ? "Backup wstrzymany między plikami"
            : job.pauseRequested
              ? "Pauza po bieżącym pliku…"
              : "Backup trwa w tle";

  return (
    <div
      className={`backup-progress backup-progress--${job.status}`}
      aria-live="polite"
    >
      <div className="backup-progress__heading">
        <div>
          <p className="section-label">ZADANIE {job.id.slice(0, 8)}</p>
          <h3>{statusLabel}</h3>
          {!terminal && <strong>{phaseLabels[job.phase]}</strong>}
        </div>
        {percent !== null && <span className="backup-percent">{percent}%</span>}
      </div>
      {!terminal && (
        <div
          className={`backup-progress__track${indeterminate ? " backup-progress__track--indeterminate" : ""}`}
          role="progressbar"
          aria-label={phaseLabels[job.phase]}
          aria-valuemin={indeterminate ? undefined : 0}
          aria-valuemax={indeterminate ? undefined : 100}
          aria-valuenow={percent ?? undefined}
        >
          <span
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
      {job.report ? (
        <div className="backup-report" aria-label="Raport końcowy">
          <Metric
            label="Skopiowane pliki"
            value={String(job.report.copiedFileCount)}
          />
          <Metric
            label="Niezmienione pliki"
            value={String(job.report.unchangedFileCount)}
          />
          <Metric
            label="Zarchiwizowane wersje"
            value={String(job.report.versionedFileCount)}
          />
          <Metric
            label="Skopiowane dane"
            value={formatBytes(job.report.copiedBytes)}
          />
        </div>
      ) : (
        <div className="backup-metrics">
          <Metric
            label="Pliki"
            value={`${job.processedFileCount}${job.totalFileCount === null ? "" : ` / ${job.totalFileCount}`}`}
          />
          <Metric
            label="Dane"
            value={`${formatBytes(job.processedBytes)}${job.totalBytes === null ? "" : ` / ${formatBytes(job.totalBytes)}`}`}
          />
          <Metric label="Faza" value={phaseLabels[job.phase]} />
        </div>
      )}
      {job.currentPath && (
        <p className="backup-current">Aktualnie: {job.currentPath}</p>
      )}
      {job.error && (
        <p className="backup-error" role="alert">
          {job.error}
        </p>
      )}
      {!terminal && (
        <div className="button-row backup-controls">
          {job.status === "paused" ? (
            <button
              type="button"
              className="secondary"
              disabled={controlling}
              onClick={() => void onControl("resume")}
            >
              Wznów
            </button>
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={controlling || job.pauseRequested}
              onClick={() => void onControl("pause")}
            >
              Pauza po bieżącym pliku
            </button>
          )}
          <button
            type="button"
            className="danger-quiet"
            disabled={controlling}
            onClick={() => void onControl("cancel")}
          >
            Anuluj backup
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replace(/[\\/]+$/, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} ${units[index]}`;
}

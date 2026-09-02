import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelBackupJob,
  inspectBackup,
  listBackupHistory,
  listBackupJobs,
  listBackupTargets,
  normalizeBackupError,
  openBackupDirectory,
  pauseBackupJob,
  prepareBackupPlan,
  recognizeBackupTarget,
  registerBackupTarget,
  resumeBackupJob,
  startBackupJob,
  type BackupJob,
  type BackupFileStatus,
  type BackupPhase,
  type BackupPlan,
  type BackupRun,
  type BackupSnapshot,
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
  const [snapshot, setSnapshot] = useState<BackupSnapshot | null>(null);
  const [history, setHistory] = useState<BackupRun[]>([]);
  const [auditing, setAuditing] = useState(false);
  const [auditRevision, setAuditRevision] = useState(0);

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
      if (!disposed) {
        setJob(event.payload);
        if (
          ["completed", "failed", "cancelled"].includes(event.payload.status)
        ) {
          setAuditRevision((value) => value + 1);
        }
      }
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
  const auditTargetId = selectedTarget?.id;
  const auditTargetPath = selectedVolume?.mountPath;

  useEffect(() => {
    if (!auditTargetId || !auditTargetPath || !libraryPath || active) {
      setSnapshot(null);
      setHistory([]);
      return;
    }
    let disposed = false;
    setAuditing(true);
    void Promise.all([
      inspectBackup(auditTargetId, auditTargetPath, libraryPath),
      listBackupHistory(auditTargetId, auditTargetPath),
    ])
      .then(([nextSnapshot, runs]) => {
        if (!disposed) {
          setSnapshot(nextSnapshot ?? null);
          setHistory(Array.isArray(runs) ? runs : []);
        }
      })
      .catch((reason) => {
        if (!disposed) setError(normalizeBackupError(reason).message);
      })
      .finally(() => {
        if (!disposed) setAuditing(false);
      });
    return () => {
      disposed = true;
    };
  }, [active, auditRevision, auditTargetId, auditTargetPath, libraryPath]);

  async function openBackup() {
    if (!selectedTarget || !selectedVolume) return;
    setError(null);
    try {
      await openBackupDirectory(selectedTarget.id, selectedVolume.mountPath);
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    }
  }

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

      {selectedTarget && (
        <BackupOverview
          snapshot={snapshot}
          history={history}
          connected={Boolean(selectedVolume)}
          auditing={auditing}
          onRefresh={() => setAuditRevision((value) => value + 1)}
          onOpen={openBackup}
        />
      )}

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

const backupStatusLabels: Record<BackupFileStatus, string> = {
  current: "Aktualny",
  new: "Nowy",
  changed: "Zmieniony",
  corrupt: "Uszkodzony",
  missingInBackup: "Brakujący w backupie",
  deletedFromLibrary: "Usunięty z biblioteki",
};

function BackupOverview({
  snapshot,
  history,
  connected,
  auditing,
  onRefresh,
  onOpen,
}: {
  snapshot: BackupSnapshot | null;
  history: BackupRun[];
  connected: boolean;
  auditing: boolean;
  onRefresh: () => void;
  onOpen: () => Promise<void>;
}) {
  const [status, setStatus] = useState<BackupFileStatus | "all">("all");
  const files = snapshot?.files ?? [];
  const visible =
    status === "all" ? files : files.filter((file) => file.status === status);
  const count = (value: BackupFileStatus) =>
    files.filter((file) => file.status === value).length;
  const orphanCount = count("deletedFromLibrary");
  const lastSuccessful =
    snapshot?.lastSuccessfulRun ??
    history.find((run) => run.outcome === "succeeded") ??
    null;

  return (
    <div className="backup-overview" aria-label="Stan kopii zapasowej">
      <div className="backup-section-heading">
        <div>
          <p className="section-label">ZGODNOŚĆ BIBLIOTEKI Z KOPIĄ</p>
          <h3>Stan backupu</h3>
          <p>
            {lastSuccessful
              ? `Ostatni udany backup: ${formatDate(lastSuccessful.finishedAtUnixMs ?? lastSuccessful.startedAtUnixMs)}`
              : "Brak ukończonego backupu"}
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={!connected || auditing}
            onClick={onRefresh}
          >
            {auditing ? "Sprawdzanie…" : "Sprawdź ponownie"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!connected}
            onClick={() => void onOpen()}
          >
            Otwórz katalog kopii
          </button>
        </div>
      </div>
      {orphanCount > 0 && (
        <div className="backup-orphan-warning" role="alert">
          <strong>
            {orphanCount}{" "}
            {orphanCount === 1
              ? "plik został usunięty"
              : "pliki zostały usunięte"}{" "}
            z biblioteki.
          </strong>
          <span>
            {" "}
            Nadal pozostają w backupie. Aplikacja nie usunie ich bez Twojej
            jawnej decyzji.
          </span>
        </div>
      )}
      {snapshot && (
        <>
          <div
            className="backup-status-filters"
            aria-label="Filtr stanu plików"
          >
            <StatusFilter
              label="Wszystkie"
              value="all"
              selected={status}
              count={files.length}
              onSelect={setStatus}
            />
            {(Object.keys(backupStatusLabels) as BackupFileStatus[]).map(
              (value) => (
                <StatusFilter
                  key={value}
                  label={backupStatusLabels[value]}
                  value={value}
                  selected={status}
                  count={count(value)}
                  onSelect={setStatus}
                />
              ),
            )}
          </div>
          <div className="backup-file-list">
            {visible.map((file) => (
              <details
                className={`backup-file backup-file--${file.status}`}
                key={file.relativePath}
              >
                <summary>
                  <span
                    className={`backup-status backup-status--${file.status}`}
                  >
                    {backupStatusLabels[file.status]}
                  </span>
                  <code>{file.relativePath}</code>
                  <small>
                    {formatBytes(file.sizeBytes)} · {file.versions.length}{" "}
                    starszych wersji
                  </small>
                </summary>
                <div className="backup-file__details">
                  <p>
                    Aktualna kopia:{" "}
                    <code>{file.backupSha256?.slice(0, 16) ?? "brak"}</code>
                  </p>
                  <p>
                    Oczekiwany skrót:{" "}
                    <code>
                      {file.expectedSha256?.slice(0, 16) ??
                        "jeszcze nie zapisano"}
                    </code>
                  </p>
                  {file.versions.length > 0 && (
                    <div>
                      <strong>
                        Poprzednie wersje (gotowe pod przyszłe przywracanie)
                      </strong>
                      <ul>
                        {file.versions.map((version) => (
                          <li key={version.id}>
                            <time>{formatDate(version.archivedAtUnixMs)}</time>{" "}
                            · <code>{version.versionPath}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            ))}
            {visible.length === 0 && (
              <p className="backup-empty">Brak plików o wybranym stanie.</p>
            )}
          </div>
        </>
      )}
      <BackupHistory history={history} />
    </div>
  );
}

function StatusFilter({
  label,
  value,
  selected,
  count,
  onSelect,
}: {
  label: string;
  value: BackupFileStatus | "all";
  selected: BackupFileStatus | "all";
  count: number;
  onSelect: (value: BackupFileStatus | "all") => void;
}) {
  return (
    <button
      type="button"
      className={selected === value ? "active" : ""}
      aria-pressed={selected === value}
      onClick={() => onSelect(value)}
    >
      {label} <strong>{count}</strong>
    </button>
  );
}

function BackupHistory({ history }: { history: BackupRun[] }) {
  return (
    <details className="backup-history">
      <summary>
        Historia uruchomień <strong>{history.length}</strong>
      </summary>
      {history.length === 0 ? (
        <p>Brak zapisanych uruchomień.</p>
      ) : (
        <ol>
          {history.map((run) => (
            <li key={run.id}>
              <span className={`backup-run backup-run--${run.outcome}`}>
                {run.outcome === "succeeded"
                  ? "Udany"
                  : run.outcome === "failed"
                    ? "Nieudany"
                    : run.outcome === "cancelled"
                      ? "Anulowany"
                      : "Uruchomiony"}
              </span>
              <div>
                <strong>
                  {formatDate(run.startedAtUnixMs)}
                  {run.finishedAtUnixMs
                    ? ` · ${formatDuration(run.finishedAtUnixMs - run.startedAtUnixMs)}`
                    : ""}
                </strong>
                <code>{run.sourceRoot}</code>
                {run.error && (
                  <span className="backup-run__error">{run.error}</span>
                )}
              </div>
              <small>
                {run.copiedFileCount} skopiowanych · {run.unchangedFileCount}{" "}
                aktualnych · {formatBytes(run.copiedBytes)}
              </small>
            </li>
          ))}
        </ol>
      )}
    </details>
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

function formatDate(unixMs: number): string {
  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(unixMs));
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} min ${remainder} s`;
}

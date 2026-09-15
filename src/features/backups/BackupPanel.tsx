import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelBackupJob,
  cancelBackupPlanningJob,
  inspectBackup,
  listBackupHistory,
  listBackupJobs,
  listBackupPlanningJobs,
  listBackupTargets,
  normalizeBackupError,
  openBackupDirectory,
  pauseBackupJob,
  recognizeBackupTarget,
  registerBackupTarget,
  removeBackupTarget,
  resumeBackupJob,
  startBackupJob,
  startBackupPlanningJob,
  type BackupJob,
  type BackupPlanningJob,
  type BackupFileStatus,
  type BackupPhase,
  type BackupPlan,
  type BackupRun,
  type BackupSnapshot,
  type BackupTarget,
} from "../../shared/backups";
import { loadSettings } from "../../shared/settings";
import { listMediaSources, type SourceVolume } from "../../shared/sources";
import { activeIntlLocale, localize as l } from "../../i18n";
import {
  operationRouteKey,
  type OperationRoute,
} from "../../shared/operations";

function phaseLabel(phase: BackupPhase): string {
  return {
    scanningLibrary: l("Scanning library", "Skanowanie biblioteki"),
    hashing: l("Calculating checksums", "Obliczanie skrótów"),
    copying: l("Copying", "Kopiowanie"),
    verifying: l("Verifying", "Weryfikacja"),
    finalizing: l("Finalizing", "Finalizacja"),
  }[phase];
}

type VolumeRefreshResult = {
  discovered: SourceVolume[];
  connected: BackupTarget[];
};

type BackupAuditContext = {
  key: string;
  targetId: string;
  snapshot: BackupSnapshot | null;
  history: BackupRun[];
  checkedAtUnixMs: number;
  stale: boolean;
};

type BackupOperationRoute = Extract<
  OperationRoute,
  { kind: "backup" | "backupPlanning" }
>;

export function BackupPanel({
  openOperationRoute = null,
  onClearOperationRoute,
}: {
  openOperationRoute?: BackupOperationRoute | null;
  onClearOperationRoute?: () => void;
} = {}) {
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [volumes, setVolumes] = useState<SourceVolume[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [routedOperationKey, setRoutedOperationKey] = useState<string | null>(
    null,
  );
  const [libraryPath, setLibraryPath] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [planningJobs, setPlanningJobs] = useState<BackupPlanningJob[]>([]);
  const [consumedPlanningJobIds, setConsumedPlanningJobIds] = useState<
    Set<string>
  >(new Set());
  const [loading, setLoading] = useState(true);
  const [controlling, setControlling] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [removingTargetId, setRemovingTargetId] = useState<string | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [newTargetPath, setNewTargetPath] = useState("");
  const [newTargetLabel, setNewTargetLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [auditContexts, setAuditContexts] = useState<
    Record<string, BackupAuditContext>
  >({});
  const [auditing, setAuditing] = useState(false);
  const [auditRevision, setAuditRevision] = useState(0);
  const [volumeRefreshError, setVolumeRefreshError] = useState<string | null>(
    null,
  );
  const [lastVolumeRefreshAt, setLastVolumeRefreshAt] = useState<number | null>(
    null,
  );
  const mountedRef = useRef(false);
  const volumeRefreshRevisionRef = useRef(0);
  const volumeRefreshInFlightRef = useRef<Promise<VolumeRefreshResult> | null>(
    null,
  );
  const openOperationRouteRef = useRef(openOperationRoute);
  const focusedOperationRouteRef = useRef<string | null>(null);
  openOperationRouteRef.current = openOperationRoute;

  const refreshVolumes = useCallback((): Promise<VolumeRefreshResult> => {
    const existing = volumeRefreshInFlightRef.current;
    if (existing) return existing;

    const revision = ++volumeRefreshRevisionRef.current;
    const refresh = (async () => {
      try {
        const discovered = await listMediaSources();
        const recognized = await Promise.all(
          discovered.map((volume) => recognizeBackupTarget(volume.mountPath)),
        );
        const connected = recognized.filter(
          (target): target is BackupTarget => target !== null,
        );
        if (
          mountedRef.current &&
          revision === volumeRefreshRevisionRef.current
        ) {
          setVolumes(discovered);
          setTargets((known) =>
            known.map(
              (target) =>
                connected.find((candidate) => candidate.id === target.id) ??
                target,
            ),
          );
          setVolumeRefreshError(null);
          setLastVolumeRefreshAt(Date.now());
        }
        return { discovered, connected };
      } catch (reason) {
        if (
          mountedRef.current &&
          revision === volumeRefreshRevisionRef.current
        ) {
          setVolumeRefreshError(normalizeBackupError(reason).message);
        }
        throw reason;
      }
    })();
    volumeRefreshInFlightRef.current = refresh;
    const clearInFlight = () => {
      if (volumeRefreshInFlightRef.current === refresh) {
        volumeRefreshInFlightRef.current = null;
      }
    };
    void refresh.then(clearInFlight, clearInFlight);
    return refresh;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      volumeRefreshRevisionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const volumeRefresh = refreshVolumes().catch(() => null);
    void Promise.all([
      Promise.all([
        listBackupTargets(),
        listBackupJobs(),
        listBackupPlanningJobs(),
        loadSettings(),
      ]),
      volumeRefresh,
    ])
      .then(([[knownTargets, jobs, planningJobs, settings], refreshResult]) => {
        if (disposed) return;
        const discovered = refreshResult?.discovered ?? [];
        const connected = refreshResult?.connected ?? [];
        const refreshedTargets = knownTargets.map(
          (target) =>
            connected.find((candidate) => candidate.id === target.id) ?? target,
        );
        const firstConnected = refreshedTargets.find((target) =>
          discovered.some((volume) =>
            samePath(volume.mountPath, target.lastKnownRoot),
          ),
        );
        setTargets(refreshedTargets);
        setVolumes(discovered);
        const restoredTargetId =
          firstConnected?.id ?? refreshedTargets[0]?.id ?? "";
        setSelectedTargetId(
          openOperationRouteRef.current?.targetId ?? restoredTargetId,
        );
        setLibraryPath(settings.settings.local.libraryPath);
        setJobs(jobs);
        setPlanningJobs(planningJobs);
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
  }, [refreshVolumes]);

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
        setJobs((current) => upsertJob(current, event.payload));
        if (["running", "paused"].includes(event.payload.status)) {
          setAuditContexts((current) => {
            let changed = false;
            const next = Object.fromEntries(
              Object.entries(current).map(([key, context]) => {
                if (context.targetId !== event.payload.targetId)
                  return [key, context];
                changed = true;
                return [key, { ...context, stale: true }];
              }),
            );
            return changed ? next : current;
          });
        }
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

  useEffect(() => {
    let disposed = false;
    const unlisten = listen<BackupPlanningJob>(
      "backup-planning-progress",
      (event) => {
        if (disposed) return;
        setPlanningJobs((current) => upsertJob(current, event.payload));
      },
    );
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  const selectedTarget = targets.find(
    (target) => target.id === selectedTargetId,
  );
  const routedBackupJob =
    routedOperationKey && openOperationRoute?.kind === "backup"
      ? jobs.find(
          (candidate) =>
            candidate.id === openOperationRoute.jobId &&
            candidate.targetId === openOperationRoute.targetId,
        )
      : undefined;
  const routedPlanningJob =
    routedOperationKey && openOperationRoute?.kind === "backupPlanning"
      ? planningJobs.find(
          (candidate) =>
            candidate.id === openOperationRoute.jobId &&
            candidate.targetId === openOperationRoute.targetId,
        )
      : undefined;
  const job = routedBackupJob ?? selectJobForTarget(jobs, selectedTargetId);
  const planningJob =
    routedPlanningJob ??
    selectPlanningJobForTarget(planningJobs, selectedTargetId);
  const plan =
    planningJob?.status === "completed" &&
    !consumedPlanningJobIds.has(planningJob.id)
      ? planningJob.plan
      : null;
  const selectedVolume = selectedTarget
    ? volumes.find((volume) =>
        samePath(volume.mountPath, selectedTarget.lastKnownRoot),
      )
    : undefined;
  const active = job?.status === "running" || job?.status === "paused";
  const planning = planningJob?.status === "running";
  const busy = active || planning;
  const insufficientSpace = Boolean(
    plan &&
    selectedVolume &&
    plan.totalCopyBytes > selectedVolume.availableBytes,
  );
  const auditTargetId = selectedTarget?.id;
  const auditTargetPath = selectedVolume?.mountPath;
  const auditKey =
    auditTargetId && auditTargetPath && libraryPath
      ? JSON.stringify([auditTargetId, auditTargetPath, libraryPath])
      : null;
  const visibleAudit = auditKey ? (auditContexts[auditKey] ?? null) : null;

  useEffect(() => {
    if (!openOperationRoute) {
      setRoutedOperationKey(null);
      return;
    }
    setSelectedTargetId(openOperationRoute.targetId);
    setRoutedOperationKey(operationRouteKey(openOperationRoute));
  }, [openOperationRoute]);

  useEffect(() => {
    if (!routedOperationKey) {
      focusedOperationRouteRef.current = null;
      return;
    }
    if (focusedOperationRouteRef.current === routedOperationKey) return;
    const element = document.getElementById(
      operationElementId(routedOperationKey),
    );
    if (!element) return;
    focusedOperationRouteRef.current = routedOperationKey;
    element.focus({ preventScroll: true });
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center" });
    }
  }, [jobs, planningJobs, routedOperationKey]);

  useEffect(() => {
    if (!auditKey || !auditTargetId || !auditTargetPath || !libraryPath || busy)
      return;
    let disposed = false;
    setAuditing(true);
    void Promise.all([
      inspectBackup(auditTargetId, auditTargetPath, libraryPath),
      listBackupHistory(auditTargetId, auditTargetPath),
    ])
      .then(([nextSnapshot, runs]) => {
        if (!disposed) {
          setAuditContexts((current) => ({
            ...current,
            [auditKey]: {
              key: auditKey,
              targetId: auditTargetId,
              snapshot: nextSnapshot ?? null,
              history: Array.isArray(runs) ? runs : [],
              checkedAtUnixMs: Date.now(),
              stale: false,
            },
          }));
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
  }, [
    auditKey,
    auditRevision,
    auditTargetId,
    auditTargetPath,
    busy,
    libraryPath,
  ]);

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
      await refreshVolumes();
      setRegistrationOpen(false);
      setNewTargetPath("");
      setNewTargetLabel("");
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    } finally {
      setRegistering(false);
    }
  }

  async function removeTarget(target: BackupTarget) {
    const targetHasActiveJob = jobs.some(
      (candidate) =>
        candidate.targetId === target.id &&
        (candidate.status === "running" || candidate.status === "paused"),
    );
    const targetHasActivePlanningJob = planningJobs.some(
      (candidate) =>
        candidate.targetId === target.id && candidate.status === "running",
    );
    if (targetHasActiveJob || targetHasActivePlanningJob) return;

    const confirmed = window.confirm(
      l(
        `Remove “${target.label}” from registered backup destinations? Only its registration and configuration will be removed. Backup files will remain on the drive.`,
        `Usunąć „${target.label}” z zarejestrowanych celów backupu? Usunięta zostanie tylko rejestracja i konfiguracja celu. Pliki backupu pozostaną na dysku.`,
      ),
    );
    if (!confirmed) return;

    setRemovingTargetId(target.id);
    setError(null);
    try {
      await removeBackupTarget(target.id);
      setTargets((current) => {
        const removedIndex = current.findIndex((item) => item.id === target.id);
        const remaining = current.filter((item) => item.id !== target.id);
        setSelectedTargetId((selected) => {
          if (selected !== target.id) return selected;
          return (
            remaining[Math.min(removedIndex, remaining.length - 1)]?.id ?? ""
          );
        });
        return remaining;
      });
      setJobs((current) =>
        current.filter((candidate) => candidate.targetId !== target.id),
      );
      setPlanningJobs((current) =>
        current.filter((candidate) => candidate.targetId !== target.id),
      );
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    } finally {
      setRemovingTargetId(null);
    }
  }

  async function preparePlan() {
    if (!selectedTarget || !selectedVolume || !libraryPath) return;
    setError(null);
    try {
      const started = await startBackupPlanningJob(
        selectedTarget.id,
        selectedVolume.mountPath,
        libraryPath,
      );
      setPlanningJobs((current) => upsertJob(current, started));
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
    }
  }

  async function cancelPlanning() {
    if (!planningJob || planningJob.status !== "running") return;
    setError(null);
    try {
      const updated = await cancelBackupPlanningJob(planningJob.id);
      setPlanningJobs((current) => upsertJob(current, updated));
    } catch (reason) {
      setError(normalizeBackupError(reason).message);
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
      const started = await startBackupJob(plan, selectedVolume.mountPath);
      setJobs((current) => upsertJob(current, started));
      setAuditContexts((current) => {
        if (!auditKey || !current[auditKey]) return current;
        return {
          ...current,
          [auditKey]: { ...current[auditKey], stale: true },
        };
      });
      if (planningJob) {
        setConsumedPlanningJobIds((current) =>
          new Set(current).add(planningJob.id),
        );
      }
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
      setJobs((current) => upsertJob(current, updated));
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
          <h2>
            {l(
              "A safe copy of your entire library.",
              "Bezpieczna kopia całej biblioteki.",
            )}
          </h2>
          <p>
            {l(
              "First, we'll inspect the contents and show you a plan. Copying will only begin after you approve it.",
              "Najpierw sprawdzimy zawartość i pokażemy plan. Kopiowanie rozpocznie się dopiero po Twoim zatwierdzeniu.",
            )}
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
          {l(
            "The backup drive was disconnected. Reconnect it; do not start a new job on another drive using the same letter.",
            "Dysk backupu został odłączony. Podłącz go ponownie; nie uruchamiaj nowego zadania na innym nośniku pod tą samą literą.",
          )}
        </div>
      )}

      <div className="backup-targets">
        <div className="backup-section-heading">
          <div>
            <h3>{l("Backup destinations", "Cele backupu")}</h3>
            <p>
              {l(
                "Known drives and their current connection status.",
                "Znane dyski i ich aktualny stan połączenia.",
              )}
            </p>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="danger-quiet"
              disabled={!selectedTarget || busy || removingTargetId !== null}
              onClick={() => {
                if (selectedTarget) void removeTarget(selectedTarget);
              }}
            >
              {removingTargetId === selectedTarget?.id
                ? l("Removing…", "Usuwanie…")
                : l("Remove destination", "Usuń cel")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || removingTargetId !== null}
              onClick={() => setRegistrationOpen((value) => !value)}
            >
              {l("Register a new drive", "Zarejestruj nowy dysk")}
            </button>
          </div>
        </div>

        <div className="backup-refresh-status" aria-live="polite">
          {lastVolumeRefreshAt !== null && (
            <p>
              {l(
                `Drives last refreshed successfully: ${formatDate(lastVolumeRefreshAt)}`,
                `Dyski ostatnio odświeżono pomyślnie: ${formatDate(lastVolumeRefreshAt)}`,
              )}
            </p>
          )}
          {volumeRefreshError && (
            <div className="notice notice--error" role="alert">
              {l(
                `Couldn't refresh connected drives. Showing results from the last successful refresh. ${volumeRefreshError}`,
                `Nie udało się odświeżyć podłączonych dysków. Pokazujemy wynik ostatniego udanego odświeżenia. ${volumeRefreshError}`,
              )}
            </div>
          )}
        </div>

        {registrationOpen && (
          <div className="backup-registration">
            <label className="field">
              <span>{l("Drive name", "Nazwa dysku")}</span>
              <input
                value={newTargetLabel}
                placeholder={l("e.g. Home archive", "np. Archiwum domowe")}
                onChange={(event) => setNewTargetLabel(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{l("Drive root folder", "Katalog główny dysku")}</span>
              <div className="path-control">
                <input
                  value={newTargetPath}
                  readOnly
                  placeholder={l(
                    "Choose a connected drive",
                    "Wybierz podłączony dysk",
                  )}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void chooseTargetDirectory()}
                >
                  {l("Choose…", "Wybierz…")}
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
              {registering
                ? l("Registering…", "Rejestrowanie…")
                : l("Register drive", "Zarejestruj dysk")}
            </button>
          </div>
        )}

        <div
          className="backup-target-list"
          role="radiogroup"
          aria-label={l("Backup destination", "Cel backupu")}
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
                  onChange={() => {
                    setRoutedOperationKey(null);
                    onClearOperationRoute?.();
                    setSelectedTargetId(target.id);
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
                    ? l(
                        `Connected · ${formatBytes(volume.availableBytes)} free`,
                        `Podłączony · wolne ${formatBytes(volume.availableBytes)}`,
                      )
                    : l("Disconnected", "Niepodłączony")}
                </small>
              </label>
            );
          })}
        </div>
        {!loading && targets.length === 0 && (
          <p className="backup-empty">
            {l(
              "You haven't registered a backup drive yet.",
              "Nie masz jeszcze zarejestrowanego dysku backupu.",
            )}
          </p>
        )}
      </div>

      {selectedTarget && (
        <BackupOverview
          snapshot={visibleAudit?.snapshot ?? null}
          history={visibleAudit?.history ?? []}
          checkedAtUnixMs={visibleAudit?.checkedAtUnixMs ?? null}
          stale={visibleAudit?.stale ?? false}
          connected={Boolean(selectedVolume)}
          auditing={auditing}
          onRefresh={() => setAuditRevision((value) => value + 1)}
          onOpen={openBackup}
        />
      )}

      {!active && (
        <div className="backup-planner">
          <div className="backup-source">
            <span>{l("Source library", "Biblioteka źródłowa")}</span>
            <code>
              {libraryPath ??
                l(
                  "Library folder is not configured",
                  "Nie skonfigurowano katalogu biblioteki",
                )}
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
            {planning
              ? l("Analyzing…", "Analizowanie…")
              : l("Prepare backup plan", "Przygotuj plan backupu")}
          </button>
          {selectedTarget && !selectedVolume && (
            <p className="backup-inline-warning" role="alert">
              {l(
                "Connect the selected drive to prepare a plan.",
                "Podłącz wybrany dysk, aby przygotować plan.",
              )}
            </p>
          )}
        </div>
      )}

      {planningJob && planningJob.status !== "completed" && (
        <BackupPlanningProgress
          job={planningJob}
          focused={routedOperationKey === `backupPlanning:${planningJob.id}`}
          onCancel={cancelPlanning}
        />
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
          focused={routedOperationKey === `backup:${job.id}`}
          controlling={controlling}
          onControl={control}
        />
      )}
    </section>
  );
}

function backupStatusLabel(status: BackupFileStatus): string {
  return {
    current: l("Current", "Aktualny"),
    new: l("New", "Nowy"),
    changed: l("Changed", "Zmieniony"),
    corrupt: l("Corrupted", "Uszkodzony"),
    missingInBackup: l("Missing from backup", "Brakujący w backupie"),
    deletedFromLibrary: l("Deleted from library", "Usunięty z biblioteki"),
  }[status];
}

function BackupOverview({
  snapshot,
  history,
  checkedAtUnixMs,
  stale,
  connected,
  auditing,
  onRefresh,
  onOpen,
}: {
  snapshot: BackupSnapshot | null;
  history: BackupRun[];
  checkedAtUnixMs: number | null;
  stale: boolean;
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
    <div
      className="backup-overview"
      aria-label={l("Backup status", "Stan kopii zapasowej")}
    >
      <div className="backup-section-heading">
        <div>
          <p className="section-label">
            {l("LIBRARY AND BACKUP CONSISTENCY", "ZGODNOŚĆ BIBLIOTEKI Z KOPIĄ")}
          </p>
          <h3>{l("Backup status", "Stan backupu")}</h3>
          <p>
            {lastSuccessful
              ? l(
                  `Last successful backup: ${formatDate(lastSuccessful.finishedAtUnixMs ?? lastSuccessful.startedAtUnixMs)}`,
                  `Ostatni udany backup: ${formatDate(lastSuccessful.finishedAtUnixMs ?? lastSuccessful.startedAtUnixMs)}`,
                )
              : l("No completed backup", "Brak ukończonego backupu")}
          </p>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={!connected || auditing}
            onClick={onRefresh}
          >
            {auditing
              ? l("Checking…", "Sprawdzanie…")
              : l("Check again", "Sprawdź ponownie")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!connected}
            onClick={() => void onOpen()}
          >
            {l("Open backup folder", "Otwórz katalog kopii")}
          </button>
        </div>
      </div>
      {stale && checkedAtUnixMs !== null && (
        <p className="backup-audit-stale" role="status">
          <strong>{l("Before this run", "Dane sprzed uruchomienia")}</strong>
          {" · "}
          {l(
            `last checked ${formatDate(checkedAtUnixMs)}. The snapshot and run history remain visible for reference and will be refreshed when the backup finishes.`,
            `ostatnio sprawdzone ${formatDate(checkedAtUnixMs)}. Snapshot i historia uruchomień pozostają widoczne jako punkt odniesienia i zostaną odświeżone po zakończeniu backupu.`,
          )}
        </p>
      )}
      {orphanCount > 0 && (
        <div className="backup-orphan-warning" role="alert">
          <strong>
            {orphanCount}{" "}
            {orphanCount === 1
              ? l("file was deleted", "plik został usunięty")
              : l("files were deleted", "pliki zostały usunięte")}{" "}
            {l("from the library.", "z biblioteki.")}
          </strong>
          <span>
            {" "}
            {l(
              "They remain in the backup. The application will not remove them without your explicit decision.",
              "Nadal pozostają w backupie. Aplikacja nie usunie ich bez Twojej jawnej decyzji.",
            )}
          </span>
        </div>
      )}
      {snapshot && (
        <>
          <div
            className="backup-status-filters"
            aria-label={l("File status filter", "Filtr stanu plików")}
          >
            <StatusFilter
              label={l("All", "Wszystkie")}
              value="all"
              selected={status}
              count={files.length}
              onSelect={setStatus}
            />
            {(
              [
                "current",
                "new",
                "changed",
                "corrupt",
                "missingInBackup",
                "deletedFromLibrary",
              ] as BackupFileStatus[]
            ).map((value) => (
              <StatusFilter
                key={value}
                label={backupStatusLabel(value)}
                value={value}
                selected={status}
                count={count(value)}
                onSelect={setStatus}
              />
            ))}
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
                    {backupStatusLabel(file.status)}
                  </span>
                  <code>{file.relativePath}</code>
                  <small>
                    {formatBytes(file.sizeBytes)} · {file.versions.length}{" "}
                    {l("older version(s)", "starszych wersji")}
                  </small>
                </summary>
                <div className="backup-file__details">
                  <p>
                    {l("Current copy", "Aktualna kopia")}:{" "}
                    <code>
                      {file.backupSha256?.slice(0, 16) ?? l("none", "brak")}
                    </code>
                  </p>
                  <p>
                    {l("Expected checksum", "Oczekiwany skrót")}:{" "}
                    <code>
                      {file.expectedSha256?.slice(0, 16) ??
                        l("not saved yet", "jeszcze nie zapisano")}
                    </code>
                  </p>
                  {file.versions.length > 0 && (
                    <div>
                      <strong>
                        {l(
                          "Previous versions — archived protection copies (restore planned; unavailable in this version)",
                          "Poprzednie wersje — zarchiwizowane kopie ochronne (przywracanie planowane; niedostępne w tej wersji)",
                        )}
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
              <p className="backup-empty">
                {l(
                  "No files with the selected status.",
                  "Brak plików o wybranym stanie.",
                )}
              </p>
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
        {l("Run history", "Historia uruchomień")}{" "}
        <strong>{history.length}</strong>
      </summary>
      {history.length === 0 ? (
        <p>{l("No saved runs.", "Brak zapisanych uruchomień.")}</p>
      ) : (
        <ol>
          {history.map((run) => (
            <li key={run.id}>
              <span className={`backup-run backup-run--${run.outcome}`}>
                {run.outcome === "succeeded"
                  ? l("Successful", "Udany")
                  : run.outcome === "failed"
                    ? l("Failed", "Nieudany")
                    : run.outcome === "cancelled"
                      ? l("Cancelled", "Anulowany")
                      : l("Started", "Uruchomiony")}
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
                {l(
                  `${run.copiedFileCount} copied · ${run.unchangedFileCount} current · ${formatBytes(run.copiedBytes)}`,
                  `${run.copiedFileCount} skopiowanych · ${run.unchangedFileCount} aktualnych · ${formatBytes(run.copiedBytes)}`,
                )}
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
    <div
      className="backup-plan"
      aria-label={l("Backup plan summary", "Podsumowanie planu backupu")}
    >
      <div className="backup-section-heading">
        <div>
          <p className="section-label">{l("PLAN READY", "PLAN GOTOWY")}</p>
          <h3>
            {l("Review and approve copying", "Sprawdź i zatwierdź kopiowanie")}
          </h3>
        </div>
      </div>
      <div className="backup-plan-grid">
        <Metric
          label={l("New files", "Nowe pliki")}
          value={String(count("new"))}
        />
        <Metric
          label={l("Changed files", "Zmienione pliki")}
          value={String(count("changed"))}
        />
        <Metric
          label={l("Files to repair", "Pliki do naprawy")}
          value={String(count("repair"))}
        />
        <Metric
          label={l("Unchanged files", "Niezmienione pliki")}
          value={String(plan.unchangedFileCount)}
        />
        <Metric
          label={l("Required space", "Wymagane miejsce")}
          value={formatBytes(plan.totalCopyBytes)}
        />
      </div>
      {insufficientSpace ? (
        <div className="backup-space-warning" role="alert">
          {l(
            `Not enough disk space. ${formatBytes(plan.totalCopyBytes)} is required; ${formatBytes(availableBytes)} is available.`,
            `Za mało miejsca na dysku. Potrzeba ${formatBytes(plan.totalCopyBytes)}, a dostępne jest ${formatBytes(availableBytes)}.`,
          )}
        </div>
      ) : (
        <p className="backup-space-ok">
          {l("Available space", "Dostępne miejsce")}:{" "}
          {formatBytes(availableBytes)}
        </p>
      )}
      <div className="backup-plan-actions">
        <p>
          {l(
            "Once approved, files will be copied and verified.",
            "Po zatwierdzeniu pliki zostaną skopiowane i zweryfikowane.",
          )}
        </p>
        <button
          type="button"
          disabled={insufficientSpace}
          onClick={() => void onStart()}
        >
          {l("Approve and start backup", "Zatwierdź i rozpocznij backup")}
        </button>
      </div>
    </div>
  );
}

function BackupPlanningProgress({
  job,
  focused,
  onCancel,
}: {
  job: BackupPlanningJob;
  focused: boolean;
  onCancel: () => Promise<void>;
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
  const running = job.status === "running";
  const statusLabel =
    job.status === "cancelled"
      ? l("Planning was cancelled", "Planowanie zostało anulowane")
      : job.status === "failed"
        ? l("Planning failed", "Planowanie nie powiodło się")
        : job.cancelRequested
          ? l("Cancelling planning…", "Anulowanie planowania…")
          : l("Preparing backup plan", "Przygotowywanie planu backupu");

  return (
    <div
      id={operationElementId(`backupPlanning:${job.id}`)}
      className={`backup-progress backup-progress--${job.status}${focused ? " operation-focus" : ""}`}
      tabIndex={-1}
      aria-live="polite"
    >
      <div className="backup-progress__heading">
        <div>
          <p className="section-label">
            {l("PLANNING", "PLANOWANIE")} {job.id.slice(0, 8)}
          </p>
          <h3>{statusLabel}</h3>
          {running && <strong>{phaseLabel(job.phase)}</strong>}
        </div>
        {running && percent !== null && (
          <span className="backup-percent">{percent}%</span>
        )}
      </div>
      {running && (
        <div
          className={`backup-progress__track${indeterminate ? " backup-progress__track--indeterminate" : ""}`}
          role="progressbar"
          aria-label={phaseLabel(job.phase)}
          aria-valuemin={indeterminate ? undefined : 0}
          aria-valuemax={indeterminate ? undefined : 100}
          aria-valuenow={percent ?? undefined}
        >
          <span
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
      <div className="backup-metrics">
        <Metric
          label={l("Files", "Pliki")}
          value={`${job.processedFileCount}${job.totalFileCount === null ? "" : ` / ${job.totalFileCount}`}`}
        />
        <Metric
          label={l("Data", "Dane")}
          value={`${formatBytes(job.processedBytes)}${job.totalBytes === null ? "" : ` / ${formatBytes(job.totalBytes)}`}`}
        />
        <Metric label={l("Phase", "Faza")} value={phaseLabel(job.phase)} />
      </div>
      {job.currentPath && (
        <p className="backup-current">
          {l("Current", "Aktualnie")}: {job.currentPath}
        </p>
      )}
      {job.error && (
        <p className="backup-error" role="alert">
          {job.error}
        </p>
      )}
      {running && (
        <div className="button-row backup-controls">
          <button
            type="button"
            className="danger-quiet"
            disabled={job.cancelRequested}
            onClick={() => void onCancel()}
          >
            {job.cancelRequested
              ? l("Cancelling…", "Anulowanie…")
              : l("Cancel planning", "Anuluj planowanie")}
          </button>
        </div>
      )}
    </div>
  );
}

function BackupProgress({
  job,
  focused,
  controlling,
  onControl,
}: {
  job: BackupJob;
  focused: boolean;
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
      ? l("Backup completed successfully", "Backup zakończony pomyślnie")
      : job.status === "cancelled"
        ? l("Backup was cancelled", "Backup został anulowany")
        : job.status === "failed"
          ? l("Backup failed", "Backup nie powiódł się")
          : job.status === "paused"
            ? l(
                "Backup paused between files",
                "Backup wstrzymany między plikami",
              )
            : job.pauseRequested
              ? l("Pausing after the current file…", "Pauza po bieżącym pliku…")
              : l("Backup is running in the background", "Backup trwa w tle");

  return (
    <div
      id={operationElementId(`backup:${job.id}`)}
      className={`backup-progress backup-progress--${job.status}${focused ? " operation-focus" : ""}`}
      tabIndex={-1}
      aria-live="polite"
    >
      <div className="backup-progress__heading">
        <div>
          <p className="section-label">
            {l("JOB", "ZADANIE")} {job.id.slice(0, 8)}
          </p>
          <h3>{statusLabel}</h3>
          {!terminal && <strong>{phaseLabel(job.phase)}</strong>}
        </div>
        {percent !== null && <span className="backup-percent">{percent}%</span>}
      </div>
      {!terminal && (
        <div
          className={`backup-progress__track${indeterminate ? " backup-progress__track--indeterminate" : ""}`}
          role="progressbar"
          aria-label={phaseLabel(job.phase)}
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
        <div
          className="backup-report"
          aria-label={l("Final report", "Raport końcowy")}
        >
          <Metric
            label={l("Copied files", "Skopiowane pliki")}
            value={String(job.report.copiedFileCount)}
          />
          <Metric
            label={l("Unchanged files", "Niezmienione pliki")}
            value={String(job.report.unchangedFileCount)}
          />
          <Metric
            label={l("Archived versions", "Zarchiwizowane wersje")}
            value={String(job.report.versionedFileCount)}
          />
          <Metric
            label={l("Copied data", "Skopiowane dane")}
            value={formatBytes(job.report.copiedBytes)}
          />
        </div>
      ) : (
        <div className="backup-metrics">
          <Metric
            label={l("Files", "Pliki")}
            value={`${job.processedFileCount}${job.totalFileCount === null ? "" : ` / ${job.totalFileCount}`}`}
          />
          <Metric
            label={l("Data", "Dane")}
            value={`${formatBytes(job.processedBytes)}${job.totalBytes === null ? "" : ` / ${formatBytes(job.totalBytes)}`}`}
          />
          <Metric label={l("Phase", "Faza")} value={phaseLabel(job.phase)} />
        </div>
      )}
      {job.currentPath && (
        <p className="backup-current">
          {l("Current", "Aktualnie")}: {job.currentPath}
        </p>
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
              {l("Resume", "Wznów")}
            </button>
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={controlling || job.pauseRequested}
              onClick={() => void onControl("pause")}
            >
              {l("Pause after the current file", "Pauza po bieżącym pliku")}
            </button>
          )}
          <button
            type="button"
            className="danger-quiet"
            disabled={controlling}
            onClick={() => void onControl("cancel")}
          >
            {l("Cancel backup", "Anuluj backup")}
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

function operationElementId(key: string) {
  return `operation-${encodeURIComponent(key)}`;
}

function upsertJob<
  T extends { id: string; status: string; updatedAtUnixMs: number },
>(jobs: T[], incoming: T): T[] {
  const index = jobs.findIndex((job) => job.id === incoming.id);
  if (index < 0) return [...jobs, incoming];
  const current = jobs[index];
  if (
    current.updatedAtUnixMs > incoming.updatedAtUnixMs ||
    (current.updatedAtUnixMs === incoming.updatedAtUnixMs &&
      isTerminalStatus(current.status) &&
      !isTerminalStatus(incoming.status))
  ) {
    return jobs;
  }
  const next = [...jobs];
  next[index] = incoming;
  return next;
}

function selectJobForTarget(
  jobs: BackupJob[],
  targetId: string,
): BackupJob | null {
  return selectTargetJob(jobs, targetId, (job) =>
    ["running", "paused"].includes(job.status),
  );
}

function selectPlanningJobForTarget(
  jobs: BackupPlanningJob[],
  targetId: string,
): BackupPlanningJob | null {
  return selectTargetJob(jobs, targetId, (job) => job.status === "running");
}

function selectTargetJob<
  T extends {
    id: string;
    targetId: string;
    startedAtUnixMs: number;
    updatedAtUnixMs: number;
  },
>(jobs: T[], targetId: string, isActive: (job: T) => boolean): T | null {
  return (
    jobs
      .filter((job) => job.targetId === targetId)
      .sort((left, right) => {
        const activeOrder = Number(isActive(right)) - Number(isActive(left));
        if (activeOrder !== 0) return activeOrder;
        const startedOrder = right.startedAtUnixMs - left.startedAtUnixMs;
        if (startedOrder !== 0) return startedOrder;
        const updatedOrder = right.updatedAtUnixMs - left.updatedAtUnixMs;
        if (updatedOrder !== 0) return updatedOrder;
        return right.id.localeCompare(left.id);
      })[0] ?? null
  );
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
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
  return `${value.toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 })} ${units[index]}`;
}

function formatDate(unixMs: number): string {
  return new Intl.DateTimeFormat(activeIntlLocale(), {
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

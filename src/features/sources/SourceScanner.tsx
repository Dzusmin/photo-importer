import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  loadSettings,
  normalizeSettingsError,
  saveSettings,
  type AppSettings,
} from "../../shared/settings";
import { acknowledgePendingSource } from "../../shared/background";
import {
  buildImportPlanPreview,
  announceImportPlanReady,
  deletePendingSourceWorkflow,
  cancelMediaScan,
  cancelImportSession,
  correctCaptureTimes,
  correctionToSeconds,
  displayFileName,
  ensureMediaSourceMarker,
  formatBytes,
  listMediaSources,
  listImportSessions,
  listPendingSourceWorkflows,
  listMediaScans,
  pauseImportSession,
  startMediaScan,
  startImportSession,
  savePendingSourceWorkflow,
  createImportSession,
  retryImportRollback,
  type SourceScanResponse,
  type SourceVolume,
  type ImportPlan,
  type ImportSession,
  type MediaItem,
  type MediaScanJob,
  type CameraIdentity,
  type PendingSourceWorkflow,
} from "../../shared/sources";

interface CameraProfileDraft {
  key: string;
  identity: CameraIdentity;
  profileId: string;
  name: string;
  itemCount: number;
}
import { requestThumbnail } from "../../shared/thumbnailManager";

export function SourceScanner() {
  const [sources, setSources] = useState<SourceVolume[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<MediaScanJob | null>(null);
  const [scanResult, setScanResult] = useState<SourceScanResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState(false);
  const [profileDrafts, setProfileDrafts] = useState<
    CameraProfileDraft[] | null
  >(null);
  const [itemProfileAssignments, setItemProfileAssignments] = useState<
    Record<string, string>
  >({});
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [correctionValue, setCorrectionValue] = useState(0);
  const [correctionUnit, setCorrectionUnit] = useState<
    "seconds" | "minutes" | "hours"
  >("minutes");
  const [resultFilter, setResultFilter] = useState<"all" | "new">("all");
  const [excludedImportKeys, setExcludedImportKeys] = useState<Set<string>>(
    new Set(),
  );
  const [eventNames, setEventNames] = useState<Record<number, string>>({});
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [importSession, setImportSession] = useState<ImportSession | null>(
    null,
  );
  const [importActionPending, setImportActionPending] = useState(false);
  const [writeSourceMarker, setWriteSourceMarker] = useState(true);
  const [pendingWorkflows, setPendingWorkflows] = useState<
    PendingSourceWorkflow[]
  >([]);
  const autoPlannedRoot = useRef<string | null>(null);
  const cameraSources = useMemo(
    () => sources.filter((source) => source.likelyCameraSource),
    [sources],
  );

  useEffect(() => {
    void loadSettings()
      .then((response) => setSettings(response.settings))
      .catch((error) => setMessage(normalizeSettingsError(error).message));
  }, []);

  useEffect(() => {
    const unlisten = listen<{ sourcePath: string | null }>(
      "notification-route",
      (event) => {
        const workflow = pendingWorkflows.find(
          (candidate) =>
            event.payload.sourcePath === null ||
            candidate.sourceRoot === event.payload.sourcePath,
        );
        if (workflow) openWorkflow(workflow);
      },
    );
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [pendingWorkflows]);

  useEffect(() => {
    const unlisten = listen<string>("request-source-scan", (event) => {
      void runScan(event.payload, "Skanowanie karty oczekującej na decyzję…");
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let active = true;
    void listPendingSourceWorkflows()
      .then((workflows) => {
        if (active) {
          const restored = workflows ?? [];
          setPendingWorkflows(restored);
          const pending = restored.find((workflow) => workflow.scan !== null);
          if (pending) openWorkflow(pending);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const unlisten = listen<PendingSourceWorkflow>(
      "source-workflow-changed",
      (event) => {
        if (!active) return;
        setPendingWorkflows((current) => [
          event.payload,
          ...current.filter(
            (workflow) => workflow.sourceRoot !== event.payload.sourceRoot,
          ),
        ]);
        if (event.payload.scan) openWorkflow(event.payload);
      },
    );
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!scanResult || !settings || profileDrafts !== null) return;
    const source = sources.find(
      (candidate) => candidate.mountPath === scanResult.scan.root,
    );
    if (!source || profileFor(source)) {
      setProfileDrafts([]);
      return;
    }
    const grouped = new Map<
      string,
      { identity: CameraIdentity; itemCount: number }
    >();
    for (const item of scanResult.scan.items) {
      if (!item.cameraIdentity || item.cameraMetadataConflict) continue;
      const key = cameraIdentityKey(item.cameraIdentity);
      const current = grouped.get(key);
      if (current) current.itemCount += 1;
      else grouped.set(key, { identity: item.cameraIdentity, itemCount: 1 });
    }
    setProfileDrafts(
      [...grouped.entries()].map(([key, group]) => {
        const matched = profileForIdentity(settings, group.identity);
        return {
          key,
          identity: group.identity,
          profileId: matched?.id ?? "new",
          name:
            matched?.name ??
            ([group.identity.make, group.identity.model]
              .filter(Boolean)
              .join(" ") ||
              "Nowy aparat"),
          itemCount: group.itemCount,
        };
      }),
    );
  }, [profileDrafts, scanResult, settings, sources]);

  useEffect(() => {
    if (!scanResult || !settings) return;
    setItemProfileAssignments((current) => {
      const next = { ...current };
      for (const item of scanResult.scan.items) {
        if (next[item.key]) continue;
        next[item.key] =
          profileForIdentity(settings, item.cameraIdentity)?.id ?? "unknown";
      }
      return next;
    });
  }, [scanResult, settings]);

  useEffect(() => {
    if (!scanResult || !settings || profileDrafts?.length !== 0 || importPlan)
      return;
    const source = sources.find(
      (candidate) => candidate.mountPath === scanResult.scan.root,
    );
    const binding = source ? bindingForSource(settings, source) : undefined;
    if (
      binding?.behavior === "autoPreparePlan" &&
      autoPlannedRoot.current !== scanResult.scan.root
    ) {
      autoPlannedRoot.current = scanResult.scan.root;
      void prepareImportPlan(true);
    }
  }, [profileDrafts, importPlan, scanResult, settings, sources]);

  useEffect(() => {
    let active = true;
    void listMediaScans()
      .then((jobs) => {
        const running = jobs.find((job) => job.status === "running");
        if (active && running) {
          setScanJob(running);
          setScanningPath(running.path);
          setMessage("Skan uruchomiony przez automat działa w tle…");
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const unlisten = listen<MediaScanJob>("scan-progress", (event) => {
      if (!active) return;
      const job = event.payload;
      setScanJob(job);
      if (job.status === "completed" && job.result) {
        applyCompletedScan(job.result);
        setScanningPath(null);
      } else if (job.status === "failed") {
        setMessage(job.error ?? "Skanowanie nie powiodło się.");
        setScanningPath(null);
      } else if (job.status === "cancelled") {
        setMessage("Skanowanie zostało anulowane.");
        setScanningPath(null);
      }
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let active = true;
    void listImportSessions()
      .then((sessions) => {
        const unfinished = sessions.find((session) =>
          [
            "planned",
            "queued",
            "running",
            "paused",
            "failed",
            "failedRecoverable",
            "rollingBack",
            "rollbackFailed",
          ].includes(session.status),
        );
        if (active && unfinished) setImportSession(unfinished);
      })
      .catch(() => undefined);
    const unlisten = listen<ImportSession>("import-progress", (event) => {
      if (active) setImportSession(event.payload);
    });
    const unlistenRollback = listen<ImportSession>(
      "rollback-progress",
      (event) => {
        if (active) setImportSession(event.payload);
      },
    );
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
      void unlistenRollback.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const discovered = await listMediaSources();
        if (active) {
          setSources(discovered);
          setDiscoveryError(false);
        }
      } catch {
        if (active) setDiscoveryError(true);
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function runScan(path: string, initialMessage?: string) {
    setScanningPath(path);
    setScanResult(null);
    setProfileDrafts(null);
    setWriteSourceMarker(true);
    setItemProfileAssignments({});
    autoPlannedRoot.current = null;
    setSelectedKeys(new Set());
    setMessage(initialMessage ?? "Skanowanie źródła…");
    try {
      const job = await startMediaScan(path);
      setScanJob(job);
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
      setScanningPath(null);
    }
  }

  function applyCompletedScan(result: SourceScanResponse) {
    setScanResult(result);
    setEventNames(defaultEventNames(result.events));
    setExcludedImportKeys(
      new Set(
        result.importMatches
          .filter((match) => match.state === "imported")
          .map((match) => match.itemKey),
      ),
    );
    setImportPlan(null);
    setMessage(
      result.scan.items.length === 0
        ? "Nie znaleziono obsługiwanych zdjęć ani filmów."
        : `Skanowanie zakończone: ${result.scan.items.length} pozycji w ${result.events.length} wydarzeniach.`,
    );
  }

  function openWorkflow(workflow: PendingSourceWorkflow) {
    if (!workflow.scan) return;
    const settingsChanged =
      settings !== null &&
      workflow.settingsRevision !== "" &&
      workflow.settingsRevision !== JSON.stringify(settings.portable.naming);
    setScanResult(workflow.scan);
    setEventNames({
      ...defaultEventNames(workflow.scan.events),
      ...workflow.editor.eventNames,
    });
    setExcludedImportKeys(new Set(workflow.editor.excludedItemKeys));
    setItemProfileAssignments(workflow.editor.itemProfileAssignments);
    setImportPlan(settingsChanged ? null : workflow.plan);
    setProfileDrafts(
      workflow.state === "awaitingProfileConfirmation" ? null : [],
    );
    setMessage(
      settingsChanged
        ? "Ustawienia nazewnictwa zmieniły się — przelicz plan ponownie."
        : workflow.state === "planReady"
          ? "Przywrócono plan oczekujący na zatwierdzenie."
          : (workflow.error ?? "Przywrócono stan karty wymagającej uwagi."),
    );
  }

  function invalidatePlan(result: SourceScanResponse | null = scanResult) {
    setImportPlan(null);
    if (!result) return;
    const source = sources.find(
      (candidate) => candidate.mountPath === result.scan.root,
    );
    void savePendingSourceWorkflow({
      sourceRoot: result.scan.root,
      sourceId: source?.markerUuid ?? source?.fingerprint ?? result.scan.root,
      sourceIdentity: source
        ? {
            markerUuid: source.markerUuid,
            platformVolumeId: source.platformVolumeId,
            fallbackFingerprint: source.fingerprint,
          }
        : null,
      displayName: source?.name ?? displayFileName(result.scan.root),
      state: "preparingPlan",
      scan: result,
      plan: null,
      settingsSchemaVersion: settings?.schemaVersion ?? 0,
      settingsRevision: settings
        ? JSON.stringify(settings.portable.naming)
        : "",
      editor: {
        eventNames,
        excludedItemKeys: [...excludedImportKeys],
        itemProfileAssignments,
      },
      updatedAtUnixMs: Date.now(),
      error: null,
    });
  }

  async function confirmDetectedProfiles() {
    if (!settings || !scanResult || profileDrafts === null) return;
    const source = sources.find(
      (candidate) => candidate.mountPath === scanResult.scan.root,
    );
    if (!source) return;
    const cameraProfiles = [...settings.portable.cameraProfiles];
    const selectedIds: string[] = [];
    for (const draft of profileDrafts) {
      if (draft.profileId === "unknown") continue;
      if (draft.profileId === "new") {
        const id = crypto.randomUUID();
        cameraProfiles.push({
          id,
          name: draft.name.trim() || "Nowy aparat",
          exifMatchers: [draft.identity],
          defaultTimeOffsetSeconds: 0,
        });
        selectedIds.push(id);
      } else {
        selectedIds.push(draft.profileId);
      }
    }
    const markerUuid =
      source.readOnly || !writeSourceMarker
        ? null
        : await ensureMediaSourceMarker(source.mountPath).catch(() => null);
    const binding = {
      id: crypto.randomUUID(),
      sourceIdentity: {
        markerUuid,
        platformVolumeId: source.platformVolumeId,
        fallbackFingerprint: source.fingerprint,
      },
      displayName: source.name.trim() || source.mountPath,
      behavior: settings.portable.import.defaultSourceBehavior,
      cameraProfileIds: [...new Set(selectedIds)],
      markerState: source.readOnly
        ? ("readOnly" as const)
        : !writeSourceMarker
          ? ("unknown" as const)
          : markerUuid
            ? ("written" as const)
            : ("writeFailed" as const),
      lastSeenAtUnixMs: Date.now(),
    };
    try {
      const response = await saveSettings({
        ...settings,
        portable: { ...settings.portable, cameraProfiles },
        local: {
          ...settings.local,
          sourceBindings: [
            ...settings.local.sourceBindings.filter(
              (item) => !bindingMatchesExactly(item, source),
            ),
            binding,
          ],
        },
      });
      setSettings(response.settings);
      setSources((current) =>
        current.map((candidate) =>
          candidate.mountPath === source.mountPath
            ? { ...candidate, markerUuid }
            : candidate,
        ),
      );
      setItemProfileAssignments(
        Object.fromEntries(
          scanResult.scan.items.map((item) => [
            item.key,
            profileForIdentity(response.settings, item.cameraIdentity)?.id ??
              "unknown",
          ]),
        ),
      );
      await acknowledgePendingSource(source.mountPath).catch(() => undefined);
      setProfileDrafts([]);
      setMessage("Profile aparatów i karta zostały zatwierdzone.");
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    }
  }

  async function cancelScan() {
    if (!scanJob || scanJob.status !== "running") return;
    try {
      await cancelMediaScan(scanJob.id);
      setMessage("Anulowanie po bieżącym pliku…");
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    }
  }

  async function applyCorrection() {
    if (!scanResult || selectedKeys.size === 0) return;
    setScanningPath(scanResult.scan.root);
    try {
      const response = await correctCaptureTimes(
        scanResult.scan.items,
        [...selectedKeys],
        correctionToSeconds(correctionValue, correctionUnit),
      );
      const correctedResult = {
        ...scanResult,
        scan: { ...scanResult.scan, items: response.items },
        events: response.events,
      };
      setScanResult(correctedResult);
      setEventNames((current) => ({
        ...defaultEventNames(response.events),
        ...current,
      }));
      invalidatePlan(correctedResult);
      setMessage(
        `Skorygowano czas ${response.changedItemCount} pozycji i ponownie pogrupowano wydarzenia.`,
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setScanningPath(null);
    }
  }

  async function chooseDirectory() {
    const directory = await open({
      directory: true,
      multiple: false,
      title: "Wybierz kartę, katalog lub udział sieciowy do skanowania",
    });
    if (directory) await runScan(directory);
  }

  function profileFor(source: SourceVolume) {
    const binding = settings ? bindingForSource(settings, source) : undefined;
    return settings?.portable.cameraProfiles.find((profile) =>
      binding?.cameraProfileIds.includes(profile.id),
    );
  }

  async function prepareImportPlan(automatic = false) {
    if (!scanResult || !settings) return;
    if (profileDrafts && profileDrafts.length > 0) {
      setMessage("Najpierw zatwierdź profile aparatów znalezione na karcie.");
      return;
    }
    setPlanning(true);
    setImportPlan(null);
    try {
      const importedSourcePaths = scanResult.importMatches.flatMap(
        (match) => match.importedSourcePaths,
      );
      const source = sources.find(
        (candidate) => candidate.mountPath === scanResult.scan.root,
      );
      const profile = source ? profileFor(source) : undefined;
      const itemContexts = Object.fromEntries(
        scanResult.scan.items.map((item) => {
          const assignedProfile = settings.portable.cameraProfiles.find(
            (profile) => profile.id === itemProfileAssignments[item.key],
          );
          const itemProfile =
            assignedProfile ??
            profileForIdentity(settings, item.cameraIdentity);
          return [
            item.key,
            {
              cameraMake: item.cameraIdentity?.make ?? null,
              cameraModel: item.cameraIdentity?.model ?? null,
              cameraAlias: itemProfile?.name ?? "Nieznany aparat",
              sourceAlias:
                source?.name.trim() ||
                displayFileName(scanResult.scan.root) ||
                null,
            },
          ];
        }),
      );
      const plan = await buildImportPlanPreview({
        events: scanResult.events.map((event) => ({
          event,
          name: eventNames[event.index] ?? `wydarzenie-${event.index}`,
        })),
        excludedItemKeys: [...excludedImportKeys],
        excludedSourcePaths: importedSourcePaths,
        context: {
          cameraMake: null,
          cameraModel: null,
          cameraAlias: profile?.name ?? null,
          sourceAlias:
            source?.name.trim() ||
            displayFileName(scanResult.scan.root) ||
            null,
        },
        itemContexts,
      });
      setImportPlan(plan);
      if (plan.status !== "empty") {
        const workflow: PendingSourceWorkflow = {
          sourceId:
            source?.markerUuid ?? source?.fingerprint ?? scanResult.scan.root,
          sourceRoot: scanResult.scan.root,
          sourceIdentity: source
            ? {
                markerUuid: source.markerUuid,
                platformVolumeId: source.platformVolumeId,
                fallbackFingerprint: source.fingerprint,
              }
            : null,
          displayName: source?.name ?? displayFileName(scanResult.scan.root),
          state: "planReady",
          scan: scanResult,
          plan,
          settingsSchemaVersion: settings.schemaVersion,
          settingsRevision: JSON.stringify(settings.portable.naming),
          editor: {
            eventNames,
            excludedItemKeys: [...excludedImportKeys],
            itemProfileAssignments,
          },
          error: null,
          updatedAtUnixMs: Date.now(),
        };
        await savePendingSourceWorkflow(workflow);
        setPendingWorkflows((current) => [
          workflow,
          ...current.filter(
            (candidate) => candidate.sourceRoot !== workflow.sourceRoot,
          ),
        ]);
      }
      if (automatic && plan.status !== "empty") {
        await announceImportPlanReady(plan.fileCount).catch(() => undefined);
      }
      setMessage(
        plan.status === "requiresDecision"
          ? `Plan zawiera ${plan.conflicts.length} kolizji wymagających decyzji.`
          : plan.status === "empty"
            ? "Plan jest pusty — wszystkie pozycje są wykluczone lub już zaimportowane."
            : `Plan gotowy: ${plan.fileCount} plików w ${plan.events.length} folderach.`,
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function beginImport() {
    if (!importPlan || !settings) return;
    const moving =
      settings.portable.import.defaultOperation === "moveAfterVerification";
    const confirmMove =
      !moving ||
      window.confirm(
        "Po zweryfikowaniu całych zestawów aplikacja usunie pliki źródłowe. Czy na pewno rozpocząć przenoszenie?",
      );
    if (!confirmMove) return;
    setImportActionPending(true);
    try {
      const source = sources.find(
        (candidate) => candidate.mountPath === scanResult?.scan.root,
      );
      const session = await createImportSession(
        importPlan,
        source?.fingerprint ?? null,
        source
          ? {
              markerUuid: source.markerUuid,
              platformVolumeId: source.platformVolumeId,
              fallbackFingerprint: source.fingerprint,
            }
          : null,
        confirmMove,
      );
      setImportSession(session);
      if (scanResult) {
        await deletePendingSourceWorkflow(scanResult.scan.root).catch(
          () => undefined,
        );
        setPendingWorkflows((current) =>
          current.filter(
            (workflow) => workflow.sourceRoot !== scanResult.scan.root,
          ),
        );
      }
      await startImportSession(session.id);
      setMessage("Import został rozpoczęty.");
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setImportActionPending(false);
    }
  }

  async function controlImport(action: "resume" | "pause" | "cancel") {
    if (!importSession) return;
    setImportActionPending(true);
    try {
      let cancelMode: "keepCompleted" | "rollbackSession" = "keepCompleted";
      if (action === "cancel") {
        if (!window.confirm("Czy na pewno przerwać tę sesję importu?")) return;
        cancelMode = window.confirm(
          "Czy usunąć niezmienione pliki dodane przez tę sesję? Wybierz Anuluj, aby zachować ukończone pliki.",
        )
          ? "rollbackSession"
          : "keepCompleted";
      }
      const session =
        action === "resume"
          ? await startImportSession(
              importSession.id,
              sources.find((source) =>
                sourceMatchesSession(source, importSession),
              )?.mountPath ?? null,
            )
          : action === "pause"
            ? await pauseImportSession(importSession.id)
            : await cancelImportSession(importSession.id, cancelMode);
      setImportSession(session);
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setImportActionPending(false);
    }
  }

  async function retryRollback() {
    if (!importSession) return;
    setImportActionPending(true);
    try {
      setImportSession(await retryImportRollback(importSession.id));
      setMessage("Ponowiono bezpieczne wycofanie sesji.");
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setImportActionPending(false);
    }
  }

  return (
    <>
      <section className="source-hero">
        <div>
          <p className="section-label">ŹRÓDŁA MEDIÓW</p>
          <h2>
            {cameraSources.length > 0
              ? "Wykryto nośnik aparatu."
              : "Czekam na kartę pamięci."}
          </h2>
          <p>
            Lista odświeża się co 5 sekund. Możesz też przeskanować dowolny
            katalog lub zamontowany udział sieciowy.
          </p>
          <button
            type="button"
            onClick={() => void chooseDirectory()}
            disabled={scanningPath !== null}
          >
            Wybierz katalog ręcznie
          </button>
          {message && (
            <p className="scan-message" role="status">
              {message}
            </p>
          )}
        </div>
        <div className="source-hero__status">
          <span className="source-count">{cameraSources.length}</span>
          <strong>prawdopodobnych źródeł aparatu</strong>
          <span>
            {discoveryError
              ? "Nie udało się odświeżyć listy"
              : "Monitor aktywny"}
          </span>
        </div>
      </section>

      {pendingWorkflows.length > 0 && (
        <section className="source-list" aria-label="Trwałe zadania kart">
          {pendingWorkflows.map((workflow) => (
            <article className="source-card" key={workflow.sourceId}>
              <div className="source-card__icon" aria-hidden="true">
                SD
              </div>
              <div className="source-card__details">
                <div className="source-card__title">
                  <h3>{workflow.displayName || workflow.sourceRoot}</h3>
                  <span className="known-badge">
                    {workflowStateLabel(workflow.state)}
                  </span>
                </div>
                <p>{workflow.sourceRoot}</p>
                {workflow.plan && (
                  <small>
                    {workflow.plan.fileCount} plików ·{" "}
                    {formatBytes(workflow.plan.totalSizeBytes)}
                  </small>
                )}
                {workflow.error && <small>{workflow.error}</small>}
              </div>
              {workflow.scan && (
                <button type="button" onClick={() => openWorkflow(workflow)}>
                  {workflow.state === "planReady" ? "Otwórz plan" : "Otwórz"}
                </button>
              )}
            </article>
          ))}
        </section>
      )}

      {scanJob?.status === "running" && (
        <ScanProgressPanel job={scanJob} onCancel={() => void cancelScan()} />
      )}

      {cameraSources.length > 0 && (
        <section className="source-list" aria-label="Wykryte nośniki">
          {cameraSources.map((source) => {
            const profile = profileFor(source);
            return (
              <article
                className="source-card"
                key={`${source.fingerprint}-${source.mountPath}`}
              >
                <div className="source-card__icon" aria-hidden="true">
                  SD
                </div>
                <div className="source-card__details">
                  <div className="source-card__title">
                    <h3>{sourceName(source)}</h3>
                    {profile && (
                      <span className="known-badge">{profile.name}</span>
                    )}
                  </div>
                  <p>
                    {source.mountPath} ·{" "}
                    {source.fileSystem || "nieznany system"} ·{" "}
                    {formatBytes(source.totalBytes)}
                  </p>
                  <div className="source-flags">
                    {source.removable && <span>wymienny</span>}
                    {source.containsDcim && <span>DCIM</span>}
                    {source.readOnly && <span>tylko odczyt</span>}
                  </div>
                  {!profile && (
                    <small>
                      Skan rozpozna aparat z EXIF przed zapamiętaniem karty.
                    </small>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void runScan(source.mountPath)}
                  disabled={scanningPath !== null}
                >
                  {scanningPath === source.mountPath ? "Skanowanie…" : "Skanuj"}
                </button>
              </article>
            );
          })}
        </section>
      )}

      {scanResult && (
        <>
          {profileDrafts && profileDrafts.length > 0 && settings && (
            <CameraProfileConfirmation
              drafts={profileDrafts}
              profiles={settings.portable.cameraProfiles}
              onChange={setProfileDrafts}
              onConfirm={() => void confirmDetectedProfiles()}
              writeMarker={writeSourceMarker}
              markerDisabled={
                sources.find(
                  (source) => source.mountPath === scanResult.scan.root,
                )?.readOnly ?? false
              }
              onWriteMarkerChange={setWriteSourceMarker}
            />
          )}
          <ScanResults
            result={scanResult}
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            correctionValue={correctionValue}
            onCorrectionValueChange={setCorrectionValue}
            correctionUnit={correctionUnit}
            onCorrectionUnitChange={setCorrectionUnit}
            onApplyCorrection={() => void applyCorrection()}
            busy={scanningPath !== null}
            filter={resultFilter}
            onFilterChange={setResultFilter}
            excludedImportKeys={excludedImportKeys}
            onExcludedImportKeysChange={(keys) => {
              setExcludedImportKeys(keys);
              invalidatePlan();
            }}
            eventNames={eventNames}
            onEventNameChange={(index, name) => {
              setEventNames((current) => ({ ...current, [index]: name }));
              invalidatePlan();
            }}
            importPlan={importPlan}
            planning={planning}
            onPrepareImportPlan={() => void prepareImportPlan(false)}
            importSession={importSession}
            importActionPending={importActionPending}
            onBeginImport={() => void beginImport()}
            onControlImport={(action) => void controlImport(action)}
            onRetryRollback={() => void retryRollback()}
            cameraProfiles={settings?.portable.cameraProfiles ?? []}
            itemProfileAssignments={itemProfileAssignments}
            onItemProfileAssignment={(key, profileId) => {
              setItemProfileAssignments((current) => ({
                ...current,
                [key]: profileId,
              }));
              invalidatePlan();
            }}
          />
        </>
      )}
    </>
  );
}

function CameraProfileConfirmation({
  drafts,
  profiles,
  onChange,
  onConfirm,
  writeMarker,
  markerDisabled,
  onWriteMarkerChange,
}: {
  drafts: CameraProfileDraft[];
  profiles: AppSettings["portable"]["cameraProfiles"];
  onChange: (drafts: CameraProfileDraft[]) => void;
  onConfirm: () => void;
  writeMarker: boolean;
  markerDisabled: boolean;
  onWriteMarkerChange: (value: boolean) => void;
}) {
  function update(key: string, patch: Partial<CameraProfileDraft>) {
    onChange(
      drafts.map((draft) =>
        draft.key === key ? { ...draft, ...patch } : draft,
      ),
    );
  }
  return (
    <section className="profile-confirmation" aria-live="polite">
      <span className="section-label">ROZPOZNANE APARATY</span>
      <h3>Zatwierdź profile przed przygotowaniem planu</h3>
      <p>
        Karta zostanie zapamiętana dopiero po tej decyzji. Możesz utworzyć nowy
        profil, użyć istniejącego albo pozostawić materiały jako nieznane.
      </p>
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={writeMarker && !markerDisabled}
          disabled={markerDisabled}
          onChange={(event) => onWriteMarkerChange(event.target.checked)}
        />
        <span>
          Zapisz na karcie prywatny identyfikator ułatwiający bezpieczne
          rozpoznanie po zmianie litery dysku
        </span>
      </label>
      {drafts.map((draft) => (
        <div className="profile-confirmation__row" key={draft.key}>
          <div>
            <strong>
              {[draft.identity.make, draft.identity.model]
                .filter(Boolean)
                .join(" ") || "Nieznany aparat"}
            </strong>
            <small>
              {draft.itemCount} pozycji
              {draft.identity.serialNumber
                ? ` · nr ${draft.identity.serialNumber}`
                : " · brak numeru seryjnego"}
            </small>
          </div>
          <select
            aria-label="Przypisanie profilu aparatu"
            value={draft.profileId}
            onChange={(event) =>
              update(draft.key, { profileId: event.target.value })
            }
          >
            <option value="new">Utwórz nowy profil</option>
            {profiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name}
              </option>
            ))}
            <option value="unknown">Pozostaw jako nieznany</option>
          </select>
          {draft.profileId === "new" && (
            <input
              aria-label="Nazwa nowego profilu"
              value={draft.name}
              onChange={(event) =>
                update(draft.key, { name: event.target.value })
              }
            />
          )}
        </div>
      ))}
      <button type="button" onClick={onConfirm}>
        Zatwierdź profile i zapamiętaj kartę
      </button>
    </section>
  );
}

function ScanResults({
  result,
  selectedKeys,
  onSelectionChange,
  correctionValue,
  onCorrectionValueChange,
  correctionUnit,
  onCorrectionUnitChange,
  onApplyCorrection,
  busy,
  filter,
  onFilterChange,
  excludedImportKeys,
  onExcludedImportKeysChange,
  eventNames,
  onEventNameChange,
  importPlan,
  planning,
  onPrepareImportPlan,
  importSession,
  importActionPending,
  onBeginImport,
  onControlImport,
  onRetryRollback,
  cameraProfiles,
  itemProfileAssignments,
  onItemProfileAssignment,
}: {
  result: SourceScanResponse;
  selectedKeys: Set<string>;
  onSelectionChange: (keys: Set<string>) => void;
  correctionValue: number;
  onCorrectionValueChange: (value: number) => void;
  correctionUnit: "seconds" | "minutes" | "hours";
  onCorrectionUnitChange: (unit: "seconds" | "minutes" | "hours") => void;
  onApplyCorrection: () => void;
  busy: boolean;
  filter: "all" | "new";
  onFilterChange: (filter: "all" | "new") => void;
  excludedImportKeys: Set<string>;
  onExcludedImportKeysChange: (keys: Set<string>) => void;
  eventNames: Record<number, string>;
  onEventNameChange: (index: number, name: string) => void;
  importPlan: ImportPlan | null;
  planning: boolean;
  onPrepareImportPlan: () => void;
  importSession: ImportSession | null;
  importActionPending: boolean;
  onBeginImport: () => void;
  onControlImport: (action: "resume" | "pause" | "cancel") => void;
  onRetryRollback: () => void;
  cameraProfiles: AppSettings["portable"]["cameraProfiles"];
  itemProfileAssignments: Record<string, string>;
  onItemProfileAssignment: (key: string, profileId: string) => void;
}) {
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const matches = new Map(
    result.importMatches.map((match) => [match.itemKey, match]),
  );
  const importedCount = result.importMatches.filter(
    (match) => match.state === "imported",
  ).length;
  const visibleEvents = result.events
    .map((event) => ({
      ...event,
      items: event.items.filter(
        (item) =>
          filter === "all" || matches.get(item.key)?.state !== "imported",
      ),
    }))
    .filter((event) => event.items.length > 0);
  const visibleItems = visibleEvents.flatMap((event) => event.items);
  const previewIndex = visibleItems.findIndex(
    (item) => item.key === previewKey,
  );

  function toggleItem(key: string) {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  function toggleImportItem(key: string) {
    const next = new Set(excludedImportKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onExcludedImportKeysChange(next);
  }

  function setEventIncluded(
    event: (typeof result.events)[number],
    included: boolean,
  ) {
    const next = new Set(excludedImportKeys);
    for (const item of event.items) {
      if (matches.get(item.key)?.state === "imported") continue;
      if (included) next.delete(item.key);
      else next.add(item.key);
    }
    onExcludedImportKeysChange(next);
  }

  return (
    <section className="scan-results">
      <div className="scan-summary">
        <div>
          <span>Pozycje</span>
          <strong>{result.scan.items.length}</strong>
        </div>
        <div>
          <span>Pliki</span>
          <strong>{result.scan.supportedFileCount}</strong>
        </div>
        <div>
          <span>Rozmiar</span>
          <strong>{formatBytes(result.scan.totalSizeBytes)}</strong>
        </div>
        <div>
          <span>Wydarzenia</span>
          <strong>{result.events.length}</strong>
        </div>
        <div>
          <span>Zaimportowane</span>
          <strong>{importedCount}</strong>
        </div>
      </div>
      <p className="timestamp-note">
        Czas pochodzi z EXIF lub metadanych filmu; dla brakujących danych
        używany jest czas modyfikacji. Przerwa wydarzenia:{" "}
        {result.eventGapMinutes} min.
      </p>
      <div className="scan-tools">
        <div className="result-filter" role="group" aria-label="Filtr wyników">
          <button
            type="button"
            className={filter === "all" ? "active" : "ghost"}
            onClick={() => onFilterChange("all")}
          >
            Wszystkie
          </button>
          <button
            type="button"
            className={filter === "new" ? "active" : "ghost"}
            onClick={() => onFilterChange("new")}
          >
            Tylko nowe
          </button>
        </div>
        <div className="time-correction">
          <strong>{selectedKeys.size} zaznaczonych</strong>
          <input
            aria-label="Wartość korekty czasu"
            type="number"
            value={correctionValue}
            onChange={(event) =>
              onCorrectionValueChange(Number(event.target.value))
            }
          />
          <select
            aria-label="Jednostka korekty czasu"
            value={correctionUnit}
            onChange={(event) =>
              onCorrectionUnitChange(
                event.target.value as typeof correctionUnit,
              )
            }
          >
            <option value="seconds">sekundy</option>
            <option value="minutes">minuty</option>
            <option value="hours">godziny</option>
          </select>
          <button
            type="button"
            onClick={onApplyCorrection}
            disabled={busy || selectedKeys.size === 0}
          >
            Zastosuj korektę
          </button>
          {selectedKeys.size > 0 && (
            <button
              type="button"
              className="ghost"
              onClick={() => onSelectionChange(new Set())}
            >
              Wyczyść
            </button>
          )}
        </div>
      </div>
      <div className="event-list">
        {visibleEvents.map((event) => (
          <article className="event-card" key={event.index}>
            <div className="event-card__heading">
              <div className="event-card__identity">
                <span>WYDARZENIE {event.index}</span>
                <h3>{formatTimestamp(event.startsAtUnixMs)}</h3>
                <label className="event-name-field">
                  <span>Nazwa folderu</span>
                  <input
                    value={eventNames[event.index] ?? ""}
                    onChange={(change) =>
                      onEventNameChange(event.index, change.target.value)
                    }
                  />
                </label>
              </div>
              <div className="event-card__actions">
                <strong>
                  {event.items.length} pozycji ·{" "}
                  {formatBytes(event.totalSizeBytes)}
                </strong>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    const next = new Set(selectedKeys);
                    for (const item of event.items) next.add(item.key);
                    onSelectionChange(next);
                  }}
                >
                  Zaznacz wydarzenie
                </button>
                <label className="event-import-toggle">
                  <input
                    type="checkbox"
                    checked={event.items.some(
                      (item) =>
                        matches.get(item.key)?.state !== "imported" &&
                        !excludedImportKeys.has(item.key),
                    )}
                    onChange={(change) =>
                      setEventIncluded(event, change.target.checked)
                    }
                  />
                  uwzględnij w imporcie
                </label>
              </div>
            </div>
            <div className="media-strip">
              {event.items.map((item) => {
                const importMatch = matches.get(item.key);
                return (
                  <div
                    className={`media-tile ${selectedKeys.has(item.key) ? "media-tile--selected" : ""} ${excludedImportKeys.has(item.key) ? "media-tile--excluded" : ""} ${importMatch?.state === "imported" ? "media-tile--imported" : ""}`}
                    key={item.key}
                    role="button"
                    tabIndex={0}
                    onClick={() => setPreviewKey(item.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        setPreviewKey(item.key);
                      }
                    }}
                    title={item.files
                      .map((file) => file.relativePath)
                      .join("\n")}
                  >
                    <MediaThumbnail item={item} maxDimension={320} />
                    <input
                      aria-label="Zaznacz do korekty czasu"
                      type="checkbox"
                      checked={selectedKeys.has(item.key)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleItem(item.key)}
                    />
                    <span className="media-tile__type">
                      {item.files.find((file) => file.kind !== "xmp")?.kind ??
                        "xmp"}
                    </span>
                    <strong>
                      {displayFileName(item.files[0]?.relativePath ?? item.key)}
                    </strong>
                    <small>
                      {item.hasRawJpegPair
                        ? "RAW+JPEG"
                        : `${item.files.length} plik`}
                      {item.hasSidecar ? " + XMP" : ""}
                    </small>
                    <select
                      aria-label="Profil aparatu dla pozycji"
                      value={itemProfileAssignments[item.key] ?? "unknown"}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        onItemProfileAssignment(item.key, event.target.value)
                      }
                    >
                      <option value="unknown">Nieznany aparat</option>
                      {cameraProfiles.map((profile) => (
                        <option value={profile.id} key={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      {timeSourceLabel(item.timeSource)}
                      {item.timeCorrectionSeconds !== 0
                        ? ` · korekta ${item.timeCorrectionSeconds}s`
                        : ""}
                    </small>
                    <small>
                      {item.cameraMetadataConflict
                        ? "sprzeczne dane aparatu"
                        : item.cameraIdentity
                          ? [
                              item.cameraIdentity.make,
                              item.cameraIdentity.model,
                            ]
                              .filter(Boolean)
                              .join(" ")
                          : "Nieznany aparat"}
                    </small>
                    {importMatch?.state !== "new" && (
                      <span className="import-state">
                        {importMatch?.state === "imported"
                          ? "już importowane"
                          : "częściowo importowane"}
                      </span>
                    )}
                    <button
                      type="button"
                      className="plan-toggle"
                      disabled={importMatch?.state === "imported"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleImportItem(item.key);
                      }}
                    >
                      {importMatch?.state === "imported"
                        ? "pominięte"
                        : excludedImportKeys.has(item.key)
                          ? "dodaj do planu"
                          : "pomiń w planie"}
                    </button>
                  </div>
                );
              })}
            </div>
          </article>
        ))}
      </div>
      {previewIndex >= 0 && (
        <FullMediaPreview
          item={visibleItems[previewIndex]}
          position={previewIndex + 1}
          total={visibleItems.length}
          onClose={() => setPreviewKey(null)}
          onPrevious={() =>
            setPreviewKey(visibleItems[Math.max(0, previewIndex - 1)].key)
          }
          onNext={() =>
            setPreviewKey(
              visibleItems[Math.min(visibleItems.length - 1, previewIndex + 1)]
                .key,
            )
          }
        />
      )}
      <section className="import-planner">
        <div className="import-planner__heading">
          <div>
            <span className="section-label">PLAN IMPORTU</span>
            <h3>Sprawdź ścieżki przed kopiowaniem</h3>
            <p>
              Ten krok tylko oblicza wynik. Nie tworzy folderów i nie kopiuje
              żadnych plików.
            </p>
          </div>
          <button
            type="button"
            onClick={onPrepareImportPlan}
            disabled={planning || busy}
          >
            {planning
              ? "Przygotowywanie…"
              : importPlan
                ? "Odśwież plan"
                : "Przygotuj plan"}
          </button>
        </div>
        {importPlan && (
          <ImportPlanPreview
            plan={importPlan}
            onBeginImport={onBeginImport}
            actionPending={importActionPending}
            sessionActive={
              importSession !== null &&
              !["completed", "cancelled"].includes(importSession.status)
            }
          />
        )}
        {importSession && (
          <ImportSessionProgress
            session={importSession}
            actionPending={importActionPending}
            onControl={onControlImport}
            onRetryRollback={onRetryRollback}
          />
        )}
      </section>
      {result.scan.warnings.length > 0 && (
        <details className="scan-warnings">
          <summary>{result.scan.warnings.length} ostrzeżeń skanowania</summary>
          {result.scan.warnings.map((warning) => (
            <p key={`${warning.path}-${warning.message}`}>
              {warning.path}: {warning.message}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}

function ScanProgressPanel({
  job,
  onCancel,
}: {
  job: MediaScanJob;
  onCancel: () => void;
}) {
  const determinate =
    job.totalSupportedFileCount !== null && job.totalSupportedFileCount > 0;
  const percentage = determinate
    ? Math.min(
        100,
        (job.processedFileCount / (job.totalSupportedFileCount ?? 1)) * 100,
      )
    : 0;
  return (
    <section className="scan-progress-panel" aria-live="polite">
      <div>
        <span className="section-label">SKANOWANIE</span>
        <h3>{scanPhaseLabel(job.phase)}</h3>
        <p>
          {job.phase === "discovering"
            ? `${job.discoveredFileCount} znalezionych plików`
            : `${job.processedFileCount} z ${job.totalSupportedFileCount ?? "?"} obsługiwanych plików`}
          {job.currentPath ? ` · ${displayFileName(job.currentPath)}` : ""}
        </p>
        <small>
          {job.phase === "comparingHistory"
            ? `${formatBytes(job.historyBytesRead)} odczytano · ${job.historyCacheHitCount} z cache · ${job.fullyHashedFileCount} pełnych odczytów`
            : "Duże karty i pliki RAW mogą wymagać kilku minut. Możesz chwilę poczekać albo anulować skanowanie."}
        </small>
      </div>
      <div
        className={`scan-progress-track ${determinate ? "" : "scan-progress-track--indeterminate"}`}
        aria-label={
          determinate
            ? `Postęp ${percentage.toFixed(0)}%`
            : "Wyszukiwanie plików"
        }
      >
        <span style={determinate ? { width: `${percentage}%` } : undefined} />
      </div>
      <button type="button" className="ghost" onClick={onCancel}>
        Anuluj skanowanie
      </button>
    </section>
  );
}

function MediaThumbnail({
  item,
  maxDimension,
  eager = false,
  rotation = 0,
  scale = 1,
}: {
  item: MediaItem;
  maxDimension: number;
  eager?: boolean;
  rotation?: number;
  scale?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const source = previewSource(item);

  useEffect(() => {
    if (
      eager ||
      !container.current ||
      typeof IntersectionObserver === "undefined"
    ) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    if (
      !visible ||
      !source ||
      source.kind === "video" ||
      source.kind === "xmp"
    ) {
      return;
    }
    const controller = new AbortController();
    setFailed(false);
    void requestThumbnail(source.path, maxDimension, {
      priority: eager ? "preview" : "visible",
      signal: controller.signal,
    })
      .then((thumbnail) => {
        setUrl(thumbnail.url);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [eager, maxDimension, source, visible]);

  return (
    <div className="media-thumbnail" ref={container}>
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ transform: `rotate(${rotation}deg) scale(${scale})` }}
        />
      ) : (
        <span>
          {failed
            ? "brak podglądu"
            : source?.kind === "video"
              ? "WIDEO"
              : "ładowanie…"}
        </span>
      )}
    </div>
  );
}

function FullMediaPreview({
  item,
  position,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  item: MediaItem;
  position: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    setRotation(0);
    setScale(1);
  }, [item.key]);
  return (
    <div
      className="preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Podgląd zdjęcia"
    >
      <div className="preview-dialog">
        <div className="preview-toolbar">
          <strong>
            {position} / {total}
          </strong>
          <div>
            <button
              type="button"
              className="ghost"
              onClick={() => setScale((value) => Math.min(3, value + 0.25))}
            >
              Powiększ
            </button>
            <button type="button" className="ghost" onClick={() => setScale(1)}>
              Dopasuj
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setRotation((value) => (value + 90) % 360)}
            >
              Obróć widok
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Zamknij
            </button>
          </div>
        </div>
        <MediaThumbnail
          item={item}
          maxDimension={1_600}
          eager
          rotation={rotation}
          scale={scale}
        />
        <div className="preview-details">
          <h3>{displayFileName(item.files[0]?.relativePath ?? item.key)}</h3>
          <p>
            {formatTimestamp(item.capturedAtUnixMs)} ·{" "}
            {timeSourceLabel(item.timeSource)}
          </p>
          <p>
            {formatBytes(item.totalSizeBytes)} ·{" "}
            {item.files.map((file) => file.kind.toUpperCase()).join(" + ")}
          </p>
          {item.files.map((file) => (
            <code key={file.path}>{file.relativePath}</code>
          ))}
        </div>
        <div className="preview-navigation">
          <button
            type="button"
            className="ghost"
            disabled={position <= 1}
            onClick={onPrevious}
          >
            Poprzednie
          </button>
          <button
            type="button"
            className="ghost"
            disabled={position >= total}
            onClick={onNext}
          >
            Następne
          </button>
        </div>
      </div>
    </div>
  );
}

function previewSource(item: MediaItem) {
  return (
    item.files.find((file) => file.kind === "jpeg") ??
    item.files.find((file) => file.kind === "heic") ??
    item.files.find((file) => file.kind === "raw") ??
    item.files.find((file) => file.kind === "video") ??
    item.files[0]
  );
}

function scanPhaseLabel(phase: MediaScanJob["phase"]) {
  if (phase === "discovering") return "Wyszukiwanie zdjęć i filmów";
  if (phase === "readingMetadata") return "Odczytywanie metadanych";
  if (phase === "comparingHistory") return "Porównywanie z historią importu";
  if (phase === "groupingEvents") return "Składanie wydarzeń";
  return "Skanowanie zakończone";
}

function ImportPlanPreview({
  plan,
  onBeginImport,
  actionPending,
  sessionActive,
}: {
  plan: ImportPlan;
  onBeginImport: () => void;
  actionPending: boolean;
  sessionActive: boolean;
}) {
  const cameraSections = new Map<
    string,
    Array<{
      event: ImportPlan["events"][number];
      items: ImportPlan["events"][number]["items"];
    }>
  >();
  for (const event of plan.events) {
    const aliases = new Set(
      event.items.map((item) => item.cameraAlias ?? "Nieznany aparat"),
    );
    for (const alias of aliases) {
      const sections = cameraSections.get(alias) ?? [];
      sections.push({
        event,
        items: event.items.filter(
          (item) => (item.cameraAlias ?? "Nieznany aparat") === alias,
        ),
      });
      cameraSections.set(alias, sections);
    }
  }
  return (
    <div className="plan-preview">
      <div className="plan-summary">
        <div>
          <span>Status</span>
          <strong>
            {plan.status === "ready"
              ? "gotowy"
              : plan.status === "empty"
                ? "pusty"
                : "wymaga decyzji"}
          </strong>
        </div>
        <div>
          <span>Pozycje / pliki</span>
          <strong>
            {plan.itemCount} / {plan.fileCount}
          </strong>
        </div>
        <div>
          <span>Do skopiowania</span>
          <strong>{formatBytes(plan.totalSizeBytes)}</strong>
        </div>
        <div>
          <span>Pominięte</span>
          <strong>
            {plan.excludedItemCount} pozycji · {plan.excludedFileCount} plików
          </strong>
        </div>
      </div>
      <p className="plan-library">
        Biblioteka: <code>{plan.libraryRoot}</code>
      </p>
      {plan.conflicts.length > 0 && (
        <div className="plan-conflicts" role="alert">
          <strong>{plan.conflicts.length} kolizji</strong>
          <p>
            Import pozostanie zatrzymany. Pomiń wskazane pozycje albo wybierz w
            ustawieniach automatyczne dodawanie numeru i odśwież plan.
          </p>
          {plan.conflicts.map((conflict) => (
            <p key={`${conflict.itemKey}-${conflict.destinationPath}`}>
              {conflict.kind === "destinationExists"
                ? "Plik już istnieje"
                : "Dwie pozycje wskazują tę samą ścieżkę"}
              : <code>{conflict.destinationPath}</code>
            </p>
          ))}
        </div>
      )}
      <div className="planned-events">
        {[...cameraSections.entries()].map(([camera, sections]) => (
          <section className="planned-camera" key={camera}>
            <h4>{camera}</h4>
            {sections.map(({ event, items }) => (
              <details
                key={`${event.eventIndex}-${event.folderRelativePath}`}
                open={plan.events.length <= 3}
              >
                <summary>
                  <span>{event.eventName}</span>
                  <code>{event.folderRelativePath}</code>
                  <small>
                    {items.length} pozycji ·{" "}
                    {formatBytes(
                      items.reduce((sum, item) => sum + item.totalSizeBytes, 0),
                    )}
                  </small>
                </summary>
                <div className="planned-files">
                  {items.flatMap((item) =>
                    item.files.map((file) => (
                      <div
                        className="planned-file"
                        key={`${item.itemKey}-${file.sourcePath}`}
                      >
                        <span>{displayFileName(file.sourceRelativePath)}</span>
                        <span aria-hidden="true">→</span>
                        <code>{file.destinationRelativePath}</code>
                      </div>
                    )),
                  )}
                </div>
              </details>
            ))}
          </section>
        ))}
      </div>
      <div className="plan-start">
        <button
          type="button"
          onClick={onBeginImport}
          disabled={plan.status !== "ready" || actionPending || sessionActive}
        >
          {actionPending ? "Uruchamianie…" : "Rozpocznij import"}
        </button>
      </div>
    </div>
  );
}

function ImportSessionProgress({
  session,
  actionPending,
  onControl,
  onRetryRollback,
}: {
  session: ImportSession;
  actionPending: boolean;
  onControl: (action: "resume" | "pause" | "cancel") => void;
  onRetryRollback: () => void;
}) {
  const percentage =
    session.totalSizeBytes === 0
      ? 0
      : Math.min(
          100,
          (session.completedSizeBytes / session.totalSizeBytes) * 100,
        );
  const current = session.operations.find((operation) =>
    ["copying", "verifying", "failed", "pending"].includes(operation.status),
  );
  const elapsedSeconds = Math.max(
    0,
    (session.updatedAtUnixMs - session.createdAtUnixMs) / 1000,
  );
  const bytesPerSecond =
    elapsedSeconds > 0 ? session.completedSizeBytes / elapsedSeconds : 0;
  const remainingSeconds =
    bytesPerSecond > 0
      ? (session.totalSizeBytes - session.completedSizeBytes) / bytesPerSecond
      : 0;
  return (
    <section className="import-progress-panel" aria-live="polite">
      <div className="import-progress-panel__heading">
        <div>
          <span className="section-label">SESJA IMPORTU</span>
          <h3>{sessionStatusLabel(session.status)}</h3>
        </div>
        <strong>
          {session.completedItemCount}/{session.itemCount} zestawów ·{" "}
          {session.completedFileCount}/{session.fileCount} plików
        </strong>
      </div>
      <div
        className="progress-track"
        aria-label={`Postęp ${percentage.toFixed(0)}%`}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <p>
        {formatBytes(session.completedSizeBytes)} z{" "}
        {formatBytes(session.totalSizeBytes)}
        {current ? ` · ${displayFileName(current.sourcePath)}` : ""}
      </p>
      {bytesPerSecond > 0 && session.status === "running" && (
        <p>
          Średnio {formatBytes(bytesPerSecond)}/s · około{" "}
          {formatDuration(remainingSeconds)} do końca
        </p>
      )}
      {session.lastError && <p className="import-error">{session.lastError}</p>}
      <div className="import-controls">
        {session.status === "running" && (
          <button
            type="button"
            className="ghost"
            disabled={actionPending || session.pauseRequested}
            onClick={() => onControl("pause")}
          >
            {session.pauseRequested
              ? "Zatrzymywanie po bieżącym zestawie…"
              : "Pauza po bieżącym zestawie"}
          </button>
        )}
        {["planned", "paused", "failed", "failedRecoverable"].includes(
          session.status,
        ) && (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onControl("resume")}
          >
            {session.status === "failed" ? "Ponów" : "Wznów"}
          </button>
        )}
        {session.status === "rollbackFailed" && (
          <button
            type="button"
            disabled={actionPending}
            onClick={onRetryRollback}
          >
            Ponów wycofanie
          </button>
        )}
        {!(["completed", "cancelled"] as string[]).includes(session.status) && (
          <button
            type="button"
            className="danger-quiet"
            disabled={actionPending || session.cancelRequested}
            onClick={() => onControl("cancel")}
          >
            {session.cancelRequested ? "Anulowanie…" : "Anuluj"}
          </button>
        )}
      </div>
    </section>
  );
}

function sessionStatusLabel(status: ImportSession["status"]) {
  if (status === "planned") return "Gotowy do uruchomienia";
  if (status === "queued") return "Import oczekuje w kolejce";
  if (status === "running") return "Kopiowanie i weryfikacja";
  if (status === "paused") return "Import wstrzymany";
  if (status === "completed") return "Import zakończony";
  if (status === "failed") return "Import zatrzymany przez błąd";
  if (status === "failedRecoverable")
    return "Karta jest niedostępna — podłącz ją i wznów";
  if (status === "rollingBack") return "Wycofywanie plików tej sesji";
  if (status === "rollbackFailed") return "Wycofanie wymaga ponowienia";
  return "Import anulowany";
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} godz.`;
}

function timeSourceLabel(
  source: "exif" | "videoMetadata" | "fileModified" | "unknown",
) {
  if (source === "exif") return "czas EXIF";
  if (source === "videoMetadata") return "czas filmu";
  if (source === "fileModified") return "czas pliku";
  return "czas nieznany";
}

function sourceName(source: SourceVolume): string {
  return source.name.trim() || source.mountPath;
}

function sourceMatchesSession(source: SourceVolume, session: ImportSession) {
  const identity = session.sourceIdentity;
  if (!identity) return source.fingerprint === session.sourceFingerprint;
  const strongMatch =
    (identity.markerUuid !== null &&
      identity.markerUuid === source.markerUuid) ||
    (identity.platformVolumeId !== null &&
      identity.platformVolumeId === source.platformVolumeId);
  return identity.markerUuid !== null || identity.platformVolumeId !== null
    ? strongMatch
    : identity.fallbackFingerprint === source.fingerprint;
}

function bindingForSource(settings: AppSettings, source: SourceVolume) {
  return settings.local.sourceBindings
    .map((binding) => {
      const identity = binding.sourceIdentity;
      if (identity.markerUuid && identity.markerUuid === source.markerUuid)
        return { binding, score: 3 };
      if (
        identity.platformVolumeId &&
        identity.platformVolumeId === source.platformVolumeId
      )
        return { binding, score: 2 };
      if (identity.fallbackFingerprint === source.fingerprint)
        return {
          binding,
          score: identity.markerUuid || identity.platformVolumeId ? 0 : 1,
        };
      return { binding, score: -1 };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)[0]?.binding;
}

function bindingMatchesExactly(
  binding: AppSettings["local"]["sourceBindings"][number],
  source: SourceVolume,
) {
  const identity = binding.sourceIdentity;
  if (identity.markerUuid && source.markerUuid)
    return identity.markerUuid === source.markerUuid;
  if (identity.platformVolumeId && source.platformVolumeId)
    return identity.platformVolumeId === source.platformVolumeId;
  return (
    !identity.markerUuid &&
    !identity.platformVolumeId &&
    identity.fallbackFingerprint === source.fingerprint
  );
}

function workflowStateLabel(state: PendingSourceWorkflow["state"]) {
  if (state === "awaitingDecision") return "Czeka na decyzję";
  if (state === "scanning") return "Skanowanie";
  if (state === "awaitingProfileConfirmation") return "Potwierdź aparat";
  if (state === "preparingPlan") return "Przygotowanie planu";
  if (state === "planReady") return "Plan gotowy";
  if (state === "importing") return "Importowanie";
  if (state === "failedRecoverable") return "Można wznowić";
  if (state === "ignoredUntilDisconnect") return "Pominięta do odłączenia";
  if (state === "disconnected") return "Odłączona";
  return "Wykryta";
}

function profileForIdentity(
  settings: AppSettings,
  identity: MediaItem["cameraIdentity"],
) {
  if (!identity) return undefined;
  const normalized = (value: string | null) =>
    value?.trim().toLocaleLowerCase() ?? null;
  const candidates = settings.portable.cameraProfiles
    .map((profile) => {
      const scores = profile.exifMatchers.map((matcher) => {
        if (
          matcher.serialNumber &&
          normalized(matcher.serialNumber) === normalized(identity.serialNumber)
        ) {
          return 2;
        }
        if (
          matcher.serialNumber &&
          normalized(matcher.serialNumber) !== normalized(identity.serialNumber)
        ) {
          return 0;
        }
        if (
          matcher.make &&
          normalized(matcher.make) !== normalized(identity.make)
        ) {
          return 0;
        }
        if (
          matcher.model &&
          normalized(matcher.model) !== normalized(identity.model)
        ) {
          return 0;
        }
        return matcher.make && matcher.model ? 1 : 0;
      });
      return { profile, score: Math.max(0, ...scores) };
    })
    .filter(({ score }) => score > 0);
  const bestScore = Math.max(0, ...candidates.map(({ score }) => score));
  const best = candidates.filter(({ score }) => score === bestScore);
  return best.length === 1 ? best[0].profile : undefined;
}

function cameraIdentityKey(identity: CameraIdentity): string {
  return [identity.make, identity.model, identity.serialNumber]
    .map((value) => value?.trim().toLocaleLowerCase() ?? "")
    .join("\u0000");
}

function formatTimestamp(timestamp: number): string {
  if (timestamp === 0) return "Czas nieznany";
  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function defaultEventNames(events: SourceScanResponse["events"]) {
  return Object.fromEntries(
    events.map((event) => [
      event.index,
      `wydarzenie-${String(event.index).padStart(2, "0")}`,
    ]),
  );
}

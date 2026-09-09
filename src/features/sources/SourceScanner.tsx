import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  loadSettings,
  normalizeSettingsError,
  saveSettings,
  type AppSettings,
} from "../../shared/settings";
import { acknowledgePendingSource } from "../../shared/background";
import {
  buildImportPlanPreview,
  allowOriginalJpegPreview,
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
  listPhotoUserMetadata,
  listMediaScans,
  pauseImportSession,
  startMediaScan,
  startImportSession,
  savePendingSourceWorkflow,
  savePhotoUserMetadata,
  createImportSession,
  retryImportRollback,
  type SourceScanResponse,
  type SourceVolume,
  type ImportPlan,
  type ImportSession,
  type MediaItem,
  type MediaScanJob,
  type StreamedScanItems,
  type CameraIdentity,
  type SourceIdentity,
  type PendingSourceWorkflow,
  type PhotoUserMetadataUpdate,
} from "../../shared/sources";

interface CameraProfileDraft {
  key: string;
  identity: CameraIdentity;
  profileId: string;
  name: string;
  itemCount: number;
}

type ScanSource =
  | {
      kind: "volume";
      sourceId: string;
      identity: SourceIdentity | null;
      displayName: string;
    }
  | {
      kind: "directory";
      sourceId: string;
      displayName: string;
    };
import { requestThumbnail } from "../../shared/thumbnailManager";
import {
  describeOperationalError,
  type AppStatus,
} from "../../shared/appStatus";
import { ErrorNotice } from "../../shared/ErrorNotice";
import { activeIntlLocale, localize as l } from "../../i18n";

const ignoreHealthChange = () => undefined;

export function SourceScanner({
  appStatus = "ready",
  onHealthChange = ignoreHealthChange,
  openWorkflowId = null,
}: {
  appStatus?: AppStatus;
  onHealthChange?: (healthy: boolean) => void;
  openWorkflowId?: string | null;
} = {}) {
  const [sources, setSources] = useState<SourceVolume[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [scanJob, setScanJob] = useState<MediaScanJob | null>(null);
  const [scanResult, setScanResult] = useState<SourceScanResponse | null>(null);
  const [streamedScans, setStreamedScans] = useState<
    Record<string, { path: string; items: MediaItem[] }>
  >({});
  const [message, setMessage] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<unknown>(null);
  const [discoveryComplete, setDiscoveryComplete] = useState(false);
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
  const [ratingFilter, setRatingFilter] = useState(0);
  const [rejectionFilter, setRejectionFilter] = useState<
    "all" | "kept" | "rejected"
  >("all");
  const [userMetadata, setUserMetadata] = useState<
    Record<string, PhotoUserMetadataUpdate>
  >({});
  const [metadataLoadedFor, setMetadataLoadedFor] = useState<string | null>(
    null,
  );
  const [excludedImportKeys, setExcludedImportKeys] = useState<Set<string>>(
    new Set(),
  );
  const [eventNames, setEventNames] = useState<Record<number, string>>({});
  const [expandedEventIndexes, setExpandedEventIndexes] = useState<Set<number>>(
    new Set(),
  );
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
  const displayedScanRoot = useRef<string | null>(null);
  const displayedWorkflowId = useRef<string | null>(null);
  const scanSource = useRef<ScanSource | null>(null);
  const metadataSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const workflowSaveQueues = useRef<Map<string, Promise<void>>>(new Map());
  const metadataLoadGeneration = useRef(0);
  const sourceRefreshInFlight = useRef<Promise<void> | null>(null);
  const previouslyOpenedWorkflowId = useRef<string | null>(null);
  const cameraSources = useMemo(
    () => sources.filter((source) => source.likelyCameraSource),
    [sources],
  );
  const journeyStep = importSession ? 3 : importPlan ? 2 : scanResult ? 1 : 0;
  const journeyFinished = importSession?.status === "completed";

  useEffect(() => {
    void loadSettings()
      .then((response) => setSettings(response.settings))
      .catch((error) => setMessage(normalizeSettingsError(error).message));
  }, []);

  useEffect(() => {
    if (!openWorkflowId) return;
    const workflow = pendingWorkflows.find(
      (candidate) => candidate.sourceId === openWorkflowId,
    );
    if (
      workflow?.scan &&
      workflow.state !== "disconnected" &&
      displayedScanRoot.current !== workflow.scan.scan.root
    ) {
      openWorkflow(workflow);
    }
  }, [openWorkflowId, pendingWorkflows]);

  useEffect(() => {
    if (previouslyOpenedWorkflowId.current && !openWorkflowId) {
      setScanResult(null);
      setImportPlan(null);
      setProfileDrafts(null);
      setSelectedKeys(new Set());
      setEventNames({});
      setExcludedImportKeys(new Set());
      setItemProfileAssignments({});
      setExpandedEventIndexes(new Set());
      setUserMetadata({});
      displayedScanRoot.current = null;
      displayedWorkflowId.current = null;
      scanSource.current = null;
      setMessage(null);
    }
    previouslyOpenedWorkflowId.current = openWorkflowId;
  }, [openWorkflowId]);

  useEffect(() => {
    let active = true;
    const unlisten = listen<StreamedScanItems>("scan-items", (event) => {
      if (!active) return;
      setStreamedScans((current) => {
        const currentScan = current[event.payload.scanId];
        const byKey = new Map(
          currentScan?.path === event.payload.path
            ? currentScan.items.map((item) => [item.key, item])
            : [],
        );
        for (const item of event.payload.items) byKey.set(item.key, item);
        return {
          ...current,
          [event.payload.scanId]: {
            path: event.payload.path,
            items: [...byKey.values()].sort(
              (left, right) =>
                left.capturedAtUnixMs - right.capturedAtUnixMs ||
                left.key.localeCompare(right.key),
            ),
          },
        };
      });
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
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
      void runScan(
        event.payload,
        l(
          "Scanning a card awaiting a decision…",
          "Skanowanie karty oczekującej na decyzję…",
        ),
      );
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
        if (event.payload.scan?.scan.root === displayedScanRoot.current) {
          displayedWorkflowId.current = event.payload.sourceId;
        }
        setPendingWorkflows((current) => [
          event.payload,
          ...current.filter(
            (workflow) => workflow.sourceId !== event.payload.sourceId,
          ),
        ]);
      },
    );
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let active = true;
    const unlisten = listen<string>("source-workflows-invalidated", (event) => {
      void listPendingSourceWorkflows()
        .then((workflows) => {
          if (!active) return;
          const refreshed = workflows ?? [];
          setPendingWorkflows(refreshed);
          const invalidatedWorkflow = refreshed.find(
            (workflow) => workflow.sourceId === event.payload,
          );
          if (
            invalidatedWorkflow?.state === "disconnected" &&
            invalidatedWorkflow.sourceId === displayedWorkflowId.current &&
            invalidatedWorkflow.scan?.scan.root === displayedScanRoot.current
          ) {
            setScanResult(null);
            setImportPlan(null);
            setProfileDrafts(null);
            setSelectedKeys(new Set());
            setEventNames({});
            setExcludedImportKeys(new Set());
            setItemProfileAssignments({});
            setExpandedEventIndexes(new Set());
            setUserMetadata({});
            setMetadataLoadedFor(null);
            metadataLoadGeneration.current += 1;
            displayedScanRoot.current = null;
            displayedWorkflowId.current = null;
            scanSource.current = null;
            setMessage(null);
          }
        })
        .catch(() => undefined);
    });
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
              l("New camera", "Nowy aparat")),
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
    if (
      !scanResult ||
      !settings ||
      profileDrafts?.length !== 0 ||
      importPlan ||
      metadataLoadedFor !== scanResult.scan.root
    )
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
  }, [
    profileDrafts,
    importPlan,
    metadataLoadedFor,
    scanResult,
    settings,
    sources,
  ]);

  useEffect(() => {
    let active = true;
    void listMediaScans()
      .then((jobs) => {
        const running = jobs.find((job) => job.status === "running");
        if (active && running) {
          setScanJob(running);
          setScanningPath(running.path);
          setMessage(
            l(
              "The automatically started scan is running in the background…",
              "Skan uruchomiony przez automat działa w tle…",
            ),
          );
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
        applyCompletedScan(job.result, job.id);
        setScanningPath(null);
      } else if (job.status === "failed") {
        setMessage(
          job.error ?? l("Scanning failed.", "Skanowanie nie powiodło się."),
        );
        setScanningPath(null);
      } else if (job.status === "cancelled") {
        setMessage(
          l("Scanning was cancelled.", "Skanowanie zostało anulowane."),
        );
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

  const refreshSources = useCallback(() => {
    if (sourceRefreshInFlight.current) return sourceRefreshInFlight.current;
    const request = (async () => {
      try {
        const discovered = await listMediaSources();
        setSources(discovered);
        setDiscoveryError(null);
        setDiscoveryComplete(true);
        onHealthChange(true);
      } catch (error) {
        setSources([]);
        setDiscoveryError(error);
        setDiscoveryComplete(false);
        onHealthChange(false);
      }
    })();
    sourceRefreshInFlight.current = request;
    void request.finally(() => {
      if (sourceRefreshInFlight.current === request) {
        sourceRefreshInFlight.current = null;
      }
    });
    return request;
  }, [onHealthChange]);

  useEffect(() => {
    if (appStatus === "connecting" || appStatus === "error") {
      setSources([]);
      setDiscoveryComplete(false);
      return;
    }
    let active = true;
    let timer: number | null = null;
    const refreshAndSchedule = async () => {
      await refreshSources();
      if (active) {
        timer = window.setTimeout(() => void refreshAndSchedule(), 5_000);
      }
    };
    void refreshAndSchedule();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [appStatus === "connecting" || appStatus === "error", refreshSources]);

  async function runScan(
    path: string,
    initialMessage?: string,
    requestedSource?: SourceVolume | "directory",
  ) {
    setScanningPath(path);
    displayedScanRoot.current = path;
    displayedWorkflowId.current = null;
    setScanResult(null);
    setStreamedScans({});
    setProfileDrafts(null);
    setWriteSourceMarker(true);
    setItemProfileAssignments({});
    setUserMetadata({});
    setMetadataLoadedFor(null);
    metadataLoadGeneration.current += 1;
    setExpandedEventIndexes(new Set());
    autoPlannedRoot.current = null;
    setSelectedKeys(new Set());
    setMessage(initialMessage ?? l("Scanning source…", "Skanowanie źródła…"));
    try {
      let detectedSource =
        requestedSource === "directory"
          ? undefined
          : (requestedSource ??
            sources.find((source) => source.mountPath === path));
      if (detectedSource) {
        displayedWorkflowId.current = sourceWorkflowId(detectedSource);
      }
      if (
        detectedSource &&
        !detectedSource.markerUuid &&
        !detectedSource.readOnly
      ) {
        const markerUuid = await ensureMediaSourceMarker(path);
        displayedWorkflowId.current = `marker:${markerUuid}`;
        setSources((current) =>
          current.map((source) =>
            source.mountPath === path ? { ...source, markerUuid } : source,
          ),
        );
        detectedSource = { ...detectedSource, markerUuid };
      }
      scanSource.current =
        requestedSource === "directory"
          ? directoryScanSource(path)
          : detectedSource
            ? volumeScanSource(detectedSource)
            : {
                kind: "volume",
                sourceId: `unverified:${path}`,
                identity: null,
                displayName: displayFileName(path),
              };
      const job = await startMediaScan(path);
      setScanJob(job);
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
      setScanningPath(null);
    }
  }

  function applyCompletedScan(result: SourceScanResponse, scanId: string) {
    displayedScanRoot.current = result.scan.root;
    setScanResult(result);
    setStreamedScans((current) => {
      const next = { ...current };
      delete next[scanId];
      return next;
    });
    setEventNames(defaultEventNames(result.events));
    setExpandedEventIndexes(new Set());
    setExcludedImportKeys(
      new Set(
        result.importMatches
          .filter((match) => match.state === "imported")
          .map((match) => match.itemKey),
      ),
    );
    setImportPlan(null);
    void hydrateUserMetadata(result.scan.root);
    setMessage(
      result.scan.items.length === 0
        ? l(
            "No supported photos or videos were found.",
            "Nie znaleziono obsługiwanych zdjęć ani filmów.",
          )
        : l(
            `Scan complete: ${result.scan.items.length} items in ${result.events.length} events.`,
            `Skanowanie zakończone: ${result.scan.items.length} pozycji w ${result.events.length} wydarzeniach.`,
          ),
    );
  }

  function openWorkflow(workflow: PendingSourceWorkflow) {
    if (!workflow.scan) return;
    displayedScanRoot.current = workflow.scan.scan.root;
    displayedWorkflowId.current = workflow.sourceId;
    scanSource.current = workflow.sourceId.startsWith("directory:")
      ? directoryScanSource(workflow.sourceRoot, workflow.displayName)
      : {
          kind: "volume",
          sourceId: workflow.sourceId,
          identity: workflow.sourceIdentity,
          displayName: workflow.displayName,
        };
    setUserMetadata({});
    setMetadataLoadedFor(null);
    const settingsChanged =
      settings !== null &&
      workflow.settingsRevision !== "" &&
      workflow.settingsRevision !== JSON.stringify(settings.portable.naming);
    setScanResult(workflow.scan);
    void hydrateUserMetadata(workflow.scan.scan.root);
    setEventNames({
      ...defaultEventNames(workflow.scan.events),
      ...workflow.editor.eventNames,
    });
    setExcludedImportKeys(new Set(workflow.editor.excludedItemKeys));
    setItemProfileAssignments(workflow.editor.itemProfileAssignments);
    setExpandedEventIndexes(
      new Set(workflow.editor.expandedEventIndexes ?? []),
    );
    setImportPlan(settingsChanged ? null : workflow.plan);
    setProfileDrafts(
      workflow.state === "awaitingProfileConfirmation" ? null : [],
    );
    setMessage(
      settingsChanged
        ? l(
            "Naming settings have changed — rebuild the plan.",
            "Ustawienia nazewnictwa zmieniły się — przelicz plan ponownie.",
          )
        : workflow.state === "planReady"
          ? l(
              "Restored a plan awaiting approval.",
              "Przywrócono plan oczekujący na zatwierdzenie.",
            )
          : (workflow.error ??
            l(
              "Restored a card state that requires attention.",
              "Przywrócono stan karty wymagającej uwagi.",
            )),
    );
  }

  async function hydrateUserMetadata(sourceRoot: string) {
    const generation = ++metadataLoadGeneration.current;
    try {
      const records = (await listPhotoUserMetadata(sourceRoot)) ?? [];
      if (generation !== metadataLoadGeneration.current) return;
      setUserMetadata(
        Object.fromEntries(
          records.map((record) => [
            record.itemKey,
            {
              itemKey: record.itemKey,
              rating: record.rating,
              rejected: record.rejected,
              rotationDegrees: record.rotationDegrees,
            },
          ]),
        ),
      );
      setMetadataLoadedFor(sourceRoot);
    } catch (error) {
      if (generation !== metadataLoadGeneration.current) return;
      setMetadataLoadedFor(sourceRoot);
      setMessage(normalizeSettingsError(error).message);
    }
  }

  function updateUserMetadata(updates: PhotoUserMetadataUpdate[]) {
    if (!scanResult || updates.length === 0) return;
    setUserMetadata((current) => ({
      ...current,
      ...Object.fromEntries(updates.map((update) => [update.itemKey, update])),
    }));
    setImportPlan(null);
    const sourceRoot = scanResult.scan.root;
    metadataSaveQueue.current = metadataSaveQueue.current
      .catch(() => undefined)
      .then(() => savePhotoUserMetadata(sourceRoot, updates))
      .catch((error) => {
        setMessage(normalizeSettingsError(error).message);
        void hydrateUserMetadata(sourceRoot);
      });
  }

  function queueWorkflowSave(workflow: PendingSourceWorkflow): Promise<void> {
    const queueKey = workflow.sourceRoot;
    const previous = workflowSaveQueues.current.get(queueKey);
    const queued = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => savePendingSourceWorkflow(workflow));
    workflowSaveQueues.current.set(queueKey, queued);
    void queued.then(
      () => {
        if (workflowSaveQueues.current.get(queueKey) === queued)
          workflowSaveQueues.current.delete(queueKey);
      },
      (error) => {
        if (workflowSaveQueues.current.get(queueKey) === queued)
          workflowSaveQueues.current.delete(queueKey);
        setMessage(normalizeSettingsError(error).message);
      },
    );
    return queued;
  }

  function invalidatePlan(
    editor: PendingSourceWorkflow["editor"],
    result: SourceScanResponse | null = scanResult,
  ) {
    setImportPlan(null);
    if (!result) return;
    const source = workflowSourceFor(result.scan.root, scanSource.current);
    void queueWorkflowSave({
      sourceRoot: result.scan.root,
      sourceId: source.sourceId,
      sourceIdentity: source.sourceIdentity,
      displayName: source.displayName,
      state: "preparingPlan",
      scan: result,
      plan: null,
      settingsSchemaVersion: settings?.schemaVersion ?? 0,
      settingsRevision: settings
        ? JSON.stringify(settings.portable.naming)
        : "",
      editor,
      updatedAtUnixMs: Date.now(),
      error: null,
    });
  }

  function updateExpandedEvents(next: Set<number>) {
    setExpandedEventIndexes(next);
    if (!scanResult) return;

    const existing = pendingWorkflows.find(
      (workflow) => workflow.sourceRoot === scanResult.scan.root,
    );
    const source = workflowSourceFor(scanResult.scan.root, scanSource.current);
    const workflow: PendingSourceWorkflow = {
      sourceId: existing?.sourceId ?? source.sourceId,
      sourceRoot: scanResult.scan.root,
      sourceIdentity: existing?.sourceIdentity ?? source.sourceIdentity,
      displayName:
        existing?.displayName ??
        source.displayName ??
        displayFileName(scanResult.scan.root),
      state: existing?.state ?? (importPlan ? "planReady" : "preparingPlan"),
      scan: scanResult,
      plan: importPlan,
      settingsSchemaVersion:
        existing?.settingsSchemaVersion ?? settings?.schemaVersion ?? 0,
      settingsRevision:
        existing?.settingsRevision ??
        (settings ? JSON.stringify(settings.portable.naming) : ""),
      editor: {
        eventNames,
        excludedItemKeys: [...excludedImportKeys],
        itemProfileAssignments,
        expandedEventIndexes: [...next],
      },
      error: existing?.error ?? null,
      updatedAtUnixMs: Date.now(),
    };

    setPendingWorkflows((current) => [
      workflow,
      ...current.filter(
        (candidate) => candidate.sourceId !== workflow.sourceId,
      ),
    ]);
    void queueWorkflowSave(workflow);
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
          name: draft.name.trim() || l("New camera", "Nowy aparat"),
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
      setMessage(
        l(
          "Camera profiles and card were approved.",
          "Profile aparatów i karta zostały zatwierdzone.",
        ),
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    }
  }

  async function cancelScan() {
    if (!scanJob || scanJob.status !== "running") return;
    try {
      await cancelMediaScan(scanJob.id);
      setMessage(
        l(
          "Cancelling after the current file…",
          "Anulowanie po bieżącym pliku…",
        ),
      );
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
      const correctedEventNames = {
        ...defaultEventNames(response.events),
        ...eventNames,
      };
      setScanResult(correctedResult);
      setEventNames(correctedEventNames);
      const noExpandedEvents = new Set<number>();
      setExpandedEventIndexes(noExpandedEvents);
      invalidatePlan(
        {
          eventNames: correctedEventNames,
          excludedItemKeys: [...excludedImportKeys],
          itemProfileAssignments,
          expandedEventIndexes: [],
        },
        correctedResult,
      );
      setMessage(
        l(
          `Corrected the time of ${response.changedItemCount} items and regrouped events.`,
          `Skorygowano czas ${response.changedItemCount} pozycji i ponownie pogrupowano wydarzenia.`,
        ),
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
      title: l(
        "Choose a card, folder, or network share to scan",
        "Wybierz kartę, katalog lub udział sieciowy do skanowania",
      ),
    });
    if (directory) await runScan(directory, undefined, "directory");
  }

  function profileFor(source: SourceVolume) {
    const binding = settings ? bindingForSource(settings, source) : undefined;
    return settings?.portable.cameraProfiles.find((profile) =>
      binding?.cameraProfileIds.includes(profile.id),
    );
  }

  async function prepareImportPlan(automatic = false) {
    if (!scanResult || !settings) return;
    if (metadataLoadedFor !== scanResult.scan.root) {
      setMessage(
        l(
          "Wait for photo ratings and statuses to load.",
          "Poczekaj na wczytanie ocen i statusów zdjęć.",
        ),
      );
      return;
    }
    if (profileDrafts && profileDrafts.length > 0) {
      setMessage(
        l(
          "First approve the camera profiles found on the card.",
          "Najpierw zatwierdź profile aparatów znalezione na karcie.",
        ),
      );
      return;
    }
    const scannedSource = scanSource.current;
    const source =
      scannedSource?.kind === "volume" && scannedSource.identity
        ? sources.find(
            (candidate) =>
              candidate.mountPath === scanResult.scan.root &&
              sourceMatchesIdentity(candidate, scannedSource.identity!),
          )
        : undefined;
    if (!scannedSource || (scannedSource.kind !== "directory" && !source)) {
      setMessage(
        l(
          "The scanned card is unavailable or its identity cannot be confirmed. Reconnect the same card before rebuilding the plan.",
          "Zeskanowana karta jest niedostępna albo nie można potwierdzić jej tożsamości. Podłącz tę samą kartę przed ponownym przeliczeniem planu.",
        ),
      );
      return;
    }
    setPlanning(true);
    setImportPlan(null);
    try {
      const importedSourcePaths = scanResult.importMatches.flatMap(
        (match) => match.importedSourcePaths,
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
              cameraAlias:
                itemProfile?.name ?? l("Unknown camera", "Nieznany aparat"),
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
          name: eventNames[event.index] ?? defaultEventName(event.index),
        })),
        excludedItemKeys: [
          ...new Set([
            ...excludedImportKeys,
            ...Object.values(userMetadata)
              .filter((metadata) => metadata.rejected)
              .map((metadata) => metadata.itemKey),
          ]),
        ],
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
            scannedSource.kind === "directory"
              ? scannedSource.sourceId
              : sourceWorkflowId(source!),
          sourceRoot: scanResult.scan.root,
          sourceIdentity: source
            ? {
                markerUuid: source.markerUuid,
                platformVolumeId: source.platformVolumeId,
                fallbackFingerprint: source.fingerprint,
              }
            : null,
          displayName:
            source?.name ??
            scannedSource.displayName ??
            displayFileName(scanResult.scan.root),
          state: "planReady",
          scan: scanResult,
          plan,
          settingsSchemaVersion: settings.schemaVersion,
          settingsRevision: JSON.stringify(settings.portable.naming),
          editor: {
            eventNames,
            excludedItemKeys: [...excludedImportKeys],
            itemProfileAssignments,
            expandedEventIndexes: [...expandedEventIndexes],
          },
          error: null,
          updatedAtUnixMs: Date.now(),
        };
        await queueWorkflowSave(workflow);
        setPendingWorkflows((current) => [
          workflow,
          ...current.filter(
            (candidate) => candidate.sourceId !== workflow.sourceId,
          ),
        ]);
      }
      if (automatic && plan.status !== "empty") {
        await announceImportPlanReady(plan.fileCount).catch(() => undefined);
      }
      setMessage(
        plan.status === "requiresDecision"
          ? l(
              `The plan contains ${plan.conflicts.length} conflicts that require a decision.`,
              `Plan zawiera ${plan.conflicts.length} kolizji wymagających decyzji.`,
            )
          : plan.status === "empty"
            ? l(
                "The plan is empty — all items are excluded or already imported.",
                "Plan jest pusty — wszystkie pozycje są wykluczone lub już zaimportowane.",
              )
            : l(
                `Plan ready: ${plan.fileCount} files in ${plan.events.length} folders.`,
                `Plan gotowy: ${plan.fileCount} plików w ${plan.events.length} folderach.`,
              ),
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setPlanning(false);
    }
  }

  async function beginImport(
    selectedPlan: ImportPlan | null = importPlan,
    selectedScan: SourceScanResponse | null = scanResult,
  ) {
    if (!selectedPlan || selectedPlan.status !== "ready" || !settings) return;
    const moving =
      settings.portable.import.defaultOperation === "moveAfterVerification";
    const confirmMove =
      !moving ||
      window.confirm(
        l(
          "After complete sets are verified, the application will delete the source files. Start moving files?",
          "Po zweryfikowaniu całych zestawów aplikacja usunie pliki źródłowe. Czy na pewno rozpocząć przenoszenie?",
        ),
      );
    if (!confirmMove) return;
    setImportActionPending(true);
    try {
      const source = sources.find(
        (candidate) => candidate.mountPath === selectedScan?.scan.root,
      );
      const session = await createImportSession(
        selectedPlan,
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
      if (selectedScan) {
        const workflow = pendingWorkflows.find(
          (candidate) => candidate.scan?.scan.root === selectedScan.scan.root,
        );
        if (workflow)
          await deletePendingSourceWorkflow(workflow.sourceId).catch(
            () => undefined,
          );
        setPendingWorkflows((current) =>
          current.filter(
            (candidate) => candidate.sourceId !== workflow?.sourceId,
          ),
        );
      }
      await startImportSession(session.id);
      setMessage(l("Import started.", "Import został rozpoczęty."));
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setImportActionPending(false);
    }
  }

  async function deleteImportPlan() {
    if (!scanResult || !importPlan) return;
    if (
      !window.confirm(
        l(
          "Delete this import plan? Scan results and selections will be lost. No photos will be deleted.",
          "Usunąć ten plan importu? Wyniki skanu i wybory zostaną utracone. Zdjęcia nie zostaną usunięte.",
        ),
      )
    )
      return;
    setImportActionPending(true);
    try {
      const workflow = pendingWorkflows.find(
        (candidate) => candidate.scan?.scan.root === scanResult.scan.root,
      );
      const source = sources.find(
        (candidate) => candidate.mountPath === scanResult.scan.root,
      );
      const sourceId =
        workflow?.sourceId ?? (source ? sourceWorkflowId(source) : null);
      if (sourceId) {
        await deletePendingSourceWorkflow(sourceId);
        setPendingWorkflows((current) =>
          current.filter((candidate) => candidate.sourceId !== sourceId),
        );
      }
      autoPlannedRoot.current = scanResult.scan.root;
      setScanResult(null);
      setImportPlan(null);
      setSelectedKeys(new Set());
      setEventNames({});
      setExcludedImportKeys(new Set());
      setItemProfileAssignments({});
      setExpandedEventIndexes(new Set());
      displayedScanRoot.current = null;
      displayedWorkflowId.current = null;
      setMessage(
        l("Import plan was deleted.", "Plan importu został usunięty."),
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setImportActionPending(false);
    }
  }

  async function removeWorkflow(workflow: PendingSourceWorkflow) {
    if (
      !window.confirm(
        l(
          `Delete the saved plan for ${workflow.displayName || "this card"}? Scan results and selections will be lost. No photos will be deleted.`,
          `Usunąć zapisany plan dla ${workflow.displayName || "tej karty"}? Wyniki skanu i wybory zostaną utracone. Zdjęcia nie zostaną usunięte.`,
        ),
      )
    )
      return;
    setImportActionPending(true);
    try {
      await deletePendingSourceWorkflow(workflow.sourceId);
      setPendingWorkflows((current) =>
        current.filter((candidate) => candidate.sourceId !== workflow.sourceId),
      );
      if (scanResult?.scan.root === workflow.scan?.scan.root) {
        setScanResult(null);
        setImportPlan(null);
        displayedScanRoot.current = null;
        displayedWorkflowId.current = null;
      }
      setMessage(
        l("Import plan was deleted.", "Plan importu został usunięty."),
      );
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
        if (
          !window.confirm(
            l(
              "Cancel this import session?",
              "Czy na pewno przerwać tę sesję importu?",
            ),
          )
        )
          return;
        cancelMode = window.confirm(
          l(
            "Delete unchanged files added by this session? Choose Cancel to keep completed files.",
            "Czy usunąć niezmienione pliki dodane przez tę sesję? Wybierz Anuluj, aby zachować ukończone pliki.",
          ),
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
      setMessage(
        l(
          "Safe session rollback was retried.",
          "Ponowiono bezpieczne wycofanie sesji.",
        ),
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setImportActionPending(false);
    }
  }

  return (
    <>
      {(journeyStep > 0 || journeyFinished) && (
        <ImportJourney currentStep={journeyStep} finished={journeyFinished} />
      )}
      <section className="source-hero">
        <div>
          <p className="section-label">{l("MEDIA SOURCES", "ŹRÓDŁA MEDIÓW")}</p>
          <h2>
            {!discoveryComplete
              ? appStatus === "error"
                ? l("Sources are unavailable.", "Źródła są niedostępne.")
                : l("Checking available sources…", "Sprawdzam dostępne źródła…")
              : cameraSources.length > 0
                ? l("Camera media detected.", "Wykryto nośnik aparatu.")
                : l("Waiting for a memory card.", "Czekam na kartę pamięci.")}
          </h2>
          <p>
            {l(
              "The list refreshes every 5 seconds. You can also scan any folder or mounted network share.",
              "Lista odświeża się co 5 sekund. Możesz też przeskanować dowolny katalog lub zamontowany udział sieciowy.",
            )}
          </p>
          <button
            type="button"
            className="secondary"
            onClick={() => void chooseDirectory()}
            disabled={
              scanningPath !== null ||
              appStatus === "connecting" ||
              appStatus === "error"
            }
          >
            {l("Choose folder manually", "Wybierz katalog ręcznie")}
          </button>
          {message && (
            <p className="scan-message" role="status">
              {message}
            </p>
          )}
        </div>
        <div className="source-hero__status">
          <span className="source-count">
            {discoveryComplete ? cameraSources.length : "—"}
          </span>
          <strong>
            {discoveryComplete
              ? l("probable camera sources", "prawdopodobnych źródeł aparatu")
              : l("source count is unknown", "liczba źródeł jest nieznana")}
          </strong>
          <span>
            {discoveryError
              ? l("Could not read sources", "Odczyt źródeł nie powiódł się")
              : discoveryComplete
                ? l("Source list is up to date", "Lista źródeł jest aktualna")
                : l("Waiting for confirmation", "Oczekiwanie na potwierdzenie")}
          </span>
        </div>
      </section>

      {discoveryError !== null && (
        <ErrorNotice
          error={describeOperationalError(discoveryError, "read")}
          onRetry={() => void refreshSources()}
        />
      )}

      {scanJob?.status === "running" && (
        <>
          <ScanProgressPanel job={scanJob} onCancel={() => void cancelScan()} />
          {streamedScans[scanJob.id]?.path === scanJob.path &&
            streamedScans[scanJob.id].items.length > 0 && (
              <StreamingScanPreview items={streamedScans[scanJob.id].items} />
            )}
        </>
      )}

      {cameraSources.length > 0 && (
        <section
          className="source-list"
          aria-label={l("Detected media", "Wykryte nośniki")}
        >
          {cameraSources.map((source) => {
            const profile = profileFor(source);
            const workflow = pendingWorkflows.find((candidate) =>
              workflowMatchesSource(candidate, source),
            );
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
                    {workflow && (
                      <span className="known-badge">
                        {workflowStateLabel(workflow.state)}
                      </span>
                    )}
                  </div>
                  <p>
                    {source.mountPath} ·{" "}
                    {source.fileSystem ||
                      l("unknown file system", "nieznany system")}{" "}
                    · {formatBytes(source.totalBytes)}
                  </p>
                  <div className="source-flags">
                    {source.removable && (
                      <span>{l("removable", "wymienny")}</span>
                    )}
                    {source.containsDcim && <span>DCIM</span>}
                    {source.readOnly && (
                      <span>{l("read-only", "tylko odczyt")}</span>
                    )}
                  </div>
                  {!profile && (
                    <small>
                      {l(
                        "The scan will identify the camera from EXIF before remembering the card.",
                        "Skan rozpozna aparat z EXIF przed zapamiętaniem karty.",
                      )}
                    </small>
                  )}
                </div>
                <div className="source-card__actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!workflow?.scan}
                    onClick={() => workflow && openWorkflow(workflow)}
                  >
                    {l("Details", "Szczegóły")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void runScan(source.mountPath, undefined, source)
                    }
                    disabled={scanningPath !== null}
                  >
                    {scanningPath === source.mountPath
                      ? l("Scanning…", "Skanowanie…")
                      : l("Scan", "Skanuj")}
                  </button>
                  <button
                    type="button"
                    className="danger-quiet"
                    disabled={!workflow || importActionPending}
                    onClick={() => workflow && void removeWorkflow(workflow)}
                  >
                    {l("Delete", "Usuń")}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !workflow?.plan ||
                      workflow.plan.status !== "ready" ||
                      workflow.plan.conflicts.length > 0 ||
                      importActionPending
                    }
                    onClick={() =>
                      workflow?.plan &&
                      workflow.scan &&
                      void beginImport(workflow.plan, workflow.scan)
                    }
                  >
                    {l("Start import", "Uruchom import")}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {importSession && !scanResult && (
        <ImportSessionProgress
          session={importSession}
          actionPending={importActionPending}
          onControl={(action) => void controlImport(action)}
          onRetryRollback={() => void retryRollback()}
        />
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
            ratingFilter={ratingFilter}
            onRatingFilterChange={setRatingFilter}
            rejectionFilter={rejectionFilter}
            onRejectionFilterChange={setRejectionFilter}
            userMetadata={userMetadata}
            onUserMetadataChange={updateUserMetadata}
            excludedImportKeys={excludedImportKeys}
            onExcludedImportKeysChange={(keys) => {
              setExcludedImportKeys(keys);
              invalidatePlan({
                eventNames,
                excludedItemKeys: [...keys],
                itemProfileAssignments,
                expandedEventIndexes: [...expandedEventIndexes],
              });
            }}
            eventNames={eventNames}
            onEventNameChange={(index, name) => {
              const nextEventNames = { ...eventNames, [index]: name };
              setEventNames(nextEventNames);
              invalidatePlan({
                eventNames: nextEventNames,
                excludedItemKeys: [...excludedImportKeys],
                itemProfileAssignments,
                expandedEventIndexes: [...expandedEventIndexes],
              });
            }}
            expandedEventIndexes={expandedEventIndexes}
            onExpandedEventIndexesChange={updateExpandedEvents}
            importPlan={importPlan}
            planning={planning}
            onPrepareImportPlan={() => void prepareImportPlan(false)}
            onDeleteImportPlan={() => void deleteImportPlan()}
            importSession={importSession}
            importActionPending={importActionPending}
            onBeginImport={() => void beginImport()}
            importOperation={
              settings?.portable.import.defaultOperation ?? "copy"
            }
            onControlImport={(action) => void controlImport(action)}
            onRetryRollback={() => void retryRollback()}
            cameraProfiles={settings?.portable.cameraProfiles ?? []}
            itemProfileAssignments={itemProfileAssignments}
            onItemProfileAssignment={(key, profileId) => {
              const nextAssignments = {
                ...itemProfileAssignments,
                [key]: profileId,
              };
              setItemProfileAssignments(nextAssignments);
              invalidatePlan({
                eventNames,
                excludedItemKeys: [...excludedImportKeys],
                itemProfileAssignments: nextAssignments,
                expandedEventIndexes: [...expandedEventIndexes],
              });
            }}
          />
        </>
      )}
    </>
  );
}

function ImportJourney({
  currentStep,
  finished,
}: {
  currentStep: number;
  finished: boolean;
}) {
  const steps = [
    l("Source", "Źródło"),
    l("Review", "Przegląd"),
    l("Plan", "Plan"),
    l("Import", "Import"),
  ];
  return (
    <nav
      className="import-journey"
      aria-label={l("Import steps", "Etapy importu")}
    >
      <ol>
        {steps.map((label, index) => {
          const state =
            index < currentStep || finished
              ? "completed"
              : index === currentStep
                ? "current"
                : "unavailable";
          const stateLabel =
            state === "completed"
              ? l("completed", "ukończony")
              : state === "current"
                ? l("current", "bieżący")
                : l("unavailable", "niedostępny");
          return (
            <li
              className={`import-journey__step import-journey__step--${state}`}
              key={label}
              aria-current={state === "current" ? "step" : undefined}
              aria-disabled={state === "unavailable" ? "true" : undefined}
            >
              <span className="import-journey__marker" aria-hidden="true">
                {state === "completed" ? "✓" : index + 1}
              </span>
              <span>
                <strong>{label}</strong>
                <small>{stateLabel}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
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
      <span className="section-label">
        {l("DETECTED CAMERAS", "ROZPOZNANE APARATY")}
      </span>
      <h3>
        {l(
          "Approve profiles before preparing the plan",
          "Zatwierdź profile przed przygotowaniem planu",
        )}
      </h3>
      <p>
        {l(
          "The card will only be remembered after this decision. You can create a new profile, use an existing one, or leave the media unassigned.",
          "Karta zostanie zapamiętana dopiero po tej decyzji. Możesz utworzyć nowy profil, użyć istniejącego albo pozostawić materiały jako nieznane.",
        )}
      </p>
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={writeMarker && !markerDisabled}
          disabled={markerDisabled}
          onChange={(event) => onWriteMarkerChange(event.target.checked)}
        />
        <span>
          {l(
            "Save a private identifier on the card for safe recognition after its drive letter changes",
            "Zapisz na karcie prywatny identyfikator ułatwiający bezpieczne rozpoznanie po zmianie litery dysku",
          )}
        </span>
      </label>
      {drafts.map((draft) => (
        <div className="profile-confirmation__row" key={draft.key}>
          <div>
            <strong>
              {[draft.identity.make, draft.identity.model]
                .filter(Boolean)
                .join(" ") || l("Unknown camera", "Nieznany aparat")}
            </strong>
            <small>
              {draft.itemCount} {l("items", "pozycji")}
              {draft.identity.serialNumber
                ? ` · nr ${draft.identity.serialNumber}`
                : l(" · no serial number", " · brak numeru seryjnego")}
            </small>
          </div>
          <select
            aria-label={l(
              "Camera profile assignment",
              "Przypisanie profilu aparatu",
            )}
            value={draft.profileId}
            onChange={(event) =>
              update(draft.key, { profileId: event.target.value })
            }
          >
            <option value="new">
              {l("Create a new profile", "Utwórz nowy profil")}
            </option>
            {profiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name}
              </option>
            ))}
            <option value="unknown">
              {l("Leave unassigned", "Pozostaw jako nieznany")}
            </option>
          </select>
          {draft.profileId === "new" && (
            <input
              aria-label={l("New profile name", "Nazwa nowego profilu")}
              value={draft.name}
              onChange={(event) =>
                update(draft.key, { name: event.target.value })
              }
            />
          )}
        </div>
      ))}
      <button type="button" onClick={onConfirm}>
        {l(
          "Approve profiles and remember card",
          "Zatwierdź profile i zapamiętaj kartę",
        )}
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
  ratingFilter,
  onRatingFilterChange,
  rejectionFilter,
  onRejectionFilterChange,
  userMetadata,
  onUserMetadataChange,
  excludedImportKeys,
  onExcludedImportKeysChange,
  eventNames,
  onEventNameChange,
  expandedEventIndexes,
  onExpandedEventIndexesChange,
  importPlan,
  planning,
  onPrepareImportPlan,
  onDeleteImportPlan,
  importSession,
  importActionPending,
  onBeginImport,
  importOperation,
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
  ratingFilter: number;
  onRatingFilterChange: (rating: number) => void;
  rejectionFilter: "all" | "kept" | "rejected";
  onRejectionFilterChange: (filter: "all" | "kept" | "rejected") => void;
  userMetadata: Record<string, PhotoUserMetadataUpdate>;
  onUserMetadataChange: (updates: PhotoUserMetadataUpdate[]) => void;
  excludedImportKeys: Set<string>;
  onExcludedImportKeysChange: (keys: Set<string>) => void;
  eventNames: Record<number, string>;
  onEventNameChange: (index: number, name: string) => void;
  expandedEventIndexes: Set<number>;
  onExpandedEventIndexesChange: (indexes: Set<number>) => void;
  importPlan: ImportPlan | null;
  planning: boolean;
  onPrepareImportPlan: () => void;
  onDeleteImportPlan: () => void;
  importSession: ImportSession | null;
  importActionPending: boolean;
  onBeginImport: () => void;
  importOperation: AppSettings["portable"]["import"]["defaultOperation"];
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
  const metadataFor = (key: string): PhotoUserMetadataUpdate =>
    userMetadata[key] ?? {
      itemKey: key,
      rating: 0,
      rejected: false,
      rotationDegrees: 0,
    };
  const visibleEvents = result.events
    .map((event) => ({
      ...event,
      coverItem: event.items[0],
      items: event.items.filter((item) => {
        const metadata = metadataFor(item.key);
        return (
          (filter === "all" || matches.get(item.key)?.state !== "imported") &&
          (ratingFilter === 0 || metadata.rating >= ratingFilter) &&
          (rejectionFilter === "all" ||
            (rejectionFilter === "rejected"
              ? metadata.rejected
              : !metadata.rejected))
        );
      }),
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
      if (
        matches.get(item.key)?.state === "imported" ||
        metadataFor(item.key).rejected
      )
        continue;
      if (included) next.delete(item.key);
      else next.add(item.key);
    }
    onExcludedImportKeysChange(next);
  }

  const importableItemKeys = result.events.flatMap((event) =>
    event.items
      .filter(
        (item) =>
          matches.get(item.key)?.state !== "imported" &&
          !metadataFor(item.key).rejected,
      )
      .map((item) => item.key),
  );
  const allEventsIncluded =
    importableItemKeys.length > 0 &&
    importableItemKeys.every((key) => !excludedImportKeys.has(key));
  const noEventsIncluded = importableItemKeys.every((key) =>
    excludedImportKeys.has(key),
  );

  function setAllEventsIncluded(included: boolean) {
    const next = new Set(excludedImportKeys);
    for (const key of importableItemKeys) {
      if (included) next.delete(key);
      else next.add(key);
    }
    onExcludedImportKeysChange(next);
  }

  function toggleEvent(index: number) {
    const next = new Set(expandedEventIndexes);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onExpandedEventIndexesChange(next);
  }

  function updateMetadata(
    key: string,
    patch: Partial<Omit<PhotoUserMetadataUpdate, "itemKey">>,
  ) {
    onUserMetadataChange([{ ...metadataFor(key), ...patch }]);
  }

  function updateSelected(
    patch: (
      metadata: PhotoUserMetadataUpdate,
    ) => Partial<Omit<PhotoUserMetadataUpdate, "itemKey">>,
  ) {
    onUserMetadataChange(
      [...selectedKeys].map((key) => {
        const metadata = metadataFor(key);
        return { ...metadata, ...patch(metadata) };
      }),
    );
  }

  function headingContainsControl(target: EventTarget | null) {
    return (
      target instanceof Element &&
      target.closest("button, input, label, select, textarea, a") !== null
    );
  }

  return (
    <section className="scan-results">
      <header className="review-heading">
        <div>
          <span className="section-label">
            {l("NEXT STEP · REVIEW", "NASTĘPNY KROK · PRZEGLĄD")}
          </span>
          <h3>{l("Review scan results", "Przejrzyj wyniki skanu")}</h3>
          <p>
            {l(
              "Review events, correct time, and decide what to include.",
              "Sprawdź wydarzenia, popraw czas i zdecyduj, co uwzględnić.",
            )}
          </p>
        </div>
        {!importPlan && (
          <strong>
            {l(
              "Next you'll prepare an import plan",
              "Potem przygotujesz plan importu",
            )}
          </strong>
        )}
      </header>
      <div className="scan-summary">
        <div>
          <span>{l("Items", "Pozycje")}</span>
          <strong>{result.scan.items.length}</strong>
        </div>
        <div>
          <span>{l("Files", "Pliki")}</span>
          <strong>{result.scan.supportedFileCount}</strong>
        </div>
        <div>
          <span>{l("Size", "Rozmiar")}</span>
          <strong>{formatBytes(result.scan.totalSizeBytes)}</strong>
        </div>
        <div>
          <span>{l("Events", "Wydarzenia")}</span>
          <strong>{result.events.length}</strong>
        </div>
        <div>
          <span>{l("Imported", "Zaimportowane")}</span>
          <strong>{importedCount}</strong>
        </div>
      </div>
      <p className="timestamp-note">
        {l(
          "Time comes from EXIF or video metadata; file modification time is used when data is missing. Event gap:",
          "Czas pochodzi z EXIF lub metadanych filmu; dla brakujących danych używany jest czas modyfikacji. Przerwa wydarzenia:",
        )}{" "}
        {result.eventGapMinutes} min.
      </p>
      <div className="scan-tools">
        <div
          className="result-filter"
          role="group"
          aria-label={l("Results filter", "Filtr wyników")}
        >
          <button
            type="button"
            className={filter === "all" ? "active" : "ghost"}
            onClick={() => onFilterChange("all")}
          >
            {l("All", "Wszystkie")}
          </button>
          <button
            type="button"
            className={filter === "new" ? "active" : "ghost"}
            onClick={() => onFilterChange("new")}
          >
            {l("New only", "Tylko nowe")}
          </button>
          <select
            aria-label={l("Minimum rating", "Minimalna ocena")}
            value={ratingFilter}
            onChange={(event) =>
              onRatingFilterChange(Number(event.target.value))
            }
          >
            <option value={0}>{l("Any rating", "Dowolna ocena")}</option>
            {[1, 2, 3, 4, 5].map((rating) => (
              <option value={rating} key={rating}>
                {rating}+ ★
              </option>
            ))}
          </select>
          <select
            aria-label={l("Rejection status", "Status odrzucenia")}
            value={rejectionFilter}
            onChange={(event) =>
              onRejectionFilterChange(
                event.target.value as typeof rejectionFilter,
              )
            }
          >
            <option value="all">{l("Any status", "Każdy status")}</option>
            <option value="kept">
              {l("Without rejected", "Bez odrzuconych")}
            </option>
            <option value="rejected">{l("Rejected", "Do odrzucenia")}</option>
          </select>
        </div>
        <div className="time-correction">
          <strong>
            {selectedKeys.size} {l("selected", "zaznaczonych")}
          </strong>
          <input
            aria-label={l("Time correction value", "Wartość korekty czasu")}
            type="number"
            value={correctionValue}
            onChange={(event) =>
              onCorrectionValueChange(Number(event.target.value))
            }
          />
          <select
            aria-label={l("Time correction unit", "Jednostka korekty czasu")}
            value={correctionUnit}
            onChange={(event) =>
              onCorrectionUnitChange(
                event.target.value as typeof correctionUnit,
              )
            }
          >
            <option value="seconds">{l("seconds", "sekundy")}</option>
            <option value="minutes">{l("minutes", "minuty")}</option>
            <option value="hours">{l("hours", "godziny")}</option>
          </select>
          <button
            type="button"
            className="secondary"
            onClick={onApplyCorrection}
            disabled={busy || selectedKeys.size === 0}
          >
            {l("Apply correction", "Zastosuj korektę")}
          </button>
          {selectedKeys.size > 0 && (
            <button
              type="button"
              className="ghost"
              onClick={() => onSelectionChange(new Set())}
            >
              {l("Clear", "Wyczyść")}
            </button>
          )}
        </div>
      </div>
      {selectedKeys.size > 0 && (
        <div
          className="metadata-bulk"
          aria-label={l(
            "Bulk metadata operations",
            "Operacje zbiorcze metadanych",
          )}
        >
          <strong>
            {l("Metadata for", "Metadane dla")} {selectedKeys.size}{" "}
            {l("items", "pozycji")}:
          </strong>
          <select
            aria-label={l("Rate selected items", "Ustaw ocenę zaznaczonych")}
            defaultValue=""
            onChange={(event) => {
              if (event.target.value === "") return;
              const rating = Number(event.target.value);
              updateSelected(() => ({ rating }));
              event.target.value = "";
            }}
          >
            <option value="" disabled>
              {l("Set rating…", "Ustaw ocenę…")}
            </option>
            {[0, 1, 2, 3, 4, 5].map((rating) => (
              <option value={rating} key={rating}>
                {rating} ★
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ghost"
            onClick={() => updateSelected(() => ({ rejected: true }))}
          >
            {l("Reject", "Odrzuć")}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => updateSelected(() => ({ rejected: false }))}
          >
            {l("Restore", "Przywróć")}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              updateSelected((metadata) => ({
                rotationDegrees: ((metadata.rotationDegrees + 90) % 360) as
                  0 | 90 | 180 | 270,
              }))
            }
          >
            {l("Rotate 90°", "Obróć o 90°")}
          </button>
        </div>
      )}
      <div
        className="event-list-controls"
        role="group"
        aria-label={l("Event operations", "Operacje na wydarzeniach")}
      >
        <button
          type="button"
          className="ghost"
          onClick={() => setAllEventsIncluded(true)}
          disabled={allEventsIncluded || importableItemKeys.length === 0}
        >
          {l("Select all events", "Zaznacz wszystkie wydarzenia")}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setAllEventsIncluded(false)}
          disabled={noEventsIncluded || importableItemKeys.length === 0}
        >
          {l("Deselect all events", "Odznacz wszystkie wydarzenia")}
        </button>
        <span className="event-list-controls__spacer" aria-hidden="true" />
        <button
          type="button"
          className="ghost"
          onClick={() => onExpandedEventIndexesChange(new Set())}
          disabled={expandedEventIndexes.size === 0}
        >
          {l("Collapse all", "Zwiń wszystkie")}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() =>
            onExpandedEventIndexesChange(
              new Set(result.events.map((event) => event.index)),
            )
          }
          disabled={result.events.every((event) =>
            expandedEventIndexes.has(event.index),
          )}
        >
          {l("Expand all", "Rozwiń wszystkie")}
        </button>
      </div>
      <div className="event-list">
        {visibleEvents.map((event) => {
          const expanded = expandedEventIndexes.has(event.index);
          const importableItems = event.items.filter(
            (item) =>
              matches.get(item.key)?.state !== "imported" &&
              !metadataFor(item.key).rejected,
          );
          const includedImportItemCount = importableItems.filter(
            (item) => !excludedImportKeys.has(item.key),
          ).length;
          const entireEventIncluded =
            importableItems.length > 0 &&
            includedImportItemCount === importableItems.length;
          const eventPartiallyIncluded =
            includedImportItemCount > 0 && !entireEventIncluded;
          const allEventItemsSelected = event.items.every((item) =>
            selectedKeys.has(item.key),
          );
          const headingId = `event-${event.index}-heading`;
          const contentId = `event-${event.index}-content`;
          const eventName =
            eventNames[event.index]?.trim() ||
            l(`Event ${event.index}`, `Wydarzenie ${event.index}`);
          return (
            <article
              className={`event-card ${expanded ? "event-card--expanded" : "event-card--collapsed"}`}
              key={event.index}
            >
              <div
                className="event-card__heading"
                id={headingId}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                aria-controls={contentId}
                aria-label={l(
                  `${expanded ? "Collapse" : "Expand"} event ${eventName}`,
                  `${expanded ? "Zwiń" : "Rozwiń"} wydarzenie ${eventName}`,
                )}
                onClick={(click) => {
                  if (!headingContainsControl(click.target))
                    toggleEvent(event.index);
                }}
                onKeyDown={(keyEvent) => {
                  if (
                    keyEvent.target === keyEvent.currentTarget &&
                    (keyEvent.key === "Enter" || keyEvent.key === " ")
                  ) {
                    keyEvent.preventDefault();
                    toggleEvent(event.index);
                  }
                }}
              >
                <EventImportCheckbox
                  checked={entireEventIncluded}
                  indeterminate={eventPartiallyIncluded}
                  disabled={importableItems.length === 0}
                  eventName={eventName}
                  onChange={() => setEventIncluded(event, !entireEventIncluded)}
                />
                {!expanded && (
                  <div className="event-card__thumbnail">
                    <MediaThumbnail
                      item={event.coverItem}
                      maxDimension={160}
                      rotation={
                        metadataFor(event.coverItem.key).rotationDegrees
                      }
                    />
                  </div>
                )}
                <div className="event-card__identity">
                  <span>
                    {l("EVENT", "WYDARZENIE")} {event.index}
                  </span>
                  {expanded ? (
                    <>
                      <h3>
                        {formatEventRange(
                          event.startsAtUnixMs,
                          event.endsAtUnixMs,
                        )}
                      </h3>
                      <label className="event-name-field">
                        <span>{l("Folder name", "Nazwa folderu")}</span>
                        <input
                          value={eventNames[event.index] ?? ""}
                          onChange={(change) =>
                            onEventNameChange(event.index, change.target.value)
                          }
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <h3>{eventName}</h3>
                      <p>
                        {formatEventRange(
                          event.startsAtUnixMs,
                          event.endsAtUnixMs,
                        )}
                      </p>
                    </>
                  )}
                </div>
                <div className="event-card__actions">
                  {expanded && (
                    <>
                      <strong>
                        {event.items.length} {l("items", "pozycji")} ·{" "}
                        {formatBytes(event.totalSizeBytes)}
                      </strong>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          const next = new Set(selectedKeys);
                          for (const item of event.items) {
                            if (allEventItemsSelected) next.delete(item.key);
                            else next.add(item.key);
                          }
                          onSelectionChange(next);
                        }}
                      >
                        {allEventItemsSelected
                          ? l(
                              "Deselect event for editing",
                              "Odznacz edycję wydarzenia",
                            )
                          : l(
                              "Select event for editing",
                              "Zaznacz wydarzenie do edycji",
                            )}
                      </button>
                    </>
                  )}
                </div>
                <span className="event-card__chevron" aria-hidden="true">
                  {expanded ? "⌃" : "⌄"}
                </span>
              </div>
              {expanded && (
                <div
                  className="media-strip"
                  id={contentId}
                  aria-labelledby={headingId}
                >
                  {event.items.map((item) => {
                    const importMatch = matches.get(item.key);
                    const metadata = metadataFor(item.key);
                    return (
                      <div
                        className={`media-tile ${selectedKeys.has(item.key) ? "media-tile--selected" : ""} ${excludedImportKeys.has(item.key) ? "media-tile--excluded" : ""} ${metadata.rejected ? "media-tile--rejected" : ""} ${importMatch?.state === "imported" ? "media-tile--imported" : ""}`}
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
                        <MediaThumbnail
                          item={item}
                          maxDimension={320}
                          rotation={metadata.rotationDegrees}
                        />
                        <input
                          aria-label={l(
                            "Select for time correction",
                            "Zaznacz do korekty czasu",
                          )}
                          type="checkbox"
                          checked={selectedKeys.has(item.key)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleItem(item.key)}
                        />
                        <span className="media-tile__type">
                          {item.files.find((file) => file.kind !== "xmp")
                            ?.kind ?? "xmp"}
                        </span>
                        <strong>
                          {displayFileName(
                            item.files[0]?.relativePath ?? item.key,
                          )}
                        </strong>
                        <div className="media-tile__metadata">
                          <select
                            aria-label={l("Photo rating", "Ocena zdjęcia")}
                            value={metadata.rating}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) =>
                              updateMetadata(item.key, {
                                rating: Number(event.target.value),
                              })
                            }
                          >
                            {[0, 1, 2, 3, 4, 5].map((rating) => (
                              <option value={rating} key={rating}>
                                {rating} ★
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="ghost"
                            aria-pressed={metadata.rejected}
                            onClick={(event) => {
                              event.stopPropagation();
                              updateMetadata(item.key, {
                                rejected: !metadata.rejected,
                              });
                            }}
                          >
                            {metadata.rejected
                              ? l("Restore", "Przywróć")
                              : l("Reject", "Odrzuć")}
                          </button>
                        </div>
                        <small>
                          {item.hasRawJpegPair
                            ? "RAW+JPEG"
                            : `${item.files.length} ${l("file(s)", "plik")}`}
                          {item.hasSidecar ? " + XMP" : ""}
                        </small>
                        <select
                          aria-label={l(
                            "Camera profile for item",
                            "Profil aparatu dla pozycji",
                          )}
                          value={itemProfileAssignments[item.key] ?? "unknown"}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onItemProfileAssignment(
                              item.key,
                              event.target.value,
                            )
                          }
                        >
                          <option value="unknown">
                            {l("Unknown camera", "Nieznany aparat")}
                          </option>
                          {cameraProfiles.map((profile) => (
                            <option value={profile.id} key={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </select>
                        <small>
                          {timeSourceLabel(item.timeSource)}
                          {item.timeCorrectionSeconds !== 0
                            ? l(
                                ` · correction ${item.timeCorrectionSeconds}s`,
                                ` · korekta ${item.timeCorrectionSeconds}s`,
                              )
                            : ""}
                        </small>
                        <small>
                          {item.cameraMetadataConflict
                            ? l(
                                "conflicting camera data",
                                "sprzeczne dane aparatu",
                              )
                            : item.cameraIdentity
                              ? [
                                  item.cameraIdentity.make,
                                  item.cameraIdentity.model,
                                ]
                                  .filter(Boolean)
                                  .join(" ")
                              : l("Unknown camera", "Nieznany aparat")}
                        </small>
                        {importMatch?.state !== "new" && (
                          <span className="import-state">
                            {importMatch?.state === "imported"
                              ? l("already imported", "już importowane")
                              : l(
                                  "partially imported",
                                  "częściowo importowane",
                                )}
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
                            ? l("skipped", "pominięte")
                            : excludedImportKeys.has(item.key)
                              ? l("add to plan", "dodaj do planu")
                              : l("skip in plan", "pomiń w planie")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {previewIndex >= 0 && (
        <FullMediaPreview
          item={visibleItems[previewIndex]}
          metadata={metadataFor(visibleItems[previewIndex].key)}
          onMetadataChange={(patch) =>
            updateMetadata(visibleItems[previewIndex].key, patch)
          }
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
            <span className="section-label">
              {l("IMPORT PLAN", "PLAN IMPORTU")}
            </span>
            <h3>
              {l(
                "Review paths before copying",
                "Sprawdź ścieżki przed kopiowaniem",
              )}
            </h3>
            <p>
              {l(
                "This step only calculates the result. It doesn't create folders or copy any files.",
                "Ten krok tylko oblicza wynik. Nie tworzy folderów i nie kopiuje żadnych plików.",
              )}
            </p>
          </div>
          <div className="import-planner__actions">
            {importPlan &&
              (!importSession ||
                ["completed", "cancelled"].includes(importSession.status)) && (
                <button
                  type="button"
                  className="danger-quiet"
                  onClick={onDeleteImportPlan}
                  disabled={planning || busy || importActionPending}
                >
                  {l("Delete plan", "Usuń plan")}
                </button>
              )}
            <button
              type="button"
              className={importPlan ? "secondary" : "primary-action"}
              onClick={onPrepareImportPlan}
              disabled={planning || busy}
            >
              {planning
                ? l("Preparing…", "Przygotowywanie…")
                : importPlan
                  ? l("Refresh plan", "Odśwież plan")
                  : l("Prepare plan", "Przygotuj plan")}
            </button>
          </div>
        </div>
        {importPlan && (
          <ImportPlanPreview
            plan={importPlan}
            onBeginImport={onBeginImport}
            actionPending={importActionPending}
            operation={importOperation}
            newItemCount={
              result.importMatches.filter((match) => match.state === "new")
                .length
            }
            skippedItemCount={
              result.importMatches.filter((match) => match.state !== "new")
                .length + excludedImportKeys.size
            }
            scanWarnings={result.scan.warnings}
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
          <summary>
            {result.scan.warnings.length}{" "}
            {l("scan warnings", "ostrzeżeń skanowania")}
          </summary>
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

function EventImportCheckbox({
  checked,
  indeterminate,
  disabled,
  eventName,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  eventName: string;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label
      className="event-import-toggle"
      title={l(
        `Include the entire ${eventName} event in the import`,
        `Uwzględnij całe wydarzenie ${eventName} w imporcie`,
      )}
    >
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : checked}
        aria-label={l(
          `Include the entire ${eventName} event in the import`,
          `Uwzględnij całe wydarzenie ${eventName} w imporcie`,
        )}
        onChange={onChange}
      />
    </label>
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
        <span className="section-label">{l("SCANNING", "SKANOWANIE")}</span>
        <h3>{scanPhaseLabel(job.phase)}</h3>
        <p>
          {job.phase === "discovering"
            ? l(
                `${job.discoveredFileCount} files found`,
                `${job.discoveredFileCount} znalezionych plików`,
              )
            : l(
                `${job.processedFileCount} of ${job.totalSupportedFileCount ?? "?"} supported files`,
                `${job.processedFileCount} z ${job.totalSupportedFileCount ?? "?"} obsługiwanych plików`,
              )}
          {job.currentPath ? ` · ${displayFileName(job.currentPath)}` : ""}
        </p>
        <small>
          {job.phase === "comparingHistory"
            ? l(
                `${formatBytes(job.historyBytesRead)} read · ${job.historyCacheHitCount} cached · ${job.fullyHashedFileCount} full reads`,
                `${formatBytes(job.historyBytesRead)} odczytano · ${job.historyCacheHitCount} z cache · ${job.fullyHashedFileCount} pełnych odczytów`,
              )
            : l(
                "Large cards and RAW files may take several minutes. You can wait or cancel scanning.",
                "Duże karty i pliki RAW mogą wymagać kilku minut. Możesz chwilę poczekać albo anulować skanowanie.",
              )}
        </small>
      </div>
      <div
        className={`scan-progress-track ${determinate ? "" : "scan-progress-track--indeterminate"}`}
        aria-label={
          determinate
            ? l(
                `Progress ${percentage.toFixed(0)}%`,
                `Postęp ${percentage.toFixed(0)}%`,
              )
            : l("Searching for files", "Wyszukiwanie plików")
        }
      >
        <span style={determinate ? { width: `${percentage}%` } : undefined} />
      </div>
      <button type="button" className="ghost" onClick={onCancel}>
        {l("Cancel scanning", "Anuluj skanowanie")}
      </button>
    </section>
  );
}

function StreamingScanPreview({ items }: { items: MediaItem[] }) {
  return (
    <section
      className="streaming-scan-preview"
      aria-label={l(
        "Photos found while scanning",
        "Zdjęcia znalezione podczas skanowania",
      )}
    >
      <div className="streaming-scan-preview__heading">
        <div>
          <span className="section-label">
            {l("LIVE PREVIEW", "PODGLĄD NA ŻYWO")}
          </span>
          <h3>{l("Photos found", "Znalezione zdjęcia")}</h3>
        </div>
        <strong>{items.length}</strong>
      </div>
      <div className="streaming-scan-preview__strip">
        {items.map((item) => (
          <div className="streaming-scan-preview__item" key={item.key}>
            <MediaThumbnail item={item} maxDimension={320} />
            <small>
              {displayFileName(item.files[0]?.relativePath ?? item.key)}
            </small>
          </div>
        ))}
      </div>
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
  const source = previewSource(item);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

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
    setUrl(null);
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
            ? l("preview unavailable", "brak podglądu")
            : source?.kind === "video"
              ? l("VIDEO", "WIDEO")
              : l("loading…", "ładowanie…")}
        </span>
      )}
    </div>
  );
}

function FullMediaPreview({
  item,
  metadata,
  onMetadataChange,
  position,
  total,
  onClose,
  onPrevious,
  onNext,
}: {
  item: MediaItem;
  metadata: PhotoUserMetadataUpdate;
  onMetadataChange: (
    patch: Partial<Omit<PhotoUserMetadataUpdate, "itemKey">>,
  ) => void;
  position: number;
  total: number;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const [scale, setScale] = useState(1);
  const jpeg = item.files.find((file) => file.kind === "jpeg");
  useEffect(() => {
    setScale(1);
  }, [item.key]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  return (
    <div
      className="preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={l("Photo preview", "Podgląd zdjęcia")}
    >
      <div className="preview-dialog">
        <div className="preview-toolbar">
          <strong>
            {position} / {total}
          </strong>
          <div>
            <select
              aria-label={l(
                "Photo rating in preview",
                "Ocena zdjęcia w podglądzie",
              )}
              value={metadata.rating}
              onChange={(event) =>
                onMetadataChange({ rating: Number(event.target.value) })
              }
            >
              {[0, 1, 2, 3, 4, 5].map((rating) => (
                <option value={rating} key={rating}>
                  {rating} ★
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost"
              aria-pressed={metadata.rejected}
              onClick={() => onMetadataChange({ rejected: !metadata.rejected })}
            >
              {metadata.rejected
                ? l("Restore", "Przywróć")
                : l("Reject", "Odrzuć")}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setScale((value) => Math.min(3, value + 0.25))}
            >
              {l("Zoom in", "Powiększ")}
            </button>
            <button type="button" className="ghost" onClick={() => setScale(1)}>
              {l("Fit", "Dopasuj")}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() =>
                onMetadataChange({
                  rotationDegrees: ((metadata.rotationDegrees + 90) % 360) as
                    0 | 90 | 180 | 270,
                })
              }
            >
              {l("Rotate 90°", "Obróć o 90°")}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              {l("Close", "Zamknij")}
            </button>
          </div>
        </div>
        {jpeg ? (
          <OriginalJpegPreview
            key={item.key}
            path={jpeg.path}
            rotation={metadata.rotationDegrees}
            scale={scale}
          />
        ) : (
          <MediaThumbnail
            key={item.key}
            item={item}
            maxDimension={1_600}
            eager
            rotation={metadata.rotationDegrees}
            scale={scale}
          />
        )}
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
            {l("Previous", "Poprzednie")}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={position >= total}
            onClick={onNext}
          >
            {l("Next", "Następne")}
          </button>
        </div>
      </div>
    </div>
  );
}

function OriginalJpegPreview({
  path,
  rotation,
  scale,
}: {
  path: string;
  rotation: number;
  scale: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setUrl(null);
    setFailed(false);
    void allowOriginalJpegPreview(path)
      .then((allowedPath) => {
        if (active) setUrl(convertFileSrc(allowedPath));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [path]);

  return (
    <div className="media-thumbnail media-thumbnail--original">
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => {
            setUrl(null);
            setFailed(true);
          }}
          style={{ transform: `rotate(${rotation}deg) scale(${scale})` }}
        />
      ) : (
        <span>
          {failed
            ? l("preview unavailable", "brak podglądu")
            : l("loading original…", "ładowanie oryginału…")}
        </span>
      )}
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
  if (phase === "discovering")
    return l("Searching for photos and videos", "Wyszukiwanie zdjęć i filmów");
  if (phase === "readingMetadata")
    return l("Reading metadata", "Odczytywanie metadanych");
  if (phase === "comparingHistory")
    return l(
      "Comparing with import history",
      "Porównywanie z historią importu",
    );
  if (phase === "groupingEvents")
    return l("Grouping events", "Składanie wydarzeń");
  return l("Scanning complete", "Skanowanie zakończone");
}

function ImportPlanPreview({
  plan,
  onBeginImport,
  actionPending,
  sessionActive,
  operation,
  newItemCount,
  skippedItemCount,
  scanWarnings,
}: {
  plan: ImportPlan;
  onBeginImport: () => void;
  actionPending: boolean;
  sessionActive: boolean;
  operation: AppSettings["portable"]["import"]["defaultOperation"];
  newItemCount: number;
  skippedItemCount: number;
  scanWarnings: SourceScanResponse["scan"]["warnings"];
}) {
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const riskyOperation = operation === "moveAfterVerification";
  const cameraSections = new Map<
    string,
    Array<{
      event: ImportPlan["events"][number];
      items: ImportPlan["events"][number]["items"];
    }>
  >();
  for (const event of plan.events) {
    const aliases = new Set(
      event.items.map(
        (item) => item.cameraAlias ?? l("Unknown camera", "Nieznany aparat"),
      ),
    );
    for (const alias of aliases) {
      const sections = cameraSections.get(alias) ?? [];
      sections.push({
        event,
        items: event.items.filter(
          (item) =>
            (item.cameraAlias ?? l("Unknown camera", "Nieznany aparat")) ===
            alias,
        ),
      });
      cameraSections.set(alias, sections);
    }
  }
  return (
    <div className="plan-preview">
      <div className="plan-preview__heading">
        <div>
          <span className="section-label">
            {l("PRE-IMPORT SUMMARY", "PODSUMOWANIE PRZED IMPORTEM")}
          </span>
          <h3>
            {l(
              "Review the operation's effects",
              "Sprawdź konsekwencje operacji",
            )}
          </h3>
        </div>
        <span
          className={`plan-readiness plan-readiness--${plan.status}`}
          role="status"
        >
          {plan.status === "ready"
            ? l("Ready for approval", "Gotowy do zatwierdzenia")
            : plan.status === "empty"
              ? l("No files to import", "Brak plików do importu")
              : l("Needs attention", "Wymaga uwagi")}
        </span>
      </div>
      <div className="plan-summary">
        <div>
          <span>{l("New items", "Nowe pozycje")}</span>
          <strong>{newItemCount}</strong>
        </div>
        <div>
          <span>{l("Skipped items", "Pominięte pozycje")}</span>
          <strong>{skippedItemCount}</strong>
        </div>
        <div>
          <span>{l("Data size", "Rozmiar danych")}</span>
          <strong>{formatBytes(plan.totalSizeBytes)}</strong>
        </div>
        <div>
          <span>{l("Conflicts", "Konflikty")}</span>
          <strong>{plan.conflicts.length}</strong>
        </div>
        <div>
          <span>{l("Operation", "Operacja")}</span>
          <strong>
            {riskyOperation
              ? l("Moving", "Przenoszenie")
              : l("Copying", "Kopiowanie")}
          </strong>
        </div>
        <div>
          <span>{l("Files to import", "Pliki do importu")}</span>
          <strong>{plan.fileCount}</strong>
        </div>
      </div>
      <p className="plan-library">
        {l("Destination folder", "Katalog docelowy")}:{" "}
        <code>{plan.libraryRoot}</code>
      </p>
      {(scanWarnings.length > 0 || riskyOperation) && (
        <div className="plan-attention" role="alert">
          <strong>{l("Needs attention", "Wymaga uwagi")}</strong>
          {riskyOperation && (
            <p>
              {l(
                "After complete sets are verified, source files will be deleted.",
                "Po weryfikacji całych zestawów pliki źródłowe zostaną usunięte.",
              )}
            </p>
          )}
          {scanWarnings.map((warning) => (
            <p key={`${warning.path}-${warning.message}`}>
              {warning.path}: {warning.message}
            </p>
          ))}
        </div>
      )}
      {plan.conflicts.length > 0 && (
        <div className="plan-conflicts" role="alert">
          <strong>
            {plan.conflicts.length} {l("conflicts", "kolizji")}
          </strong>
          <p>
            {l(
              "Import will remain stopped. Skip the indicated items or enable automatic numbering in settings and refresh the plan.",
              "Import pozostanie zatrzymany. Pomiń wskazane pozycje albo wybierz w ustawieniach automatyczne dodawanie numeru i odśwież plan.",
            )}
          </p>
          {plan.conflicts.map((conflict) => (
            <p key={`${conflict.itemKey}-${conflict.destinationPath}`}>
              {conflict.kind === "destinationExists"
                ? l("File already exists", "Plik już istnieje")
                : l(
                    "Two items use the same path",
                    "Dwie pozycje wskazują tę samą ścieżkę",
                  )}
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
                    {items.length} {l("items", "pozycji")} ·{" "}
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
        {riskyOperation && (
          <label className="risk-confirmation">
            <input
              type="checkbox"
              checked={riskConfirmed}
              onChange={(event) => setRiskConfirmed(event.target.checked)}
            />
            {l(
              "I understand that source files will be deleted after verification",
              "Rozumiem, że po weryfikacji pliki źródłowe zostaną usunięte",
            )}
          </label>
        )}
        <button
          type="button"
          className="primary-action"
          onClick={onBeginImport}
          disabled={
            plan.status !== "ready" ||
            actionPending ||
            sessionActive ||
            (riskyOperation && !riskConfirmed)
          }
        >
          {actionPending
            ? l("Starting…", "Uruchamianie…")
            : l("Start import", "Rozpocznij import")}
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
          <span className="section-label">
            {l("IMPORT SESSION", "SESJA IMPORTU")}
          </span>
          <h3>{sessionStatusLabel(session.status)}</h3>
        </div>
        <strong>
          {session.completedItemCount}/{session.itemCount}{" "}
          {l("sets", "zestawów")} · {session.completedFileCount}/
          {session.fileCount} {l("files", "plików")}
        </strong>
      </div>
      <div
        className="progress-track"
        aria-label={l(
          `Progress ${percentage.toFixed(0)}%`,
          `Postęp ${percentage.toFixed(0)}%`,
        )}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <p>
        {formatBytes(session.completedSizeBytes)} {l("of", "z")}{" "}
        {formatBytes(session.totalSizeBytes)}
        {current ? ` · ${displayFileName(current.sourcePath)}` : ""}
      </p>
      {bytesPerSecond > 0 && session.status === "running" && (
        <p>
          {l("Average", "Średnio")} {formatBytes(bytesPerSecond)}/s ·{" "}
          {l("about", "około")} {formatDuration(remainingSeconds)}{" "}
          {l("remaining", "do końca")}
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
              ? l(
                  "Pausing after the current set…",
                  "Zatrzymywanie po bieżącym zestawie…",
                )
              : l("Pause after the current set", "Pauza po bieżącym zestawie")}
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
            {session.status === "failed"
              ? l("Retry", "Ponów")
              : l("Resume", "Wznów")}
          </button>
        )}
        {session.status === "rollbackFailed" && (
          <button
            type="button"
            disabled={actionPending}
            onClick={onRetryRollback}
          >
            {l("Retry rollback", "Ponów wycofanie")}
          </button>
        )}
        {!(["completed", "cancelled"] as string[]).includes(session.status) && (
          <button
            type="button"
            className="danger-quiet"
            disabled={actionPending || session.cancelRequested}
            onClick={() => onControl("cancel")}
          >
            {session.cancelRequested
              ? l("Cancelling…", "Anulowanie…")
              : l("Cancel", "Anuluj")}
          </button>
        )}
      </div>
    </section>
  );
}

function sessionStatusLabel(status: ImportSession["status"]) {
  if (status === "planned")
    return l("Ready to start", "Gotowy do uruchomienia");
  if (status === "queued")
    return l("Import is queued", "Import oczekuje w kolejce");
  if (status === "running")
    return l("Copying and verifying", "Kopiowanie i weryfikacja");
  if (status === "paused") return l("Import paused", "Import wstrzymany");
  if (status === "completed") return l("Import completed", "Import zakończony");
  if (status === "failed")
    return l("Import stopped by an error", "Import zatrzymany przez błąd");
  if (status === "failedRecoverable")
    return l(
      "Card unavailable — reconnect it and resume",
      "Karta jest niedostępna — podłącz ją i wznów",
    );
  if (status === "rollingBack")
    return l(
      "Rolling back files from this session",
      "Wycofywanie plików tej sesji",
    );
  if (status === "rollbackFailed")
    return l("Rollback needs to be retried", "Wycofanie wymaga ponowienia");
  return l("Import cancelled", "Import anulowany");
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} ${l("hr", "godz.")}`;
}

function timeSourceLabel(
  source: "exif" | "videoMetadata" | "fileModified" | "unknown",
) {
  if (source === "exif") return l("EXIF time", "czas EXIF");
  if (source === "videoMetadata") return l("video time", "czas filmu");
  if (source === "fileModified") return l("file time", "czas pliku");
  return l("unknown time", "czas nieznany");
}

function sourceName(source: SourceVolume): string {
  return source.name.trim() || source.mountPath;
}

function workflowMatchesSource(
  workflow: PendingSourceWorkflow,
  source: SourceVolume,
) {
  const identity = workflow.sourceIdentity;
  return Boolean(
    identity?.markerUuid && identity.markerUuid === source.markerUuid,
  );
}

function sourceWorkflowId(source: SourceVolume) {
  return source.markerUuid
    ? `marker:${source.markerUuid}`
    : `unverified:${source.fingerprint}`;
}

function volumeScanSource(source: SourceVolume): ScanSource {
  return {
    kind: "volume",
    sourceId: sourceWorkflowId(source),
    identity: {
      markerUuid: source.markerUuid,
      platformVolumeId: source.platformVolumeId,
      fallbackFingerprint: source.fingerprint,
    },
    displayName: source.name.trim() || source.mountPath,
  };
}

function directoryScanSource(path: string, displayName?: string): ScanSource {
  return {
    kind: "directory",
    sourceId: `directory:${path}`,
    displayName: displayName || displayFileName(path) || path,
  };
}

function workflowSourceFor(root: string, source: ScanSource | null) {
  return {
    sourceId: source?.sourceId ?? `unverified:${root}`,
    sourceIdentity: source?.kind === "volume" ? source.identity : null,
    displayName: source?.displayName ?? displayFileName(root),
  };
}

function sourceMatchesIdentity(
  source: SourceVolume,
  identity: SourceIdentity,
): boolean {
  const hasStrongIdentity =
    identity.markerUuid !== null || identity.platformVolumeId !== null;
  if (hasStrongIdentity) {
    return Boolean(
      (identity.markerUuid !== null &&
        source.markerUuid === identity.markerUuid) ||
      (identity.platformVolumeId !== null &&
        source.platformVolumeId === identity.platformVolumeId),
    );
  }
  return source.fingerprint === identity.fallbackFingerprint;
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
  if (state === "awaitingDecision")
    return l("Awaiting decision", "Czeka na decyzję");
  if (state === "scanning") return l("Scanning", "Skanowanie");
  if (state === "awaitingProfileConfirmation")
    return l("Confirm camera", "Potwierdź aparat");
  if (state === "preparingPlan")
    return l("Preparing plan", "Przygotowanie planu");
  if (state === "planReady") return l("Plan ready", "Plan gotowy");
  if (state === "importing") return l("Importing", "Importowanie");
  if (state === "failedRecoverable") return l("Can resume", "Można wznowić");
  if (state === "ignoredUntilDisconnect")
    return l("Ignored until disconnected", "Pominięta do odłączenia");
  if (state === "disconnected") return l("Disconnected", "Odłączona");
  return l("Detected", "Wykryta");
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
  if (timestamp === 0) return l("Unknown time", "Czas nieznany");
  return new Intl.DateTimeFormat(activeIntlLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function formatEventRange(startsAt: number, endsAt: number): string {
  if (startsAt === 0 || endsAt === 0) return l("Unknown time", "Czas nieznany");
  if (startsAt === endsAt) return formatTimestamp(startsAt);

  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (!sameDay) {
    return `${formatTimestamp(startsAt)} – ${formatTimestamp(endsAt)}`;
  }

  const date = new Intl.DateTimeFormat(activeIntlLocale(), {
    dateStyle: "medium",
  }).format(start);
  const time = new Intl.DateTimeFormat(activeIntlLocale(), {
    timeStyle: "short",
  });
  return `${date}, ${time.format(start)}–${time.format(end)}`;
}

function defaultEventNames(events: SourceScanResponse["events"]) {
  return Object.fromEntries(
    events.map((event) => [event.index, defaultEventName(event.index)]),
  );
}

function defaultEventName(index: number) {
  return `${l("event", "wydarzenie")}-${String(index).padStart(2, "0")}`;
}

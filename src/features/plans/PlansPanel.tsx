import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import {
  deleteDisconnectedSourceWorkflows,
  deletePendingSourceWorkflow,
  formatBytes,
  listPendingSourceWorkflows,
  type PendingSourceWorkflow,
} from "../../shared/sources";
import {
  importPlanSettingsRevision,
  type AppSettings,
  loadSettings,
  normalizeSettingsError,
  saveSettings,
  type SourceBehavior,
} from "../../shared/settings";
import { useSettingsStore } from "../../shared/SettingsStore";

type DeleteRetry =
  { kind: "plan"; plan: PendingSourceWorkflow } | { kind: "disconnected" };

export function PlansPanel({
  onOpen,
  refreshRevision = 0,
}: {
  onOpen: (sourceId: string) => void;
  refreshRevision?: number;
}) {
  const { i18n } = useTranslation();
  const polish = i18n.resolvedLanguage?.startsWith("pl") ?? false;
  const l = (en: string, pl: string) => (polish ? pl : en);
  const [plans, setPlans] = useState<PendingSourceWorkflow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<{
    message: string;
    retry: DeleteRetry;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const settingsStore = useSettingsStore();
  const activeSettings = settingsStore?.settings ?? settings;

  const reload = useCallback(async () => {
    try {
      const [nextPlans, settingsResponse] = await Promise.all([
        listPendingSourceWorkflows(),
        settingsStore ? Promise.resolve(null) : loadSettings(),
      ]);
      setPlans(nextPlans ?? []);
      if (settingsResponse) setSettings(settingsResponse.settings);
      setMessage(null);
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    }
  }, [settingsStore]);

  useEffect(() => {
    void reload();
    const unlistenChanged = listen(
      "source-workflow-changed",
      () => void reload(),
    );
    const unlistenInvalidated = listen(
      "source-workflows-invalidated",
      () => void reload(),
    );
    return () => {
      void unlistenChanged.then((stop) => stop());
      void unlistenInvalidated.then((stop) => stop());
    };
  }, [reload, refreshRevision]);

  const groups = useMemo(
    () => ({
      active: plans.filter((plan) =>
        [
          "detected",
          "awaitingDecision",
          "scanning",
          "awaitingProfileConfirmation",
          "preparingPlan",
          "planReady",
          "importing",
        ].includes(plan.state),
      ),
      ignored: plans.filter((plan) => plan.state === "ignoredUntilDisconnect"),
      disconnected: plans.filter((plan) => plan.state === "disconnected"),
      errors: plans.filter((plan) => plan.state === "failedRecoverable"),
    }),
    [plans],
  );
  const visiblePlanCount =
    groups.active.length +
    groups.ignored.length +
    groups.disconnected.length +
    groups.errors.length;

  async function remove(plan: PendingSourceWorkflow) {
    if (
      !window.confirm(
        l(
          `Delete the saved plan for ${plan.displayName || "this card"}? Scan results and selections will be lost. No photos will be deleted.`,
          `Usunąć zapisany plan dla ${plan.displayName || "tej karty"}? Wyniki skanu i wybory zostaną utracone. Zdjęcia nie zostaną usunięte.`,
        ),
      )
    )
      return;
    await performDelete({ kind: "plan", plan });
  }

  async function performDelete(retry: DeleteRetry) {
    setBusy(true);
    setDeleteFailure(null);
    try {
      if (retry.kind === "plan") {
        await deletePendingSourceWorkflow(retry.plan.sourceId);
      } else {
        await deleteDisconnectedSourceWorkflows();
      }
      await reload();
    } catch (error) {
      const reason = normalizeSettingsError(error).message;
      setDeleteFailure({
        retry,
        message:
          retry.kind === "plan"
            ? l(
                `The plan could not be deleted and remains on the list. ${reason}`,
                `Nie udało się usunąć planu, dlatego nadal jest na liście. ${reason}`,
              )
            : l(
                `The disconnected plans could not be deleted and remain on the list. ${reason}`,
                `Nie udało się usunąć odłączonych planów, dlatego nadal są na liście. ${reason}`,
              ),
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeDisconnected() {
    const count = groups.disconnected.length;
    if (
      count === 0 ||
      !window.confirm(
        l(
          `Delete all ${count} disconnected plans? Scan results and selections will be lost.`,
          `Usunąć wszystkie odłączone plany (${count})? Wyniki skanów i wybory zostaną utracone.`,
        ),
      )
    )
      return;
    await performDelete({ kind: "disconnected" });
  }

  async function open(plan: PendingSourceWorkflow) {
    onOpen(plan.sourceId);
  }

  async function updateBehavior(
    plan: PendingSourceWorkflow,
    behavior: SourceBehavior,
  ) {
    if (!activeSettings || !plan.sourceIdentity) return;
    const sourceIdentity = plan.sourceIdentity;
    const existingBinding = bindingForPlan(activeSettings, plan);
    const recoveredCameraProfileIds = cameraProfileIdsForPlan(
      activeSettings,
      plan,
    );
    if (
      (behavior === "autoPreparePlan" || behavior === "autoImport") &&
      (existingBinding?.cameraProfileIds.length ?? 0) === 0 &&
      recoveredCameraProfileIds.length === 0
    ) {
      setMessage(
        l(
          "Choose a camera profile in Details before enabling automation for this card.",
          "Przed włączeniem automatyzacji dla tej karty wybierz profil aparatu w Szczegółach.",
        ),
      );
      return;
    }
    if (
      behavior === "autoImport" &&
      !window.confirm(
        l(
          "When this card is connected, the application will scan it and start copying automatically without another confirmation. Enable automatic copying?",
          "Po podłączeniu tej karty aplikacja przeskanuje ją i automatycznie rozpocznie kopiowanie bez kolejnego potwierdzenia. Włączyć automatyczne kopiowanie?",
        ),
      )
    )
      return;
    setBusy(true);
    try {
      const persist =
        settingsStore?.updateSettings ??
        (async (updater) => {
          const response = await saveSettings(updater(activeSettings));
          setSettings(response.settings);
          return response;
        });
      const response = await persist((current) => {
        const binding = bindingForPlan(current, plan);
        const cameraProfileIds = cameraProfileIdsForPlan(current, plan);
        const nextBinding = binding
          ? {
              ...binding,
              behavior,
              cameraProfileIds:
                binding.cameraProfileIds.length > 0
                  ? binding.cameraProfileIds
                  : cameraProfileIds,
            }
          : {
              id: crypto.randomUUID(),
              sourceIdentity,
              displayName: plan.displayName,
              behavior,
              cameraProfileIds,
              markerState: sourceIdentity.markerUuid
                ? ("written" as const)
                : ("unknown" as const),
              lastSeenAtUnixMs: plan.updatedAtUnixMs,
            };
        return {
          ...current,
          local: {
            ...current.local,
            sourceBindings: binding
              ? current.local.sourceBindings.map((candidate) =>
                  candidate.id === binding.id ? nextBinding : candidate,
                )
              : [...current.local.sourceBindings, nextBinding],
          },
        };
      });
      if (!settingsStore) setSettings(response.settings);
      setMessage(
        behavior === "autoImport"
          ? l(
              "Automatic copying is enabled for this card.",
              "Automatyczne kopiowanie jest włączone dla tej karty.",
            )
          : l("Card behavior was saved.", "Zapisano zachowanie karty."),
      );
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plans-panel">
      <div className="panel-heading">
        <div>
          <p className="section-label">{l("SAVED WORK", "ZAPISANA PRACA")}</p>
          <h2>{l("Import plans", "Plany importu")}</h2>
        </div>
        <button
          type="button"
          className="danger-quiet"
          disabled={busy || groups.disconnected.length === 0}
          onClick={() => void removeDisconnected()}
        >
          {l("Delete all disconnected", "Usuń wszystkie odłączone")}
        </button>
      </div>
      {message && (
        <p className="import-error" role="alert">
          {message}
        </p>
      )}
      {deleteFailure && (
        <div className="plans-delete-error" role="alert">
          <span>{deleteFailure.message}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void performDelete(deleteFailure.retry)}
          >
            {l("Try again", "Spróbuj ponownie")}
          </button>
        </div>
      )}
      {visiblePlanCount === 0 && (
        <section className="plans-empty">
          <h3>{l("No saved plans", "Brak zapisanych planów")}</h3>
          <p>
            {l(
              "Plans created after scanning a card will appear here.",
              "Tutaj pojawią się plany utworzone po skanowaniu karty.",
            )}
          </p>
        </section>
      )}
      <PlanGroup
        title={l("Active", "Aktywne")}
        plans={groups.active}
        busy={busy}
        onOpen={open}
        onRemove={remove}
        settings={activeSettings}
        onBehaviorChange={updateBehavior}
        l={l}
      />
      <PlanGroup
        title={l("Ignored", "Pominięte")}
        plans={groups.ignored}
        busy={busy}
        onOpen={open}
        onRemove={remove}
        settings={activeSettings}
        onBehaviorChange={updateBehavior}
        l={l}
      />
      <PlanGroup
        title={l("Disconnected", "Odłączone")}
        plans={groups.disconnected}
        busy={busy}
        onOpen={open}
        onRemove={remove}
        settings={activeSettings}
        onBehaviorChange={updateBehavior}
        l={l}
      />
      <PlanGroup
        title={l("Needs attention", "Wymagające uwagi")}
        plans={groups.errors}
        busy={busy}
        onOpen={open}
        onRemove={remove}
        settings={activeSettings}
        onBehaviorChange={updateBehavior}
        l={l}
        error
      />
    </div>
  );
}

function PlanGroup({
  title,
  plans,
  busy,
  onOpen,
  onRemove,
  settings,
  onBehaviorChange,
  l,
  error = false,
}: {
  title: string;
  plans: PendingSourceWorkflow[];
  busy: boolean;
  onOpen: (plan: PendingSourceWorkflow) => void;
  onRemove: (plan: PendingSourceWorkflow) => void;
  settings: AppSettings | null;
  onBehaviorChange: (
    plan: PendingSourceWorkflow,
    behavior: SourceBehavior,
  ) => void;
  l: (en: string, pl: string) => string;
  error?: boolean;
}) {
  if (plans.length === 0) return null;
  return (
    <section className="plan-group">
      <h3>
        {title} <span>{plans.length}</span>
      </h3>
      <div className="source-list">
        {plans.map((plan) => {
          const needsRecalculation = Boolean(
            settings &&
            plan.plan &&
            plan.settingsRevision !== importPlanSettingsRevision(settings),
          );
          return (
            <article
              className={`source-card${error || needsRecalculation || plan.plan?.status === "requiresDecision" ? " source-card--error" : ""}`}
              key={plan.sourceId}
            >
              <div className="source-card__icon" aria-hidden="true">
                SD
              </div>
              <div className="source-card__details">
                <div className="source-card__title">
                  <h3>
                    {plan.displayName ||
                      l("Identified card", "Zidentyfikowana karta")}
                  </h3>
                  <span className="known-badge">
                    {needsRecalculation
                      ? l("Recalculation required", "Wymaga przeliczenia")
                      : stateLabel(plan.state, l)}
                  </span>
                </div>
                <p>{plan.sourceId}</p>
                {plan.plan && (
                  <small>
                    {plan.plan.fileCount} {l("files", "plików")} ·{" "}
                    {formatBytes(plan.plan.totalSizeBytes)} ·{" "}
                    {plan.plan.conflicts.length} {l("conflicts", "konfliktów")}
                  </small>
                )}
                {plan.error && (
                  <small className="import-error">{plan.error}</small>
                )}
                {needsRecalculation && (
                  <small className="import-error">
                    {l(
                      "The library or other plan settings changed. Open the plan and recalculate it before importing.",
                      "Biblioteka lub inne ustawienia planu uległy zmianie. Otwórz plan i przelicz go przed importem.",
                    )}
                  </small>
                )}
              </div>
              <div className="source-card__actions">
                <label className="plan-automation">
                  <span>{l("Automation", "Automatyzacja")}</span>
                  <select
                    aria-label={l(
                      `Automation for ${plan.displayName}`,
                      `Automatyzacja dla ${plan.displayName}`,
                    )}
                    value={behaviorForPlan(settings, plan)}
                    disabled={busy || !settings || !plan.sourceIdentity}
                    onChange={(event) =>
                      void onBehaviorChange(
                        plan,
                        event.target.value as SourceBehavior,
                      )
                    }
                  >
                    <option value="ask">{l("Ask", "Pytaj")}</option>
                    <option value="autoPreparePlan">
                      {l("Prepare plan", "Przygotuj plan")}
                    </option>
                    <option
                      value="autoImport"
                      disabled={
                        needsRecalculation ||
                        !plan.sourceIdentity?.markerUuid ||
                        (plan.plan?.conflicts.length ?? 0) > 0
                      }
                    >
                      {l("Copy automatically", "Kopiuj automatycznie")}
                    </option>
                    <option value="ignore">{l("Ignore", "Ignoruj")}</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || !plan.scan}
                  onClick={() => void onOpen(plan)}
                >
                  {l("Details", "Szczegóły")}
                </button>
                <button
                  type="button"
                  className="danger-quiet"
                  disabled={busy}
                  onClick={() => void onRemove(plan)}
                >
                  {l("Delete", "Usuń")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function bindingForPlan(settings: AppSettings, plan: PendingSourceWorkflow) {
  if (!plan.sourceIdentity) return undefined;
  return settings.local.sourceBindings.find((binding) => {
    const left = binding.sourceIdentity;
    const right = plan.sourceIdentity!;
    if (left.markerUuid && right.markerUuid)
      return left.markerUuid === right.markerUuid;
    if (left.platformVolumeId && right.platformVolumeId)
      return left.platformVolumeId === right.platformVolumeId;
    return (
      !left.markerUuid &&
      !right.markerUuid &&
      !left.platformVolumeId &&
      !right.platformVolumeId &&
      left.fallbackFingerprint === right.fallbackFingerprint
    );
  });
}

function behaviorForPlan(
  settings: AppSettings | null,
  plan: PendingSourceWorkflow,
): SourceBehavior {
  return settings ? (bindingForPlan(settings, plan)?.behavior ?? "ask") : "ask";
}

function cameraProfileIdsForPlan(
  settings: AppSettings,
  plan: PendingSourceWorkflow,
): string[] {
  const knownProfileIds = new Set(
    settings.portable.cameraProfiles.map((profile) => profile.id),
  );
  const profileIds = new Set(
    Object.values(plan.editor.itemProfileAssignments).filter((profileId) =>
      knownProfileIds.has(profileId),
    ),
  );

  for (const item of plan.scan?.scan.items ?? []) {
    if (item.cameraMetadataConflict) continue;
    const profile = profileForIdentity(settings, item.cameraIdentity);
    if (profile) profileIds.add(profile.id);
  }

  return [...profileIds];
}

function profileForIdentity(
  settings: AppSettings,
  identity: NonNullable<
    PendingSourceWorkflow["scan"]
  >["scan"]["items"][number]["cameraIdentity"],
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

function stateLabel(
  state: PendingSourceWorkflow["state"],
  l: (en: string, pl: string) => string,
) {
  if (state === "disconnected") return l("Disconnected", "Odłączony");
  if (state === "failedRecoverable") return l("Error", "Błąd");
  if (state === "planReady") return l("Ready", "Gotowy");
  if (state === "scanning") return l("Scanning", "Skanowanie");
  if (state === "importing") return l("Importing", "Importowanie");
  if (state === "ignoredUntilDisconnect")
    return l("Ignored until disconnected", "Pominięty do odłączenia");
  return l("In preparation", "W przygotowaniu");
}

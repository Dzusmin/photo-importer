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
  type AppSettings,
  loadSettings,
  normalizeSettingsError,
  saveSettings,
  type SourceBehavior,
} from "../../shared/settings";

export function PlansPanel({ onOpen }: { onOpen: (sourceId: string) => void }) {
  const { i18n } = useTranslation();
  const polish = i18n.resolvedLanguage?.startsWith("pl") ?? false;
  const l = (en: string, pl: string) => (polish ? pl : en);
  const [plans, setPlans] = useState<PendingSourceWorkflow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextPlans, settingsResponse] = await Promise.all([
        listPendingSourceWorkflows(),
        loadSettings(),
      ]);
      setPlans(nextPlans ?? []);
      setSettings(settingsResponse.settings);
      setMessage(null);
    } catch (error) {
      setMessage(normalizeSettingsError(error).message);
    }
  }, []);

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
  }, [reload]);

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
      disconnected: plans.filter((plan) => plan.state === "disconnected"),
      errors: plans.filter((plan) => plan.state === "failedRecoverable"),
    }),
    [plans],
  );

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
    setBusy(true);
    try {
      await deletePendingSourceWorkflow(plan.sourceId);
      await reload();
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
    setBusy(true);
    try {
      await deleteDisconnectedSourceWorkflows();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function open(plan: PendingSourceWorkflow) {
    onOpen(plan.sourceId);
  }

  async function updateBehavior(
    plan: PendingSourceWorkflow,
    behavior: SourceBehavior,
  ) {
    if (!settings || !plan.sourceIdentity) return;
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
      const binding = bindingForPlan(settings, plan);
      const nextBinding = binding
        ? { ...binding, behavior }
        : {
            id: crypto.randomUUID(),
            sourceIdentity: plan.sourceIdentity,
            displayName: plan.displayName,
            behavior,
            cameraProfileIds: [],
            markerState: plan.sourceIdentity.markerUuid
              ? ("written" as const)
              : ("unknown" as const),
            lastSeenAtUnixMs: plan.updatedAtUnixMs,
          };
      const response = await saveSettings({
        ...settings,
        local: {
          ...settings.local,
          sourceBindings: binding
            ? settings.local.sourceBindings.map((candidate) =>
                candidate.id === binding.id ? nextBinding : candidate,
              )
            : [...settings.local.sourceBindings, nextBinding],
        },
      });
      setSettings(response.settings);
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
      {plans.length === 0 && (
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
        settings={settings}
        onBehaviorChange={updateBehavior}
        l={l}
      />
      <PlanGroup
        title={l("Disconnected", "Odłączone")}
        plans={groups.disconnected}
        busy={busy}
        onOpen={open}
        onRemove={remove}
        settings={settings}
        onBehaviorChange={updateBehavior}
        l={l}
      />
      <PlanGroup
        title={l("Needs attention", "Wymagające uwagi")}
        plans={groups.errors}
        busy={busy}
        onOpen={open}
        onRemove={remove}
        settings={settings}
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
        {plans.map((plan) => (
          <article
            className={`source-card${error || plan.plan?.status === "requiresDecision" ? " source-card--error" : ""}`}
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
                <span className="known-badge">{stateLabel(plan.state, l)}</span>
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
        ))}
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

function stateLabel(
  state: PendingSourceWorkflow["state"],
  l: (en: string, pl: string) => string,
) {
  if (state === "disconnected") return l("Disconnected", "Odłączony");
  if (state === "failedRecoverable") return l("Error", "Błąd");
  if (state === "planReady") return l("Ready", "Gotowy");
  if (state === "scanning") return l("Scanning", "Skanowanie");
  if (state === "importing") return l("Importing", "Importowanie");
  return l("In preparation", "W przygotowaniu");
}

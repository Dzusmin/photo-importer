import { useState } from "react";
import type { ActionableError } from "./appStatus";

export function ErrorNotice({
  error,
  onRetry,
  retryLabel = "Spróbuj ponownie",
}: {
  error: ActionableError;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copyDetails() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(error.technicalDetails);
      setCopied(true);
    } catch {
      const field = document.createElement("textarea");
      field.value = error.technicalDetails;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const copiedWithFallback = document.execCommand("copy");
      field.remove();
      setCopied(copiedWithFallback);
    }
  }

  return (
    <div
      className={`operational-error operational-error--${error.kind}`}
      role="alert"
    >
      <div>
        <strong>{error.title}</strong>
        <p>{error.impact}</p>
        <small>{error.action}</small>
      </div>
      {onRetry && (
        <button type="button" className="secondary" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
      <details>
        <summary>Szczegóły techniczne</summary>
        <pre>{error.technicalDetails}</pre>
        <button
          type="button"
          className="ghost"
          onClick={() => void copyDetails()}
        >
          {copied ? "Skopiowano" : "Kopiuj szczegóły"}
        </button>
      </details>
    </div>
  );
}

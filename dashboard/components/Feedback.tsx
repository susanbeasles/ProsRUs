import type { ReactNode } from "react";
import { useNavigationFocusAny } from "../app/context";

/** Loading placeholder: decorative bars plus one announced status line. */
export function Skeleton({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true">
      <p role="status" className="visually-hidden">
        {label}
      </p>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ label, count = 3 }: { label: string; count?: number }) {
  return (
    <div className="cards" aria-busy="true">
      <p role="status" className="visually-hidden">
        {label}
      </p>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="card skeleton-card" aria-hidden="true">
          <span className="skeleton-line short" />
          <span className="skeleton-line" />
          <span className="skeleton-line" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <Skeleton label="Loading this section…" lines={2} />
      <CardsSkeleton label="" count={3} />
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** A failed read or render, with an explicit retry. */
export function ErrorState({ message, onRetry, retryLabel = "Try again" }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  const ref = useNavigationFocusAny<HTMLDivElement>();
  return (
    <div className="error" role="alert" ref={ref} tabIndex={-1}>
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** An action that exists in the product but is deliberately not enabled; never a silent button. */
export function NotEnabled({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="not-enabled" role="note" aria-label={title + " (not enabled)"}>
      <p className="eyebrow">NOT ENABLED</p>
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Workspace read failed";
  if (error.message === "invalid-shared-value" || error.message === "shared-value-too-large")
    return "The workspace returned data that does not match the shared catalog.";
  return error.message;
}

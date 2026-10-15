import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { ReadSession } from "../lib/api";
import { useAuthority, useQuery, useWorkspace } from "../lib/hooks";
import { reads } from "../lib/queries";
import { GRANT_EXPIRED, GRANT_REQUIRED } from "../lib/workspace";
import { ErrorState, errorMessage, Skeleton } from "../components/Feedback";
import { useNavigationFocusAny, useRoute } from "./context";

const SessionContext = createContext<ReadSession | null>(null);

export function useSession(): ReadSession {
  const session = useContext(SessionContext);
  if (!session) throw Error("Session context missing");
  return session;
}

const MAX_TIMER_MS = 2_147_483_647;

/** The grant/sign-in message; data views are not rendered while it is shown. */
export function AccessMessage({ message, cancelled = 0 }: { message: string; cancelled?: number }) {
  const ref = useNavigationFocusAny<HTMLDivElement>();
  return (
    <div className="access" ref={ref} tabIndex={-1}>
      <p className="error" role="alert">
        {message}
      </p>
      {cancelled > 0 && (
        <p role="status">
          {cancelled === 1 ? "1 pending change was" : `${cancelled} pending changes were`} cancelled when workspace authority
          ended. A change that had already been sent may still have been saved; check it after selecting a current grant.
        </p>
      )}
      <p>
        <a href="/owner/job-stack">Choose workspace grant</a>
      </p>
    </div>
  );
}

/**
 * Renders children only for a selected grant with a current, unexpired session. Expiry, 401/403 or
 * a missing grant clear the workspace and show the grant message instead.
 */
export function AuthorityGate({ children }: { children: ReactNode }) {
  const route = useRoute();
  const workspace = useWorkspace();
  const authority = useAuthority();
  const active = route.grant !== "" && authority.status === "active";
  const session = useQuery(active ? reads.session() : null);
  const data = session.data;
  const expired = data !== undefined && data.expiresAtMs <= workspace.services.now();
  useEffect(() => {
    if (!data) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const remaining = data.expiresAtMs - workspace.services.now();
      if (remaining <= 0) workspace.loseAuthority(GRANT_EXPIRED);
      else timer = setTimeout(check, Math.min(remaining, MAX_TIMER_MS));
    };
    check();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [workspace, data]);
  if (!route.grant) return <AccessMessage message={GRANT_REQUIRED} />;
  if (authority.status === "lost") return <AccessMessage message={authority.message} cancelled={authority.cancelled} />;
  if (expired) return <AccessMessage message={GRANT_EXPIRED} />;
  if (data) return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>;
  if (session.status === "error") return <ErrorState message={errorMessage(session.error)} onRetry={session.refetch} />;
  return <Skeleton label="Checking the selected workspace grant…" lines={2} />;
}

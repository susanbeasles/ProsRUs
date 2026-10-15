import { lazy, Suspense } from "react";
import { Skeleton } from "./Feedback";

const RecoveryStatusPanel = lazy(() => import("./RecoveryStatus"));

/** Backup status in its own chunk, with a skeleton while the chunk loads. */
export function LazyRecoveryStatus() {
  return (
    <Suspense
      fallback={
        <section className="panel recovery">
          <Skeleton label="Loading backup status…" lines={2} />
        </section>
      }
    >
      <RecoveryStatusPanel />
    </Suspense>
  );
}

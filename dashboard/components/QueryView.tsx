import type { ReactNode } from "react";
import type { QueryState } from "../lib/hooks";
import { ErrorState, errorMessage } from "./Feedback";

/**
 * Loading -> skeleton, failure without data -> error with retry, empty -> empty state, data ->
 * children. Data kept during a failed revalidation stays visible with an inline notice.
 */
export function QueryView<T>({
  state,
  loading,
  empty,
  isEmpty,
  children,
}: {
  state: QueryState<T>;
  loading: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (state.data !== undefined)
    return (
      <>
        {state.status === "error" && (
          <ErrorState message={"Showing earlier data. " + errorMessage(state.error)} onRetry={state.refetch} />
        )}
        {empty !== undefined && isEmpty?.(state.data) ? empty : children(state.data)}
      </>
    );
  if (state.status === "error") return <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />;
  return <>{loading}</>;
}

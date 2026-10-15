import type { ComponentType, ReactNode } from "react";
import { objectFields, type ReadRecord, type RecordPage } from "../lib/api";
import { firstText } from "../lib/format";
import { useQuery, useWorkspace } from "../lib/hooks";
import { isPendingId } from "../lib/optimistic";
import { keys, reads } from "../lib/queries";
import type { Option, Overrides } from "../lib/schemaForm";
import type { Workspace } from "../lib/workspace";
import { Skeleton } from "./Feedback";
import { QueryView } from "./QueryView";

type Children = { children: (extra: Overrides) => ReactNode };
export type ChoiceLoader = ComponentType<Children>;

/** Choices from the first server page; labels use details already cached, otherwise the id. */
function choices(workspace: Workspace, kind: string, page: RecordPage, titles: readonly string[]): Option[] {
  return page.items
    .filter((item) => !isPendingId(item.entityId))
    .map((item) => {
      const row = workspace.cache.peek<ReadRecord>(keys.record(kind, item.entityId));
      const body = row?.bodyStatus === "available" ? objectFields(row.body) : null;
      const title = firstText(body, titles);
      return { value: item.entityId, label: title ? `${title} (${item.entityId})` : item.entityId };
    });
}

function makeChoices(kind: string, field: string, titles: readonly string[], noun: string, extra: (options: Option[], more: boolean) => Overrides[string]): ChoiceLoader {
  function Choices({ children }: Children) {
    const workspace = useWorkspace();
    const state = useQuery(reads.records(kind, null));
    return (
      <QueryView state={state} loading={<Skeleton label={`Loading ${noun}…`} lines={2} />}>
        {(page) => {
          const options = choices(workspace, kind, page, titles);
          return children(options.length ? { [field]: extra(options, page.nextCursor !== null) } : {});
        }}
      </QueryView>
    );
  }
  Choices.displayName = `${kind}Choices`;
  return Choices;
}

export const ClaimChoices = makeChoices("claim", "claimIds", ["field", "text"], "claims", (options, more) => ({
  widget: "checkboxes",
  options,
  help:
    "Only claims you confirmed or that sources support, and that are permitted in applications, can be included; the server rejects others." +
    (more ? " Showing the first page of claims." : ""),
}));
export const OpportunityChoices = makeChoices("opportunity", "opportunityId", ["company", "role"], "opportunities", (options, more) => ({
  options,
  help: more ? "Showing the first page of opportunity records." : undefined,
}));
export const PacketChoices = makeChoices("packet", "packetId", ["company", "role"], "packets", (options, more) => ({
  options,
  help: more ? "Showing the first page of packets." : undefined,
}));
export const ThreadChoices = makeChoices("thread", "threadId", ["subject"], "conversations", (options) => ({ options }));

export function combineLoaders(...loaders: ChoiceLoader[]): ChoiceLoader {
  function Combined({ children }: Children) {
    const render = (index: number, acc: Overrides): ReactNode => {
      const Loader = loaders[index];
      if (!Loader) return children(acc);
      return <Loader>{(extra) => render(index + 1, { ...acc, ...extra })}</Loader>;
    };
    return <>{render(0, {})}</>;
  }
  return Combined;
}

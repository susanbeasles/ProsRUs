import type { Principal, Settings, Opportunity } from "../domain/model";
import type { Store, RecordValue, Intent } from "../storage/store";
import type { Dependencies } from "./service";
import type { Operation } from "./contracts";
export type OperationRequest = {
  actor: Principal;
  raw: unknown;
  now: number;
  operation: Operation;
};
export type OperationDependencies = {
  store: Store;
  owner: string;
  deps: Dependencies;
  settings: () => Promise<{ value: Settings; revision: number }>;
  opportunity: (
    id: string,
  ) => Promise<{ record: RecordValue; value: Opportunity }>;
  requirePacket: (id: string, opportunityId: string) => Promise<unknown>;
  reserve: (kind: string, id: string, payload: unknown) => Promise<Intent>;
  invoke: (
    actor: Principal,
    operation: Operation,
    input: unknown,
  ) => Promise<unknown>;
};

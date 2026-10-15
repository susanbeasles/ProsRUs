import type { Dispatch, SetStateAction } from "react";
import type { Field } from "./Form";
import type { Row, Snapshot } from "./api";
export type Modal = {
  title: string;
  fields: Field[];
  submit: (values: Record<string, string>) => Promise<void>;
};
export type PageProps = {
  data: Snapshot;
  opportunities: Row[];
  current: Row | undefined;
  value: Record<string, unknown> | null;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setSection: Dispatch<SetStateAction<string>>;
  capture: () => void;
  open: (
    title: string,
    fields: Field[],
    operation: string,
    transform?: (values: Record<string, string>) => unknown,
  ) => void;
  opportunityField: Field;
  threadField: Field;
  setModal: Dispatch<SetStateAction<Modal | null>>;
  refresh: () => Promise<void>;
};

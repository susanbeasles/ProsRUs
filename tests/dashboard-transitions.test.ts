import { expect, it } from "vitest";
import { states } from "../src/domain/model";
import { transition } from "../src/domain/rules";
import { allowedTransitions, OPPORTUNITY_STATES, requiresConfirmation } from "../dashboard/lib/opportunity";

it("offers states exactly as the catalog and the domain model declare them", () => {
  expect([...OPPORTUNITY_STATES]).toEqual([...states]);
});

it("mirrors the domain transition table for every pair (only allowed transitions are offered)", () => {
  for (const from of states)
    for (const to of states) {
      let allowed = true;
      try {
        transition({ from, to, evidence: "evidence", confirmed: true });
      } catch (error) {
        expect((error as { code?: string }).code).toBe("INVALID_TRANSITION");
        allowed = false;
      }
      expect(allowedTransitions(from).includes(to), `${from} -> ${to}`).toBe(allowed);
    }
});

it("requires confirmation exactly where the domain does", () => {
  for (const from of states)
    for (const to of allowedTransitions(from)) {
      let needs = false;
      try {
        transition({ from, to: to as (typeof states)[number], evidence: "evidence", confirmed: false });
      } catch (error) {
        expect((error as { code?: string }).code).toBe("CONFIRMATION_REQUIRED");
        needs = true;
      }
      expect(requiresConfirmation(to), `${from} -> ${to}`).toBe(needs);
    }
});

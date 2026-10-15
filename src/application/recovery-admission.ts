import { demand } from "../domain/model";
import type { RecoveryIntakeBudget } from "./recovery-ports";

/** Bind exactly once for a host lifecycle and share across all intake factories.
 * Reserves 32 MiB per chunk for source/storage/readback copies and overhead, 16 MiB
 * per finalization, and 512 KiB per metadata operation. These admissions bound work;
 * actual deployed peak memory/CPU still requires measurement before activation. */
export function createRecoveryIntakeBudget(): RecoveryIntakeBudget {
  const reservations = {
    chunk: 32 * 1024 * 1024,
    finalize: 16 * 1024 * 1024,
    metadata: 512 * 1024,
  };
  const limits = { chunk: 2, finalize: 1, metadata: 8 };
  const active = { chunk: 0, finalize: 0, metadata: 0 };
  let reservedBytes = 0;
  return {
    async run(kind, work) {
      const reservation = reservations[kind];
      demand(
        reservation !== undefined &&
          active[kind] < limits[kind] &&
          reservedBytes + reservation <= 84 * 1024 * 1024,
        "INTAKE_CAPACITY_EXCEEDED",
        429,
      );
      active[kind]++;
      reservedBytes += reservation;
      try {
        return await work();
      } finally {
        active[kind]--;
        reservedBytes -= reservation;
      }
    },
  };
}

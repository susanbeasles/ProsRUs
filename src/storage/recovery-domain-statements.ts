import type { DomainEffects } from "../domain/recovery-domain-plan";
import { canonicalizeEnvelope } from "../domain/recovery-canonical";
import { demand } from "../domain/model";

/** Only finite, already validated effects become SQL. Read guards are enforced by
 * recovery_domain_guard inside this same batch, before any history/chain write. */
export function domainStatements(
  db: D1Database,
  owner: string,
  effects: DomainEffects | undefined,
): D1PreparedStatement[] {
  if (!effects) return [];
  const statements: D1PreparedStatement[] = [];
  for (const mutation of effects.plan.mutations) {
    const candidate = effects.plan.candidates.find(
      (c) => c.role === mutation.candidateRole,
    );
    demand(candidate, "DOMAIN_EFFECT_BIJECTION_MISMATCH");
    const record = candidate.snapshot;
    const body = new TextDecoder().decode(canonicalizeEnvelope(record.body));
    if (mutation.mode === "insert")
      statements.push(
        db
          .prepare(
            "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            owner,
            record.recordKind,
            record.entityId,
            body,
            record.revision,
            record.updatedAt,
          ),
      );
    else if (mutation.mode === "update")
      statements.push(
        db
          .prepare(
            "UPDATE records SET body=?,revision=?,updated_at=? WHERE owner=? AND kind=? AND id=?",
          )
          .bind(
            body,
            record.revision,
            record.updatedAt,
            owner,
            record.recordKind,
            record.entityId,
          ),
      );
  }
  for (const source of effects.plan.sourceKeys)
    if (source.mode === "insert")
      statements.push(
        db
          .prepare(
            "INSERT INTO source_keys(owner,source_key,opportunity_id) VALUES(?,?,?)",
          )
          .bind(owner, source.sourceKey, source.opportunityId),
      );
  for (const audit of effects.plan.audit)
    statements.push(
      db
        .prepare(
          "INSERT INTO audit(id,owner,actor,operation,object_id,decision,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          audit.eventId,
          owner,
          audit.actorId,
          audit.operation,
          audit.entityId,
          audit.decision,
          audit.createdAt,
        ),
    );
  return statements;
}

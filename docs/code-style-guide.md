# Engineering rules

Model domain concepts and invariants before framework plumbing. Give values and operations precise names. Keep modules cohesive, functions focused, effects explicit and deterministic transformations independently testable. Prefer existing conventions over cosmetic churn.

- Supply changing values, clocks and capabilities at visible boundaries.
- Validate untrusted configuration, protocol input and stored records. Types do not replace runtime checks.
- Preserve strict object shapes, unknown-field denial, scalar encoding and historical serialized bytes.
- Keep absence distinct from an invented default. Invalid authority/configuration fails closed.
- Reuse a capability when meaning, permissions and failure behavior agree; do not copy workflows or build speculative frameworks.
- Bound bytes, rows, depth, queries and external effects before materialization or mutation.
- Use actual failing assertions before changing behavior, then the smallest implementation and affected regression checks.
- Make atomicity, retry identity and ambiguous outcomes explicit. Never retry an uncertain external action blindly.
- Regenerate maintained projections/types/identities through their actual generators.
- Preserve original custody and exact before/after evidence for reversible changes.
- Keep private inputs, internal evidence, dependencies and caches outside source composition.
- Report observed tests and remaining acceptance honestly. Preserve licenses and public attribution.

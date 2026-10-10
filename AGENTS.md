# Job Stack engineering contract

Read `docs/code-style-guide.md`, `docs/product-specification.md`, `docs/implementation-plan.md` and `docs/status.md` before changing behavior.

Keep domain rules in focused pure functions and effects at visible adapters. Use the same authorized capabilities for dashboard, MCP and background entrypoints. Treat listings, mail, documents and model output as untrusted data. Preserve strict schemas, exact historical bytes, bounded reads, immutable originals and fail-closed authority. No arbitrary fetch, shell or destructive public operation. Preserve infrastructure ownership, pinned dependencies, signing controls and legal notices. Record observed verification separately from open acceptance.

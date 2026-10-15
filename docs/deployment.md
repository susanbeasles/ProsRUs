# Deployment and private configuration boundaries

Production is a private named `JobStack` capability of canonical Control. The default Worker returns 404; public workers.dev/preview ingress, cron and queue effects remain disabled in the preserved staging overlay. Do not deploy the loopback-only development entrypoint.

Use existing resource ownership, encrypted state, reviewed plans, committed locks and signing/release controls. Adopt existing resources rather than recreating them. Select exact account/workspace/provider mappings and obtain action-time approval before infrastructure, credentials, policy, grants or deployment changes. Source cleanup applies no live configuration.

Control receives canonical owner contacts through private `OWNER_EMAILS`, checked as exact unique lowercase ASCII addresses. No source default is provided. Reconciliation requires an explicit absolute `CONTROL_OWNER_CONFIG_PATH` pointing outside source to `{format: "control-owner-contacts-v1", emails: [...]}`. This is private data, not a tracked config example containing real contacts.

Product receives a private `AUDITED_SOURCE_PROFILE` serialized checked profile, at most 5000 UTF-8 bytes. LOCAL utility configuration requires an absolute private `profilePath` outside source; file/API parsing allows 16384 bytes but runtime binding still has the smaller admission. No truncation, source fallback, public selector or alternate metadata storage is provided.

The source overlay declares the reciprocal `CONTROL_AUTHORITY` service binding to `personal-control` / `JobStackAuthority`. This is a composition requirement, not evidence that the named entrypoint is deployed or that a workspace grant exists. The Product still exposes no public data route. The configuration generator accepts only bounded reviewed Terraform references, preserves any existing authority service binding, and keeps queue consumers, crons, workers.dev and preview ingress disabled. Generating configuration neither creates resources nor authorizes deployment.

See [read-first intake](read-first-milestone.md) for identity/time/byte requirements. Actual production admission is a separate gate. Preserve original data and pending receipts; do not retime/reimport retained originals or mistake LOCAL observation time for production authority. Browser, OAuth, provider/device, clean-install and live deployment evidence must be recorded independently.

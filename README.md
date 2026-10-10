ProsRUs
An AI-assisted career workspace for managing job opportunities, interview preparation, professional profiles, and career history.
Planned capabilities
- Approve opportunities before outreach or scheduling
- Track recruiting conversations, interviews, notes, and next steps
- Maintain evidence-backed résumé and profile versions
- Preserve version history with verifiable recovery and backups
Architecture
- GitHub: application source and infrastructure configuration
- Cloudflare Workers, D1, and R2: application runtime and storage
- AnthonyVespoli.com: intended authenticated application domain
- Shared control plane: authentication and scoped authorization
- workflow_depot: reusable validation and independent authorization
- delivery_control: centralized release archival and deployment
Status
Under active development. Production deployment, signing integration, and end-to-end recovery validation are not complete.
Data handling
Recruiting records, résumés, transcripts, credentials, and other private runtime data must not be committed to this repository.

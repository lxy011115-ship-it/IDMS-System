# IDMS MVP Architecture

Current checkpoint (2026-10-15): the complete local platform now uses actual Keycloak/OIDC/PKCE, verified tenant claims and realm roles, PostgreSQL tenant databases, and an independent engineering-rule predictor. See `authentication-guide.md` and `scheme-a-development-status.md`. The file/demo and target descriptions below are historical background, not a claim that every integration or scalable production store is finished.

## Boundaries

- `server/index.ts`: versioned HTTP API, tenant context, idempotency and transport validation.
- `server/service.ts`: workflow invariants for AI review and final human approval.
- `server/audit.ts`: append-only tenant hash chain and verification.
- `server/store.ts`: replaceable demo repository seeded with discrete-manufacturing data.
- `src/`: operations-focused Vue workbench consuming only `/api/v1` contracts.

## Data flow

Initial deployment uses manual CSV/XLSX uploads and a shared batch-ingestion boundary. Files and future JSON uploads are archived, normalized into tenant staging tables, validated and deduplicated, reviewed by AI or a human fallback, and finally approved by a separate authorized human. Only the approved frozen snapshot is committed transactionally into business records; an outbox schedules reporting. Dashboard freshness reflects uploaded business time, not real-time equipment connectivity.

The upload demo is implemented in `server/imports.ts`, `server/import-api.ts` and `public/manual.js`. It supports CSV/XLSX/JSON, validation, deduplication, independent approval, reporting and a serialized local snapshot with atomic file replacement in `.demo-data/local/imports.json`. AI is explicitly simulated; production OIDC, tenant databases, mapping/correction workflows, background workers and outbox remain future replacements. See `demo-upload-guide.md` for the tested subset. Later, read-only telemetry adapters publish to MQTT and a telemetry service writes TimescaleDB. These adapters preserve device identity, event-time semantics and lineage. AI never performs final responsibility actions.

## Production replacement points

The in-memory store is intentionally behind domain services. Production work adds a control-plane database plus one PostgreSQL database per tenant, TimescaleDB hypertables for telemetry, MinIO prefixes for tenant files, and tenant-specific OpenSearch indexes. Keycloak replaces demonstration headers at the gateway, while preserving the same tenant and actor context passed to domain services.

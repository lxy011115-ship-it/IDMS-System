# IDMS Sales Demo Design

## Purpose

Create a sales-ready, interactive IDMS workbench for discrete-manufacturing prospects. The first screen must demonstrate operational value immediately while retaining real workflow behavior. The demo is not a marketing landing page.

## Audience and demo outcome

- Primary: enterprise executives, equipment/production/quality managers, IT/OT leads.
- Outcome: within 8-12 minutes, demonstrate asset visibility, AI-assisted alarm handling, mandatory human final approval, tenant template reuse, integration readiness, and immutable traceability.
- Success: a presenter can run the full storyline without setup or external infrastructure.

## Experience

- Add a persistent demo mode banner with current scenario, progress, reset, and guided next action.
- Enhance the overview with business value signals: OEE improvement, reduced unplanned downtime, maintenance compliance, and data completeness.
- Provide a guided scenario: detect spindle vibration alarm, review AI evidence, approve closure, then open the audit chain.
- Add an integration readiness view for PostgreSQL/TimescaleDB, Keycloak, MQTT/OPC UA, Flowable, AI gateway, ERP/MES/QMS and deployment modes.
- Expand template and plugin views to show reusable industry templates, enterprise overrides, signed adapters, and deployment portability.
- Label all figures as demonstration data and avoid claims that imply measured customer outcomes.

## Behavior and safety

- Reuse existing `/api/v1` endpoints and approval invariants.
- Demo reset restarts the in-memory scenario without changing production design contracts.
- AI cannot close alarms; human approval remains mandatory.
- Every AI and human action remains visible in the tenant audit chain.
- No PLC write/control capability is introduced.

## Document deliverable

Create a Word implementation-readiness guide containing: preparation checklist, responsible roles, PostgreSQL/TimescaleDB, Keycloak, MQTT/OPC UA, Flowable, AI gateway, infrastructure/network, phased handover list, acceptance checklist, and structured collection templates. Use a formal business-reference layout and clearly separate test credentials from production secrets.

## Verification

- Existing domain tests continue to pass.
- Add API coverage for demo reset and integration status.
- Verify all main navigation views through HTTP-delivered assets.
- Verify desktop/mobile CSS structurally; browser screenshots are attempted only if local-browser security permits.
- Run DOCX structural, table geometry, accessibility, and render QA. If LibreOffice is unavailable, disclose the visual-render limitation.

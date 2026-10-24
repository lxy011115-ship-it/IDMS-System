import type {TenantPayload} from './entity-repository.ts';
import type {PublicGovernedSource} from './source-governance.ts';
import type {TelemetryDomainControl} from './telemetry-map-v4.ts';
import {encodeGovernanceCandidateV4} from './governance-plan-v4.ts';
import {compileFieldAdmissionMapV1} from './field-admission-map-v1.ts';
import type {LegacyEntry} from './legacy-map-v4.ts';
export {governanceBasicAccessV4,governanceCommandAccessV4,prepareGovernancePayloadV4} from './governance-plan-v4.ts';
export type {GovernanceCommandV4} from './governance-plan-v4.ts';

/** Same candidate root: source governance, field admission and the new anchor publish together. */
export function* encodeGovernanceCandidateV5(after:TenantPayload,previousAuditCount:number,control:TelemetryDomainControl,sources:readonly PublicGovernedSource[]):Generator<LegacyEntry>{
  yield* encodeGovernanceCandidateV4(after,previousAuditCount,control,sources);
  yield* compileFieldAdmissionMapV1(after,control.tenantId).entries;
}

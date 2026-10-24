import type {TenantPayload} from './entity-repository.ts';
import type {PublicGovernedSource} from './source-governance.ts';
import type {TelemetryDomainControl} from './telemetry-map-v4.ts';
import type {LegacyEntry} from './legacy-map-v4.ts';
import {encodeGovernanceCandidateV5} from './governance-plan-v5.ts';
import {compileFieldRuntimeMapV1} from './field-runtime-map-v1.ts';
export {governanceBasicAccessV4,governanceCommandAccessV4,prepareGovernancePayloadV4} from './governance-plan-v4.ts';
export type {GovernanceCommandV4} from './governance-plan-v4.ts';
export function* encodeGovernanceCandidateV6(after:TenantPayload,previousAuditCount:number,control:TelemetryDomainControl,sources:readonly PublicGovernedSource[]):Generator<LegacyEntry>{
 yield* encodeGovernanceCandidateV5(after,previousAuditCount,control,sources);
 yield* compileFieldRuntimeMapV1(after,control.tenantId);
}

import {canonical,digest} from './imports.ts';
import {object,keys} from './schema-primitives.ts';
import {validateFrozenCoverageInput,computeFrozenCoverageV1,frozenCoverageIntegrity,type FrozenCoverageInput} from './frozen-coverage-v1.ts';
import {receiptVerificationVersion} from './receipt-identity-v2.ts';

export const frozenCoverageVersionV2='frozen-sample-coverage-2.0.0' as const;
export type FrozenCoverageInputV2=Omit<FrozenCoverageInput,'format'>&{format:'idms-coverage-input-v2';receiptVerificationVersion:typeof receiptVerificationVersion};
export function coverageV2MathInput(raw:unknown):FrozenCoverageInput{
 try{const v=object(raw);keys(v,['format','receiptVerificationVersion','tenantId','deviceCode','source','query','imports','telemetry','registry','calendarContext']);if(v.format!=='idms-coverage-input-v2'||v.receiptVerificationVersion!==receiptVerificationVersion)throw Error();const {receiptVerificationVersion:ignored,...rest}=v;return validateFrozenCoverageInput({...rest,format:'idms-coverage-input-v1'});}catch{throw frozenCoverageIntegrity();}
}
export function validateFrozenCoverageInputV2(raw:unknown):FrozenCoverageInputV2{coverageV2MathInput(raw);return raw as FrozenCoverageInputV2;}
export function computeFrozenCoverageV2(raw:FrozenCoverageInputV2){
 const input=coverageV2MathInput(raw),result=computeFrozenCoverageV1(input);return {...result,ruleVersion:frozenCoverageVersionV2,receiptVerificationVersion,receiptVerification:'PERSISTED_UUID_EQUIVALENT_ORIGINAL_BINDING_NOT_HISTORICAL_HMAC'};
}
const freeze=(v:unknown):void=>{if(!v||typeof v!=='object'||Object.isFrozen(v))return;for(const x of Object.values(v))freeze(x);Object.freeze(v);};
export function freezeCoveragePayloadV2(raw:FrozenCoverageInputV2){
 validateFrozenCoverageInputV2(raw);const input=JSON.parse(JSON.stringify(raw)) as FrozenCoverageInputV2;if(canonical(input)!==canonical(raw))throw frozenCoverageIntegrity();const result=computeFrozenCoverageV2(input),payload={format:'idms-coverage-report-v2' as const,input,result,inputDigest:digest(canonical(input)),resultDigest:digest(canonical(result))};freeze(payload);return payload;
}
export function verifyCoveragePayloadV2(raw:unknown){
 try{const p=object(raw);keys(p,['format','input','result','inputDigest','resultDigest']);if(p.format!=='idms-coverage-report-v2'||canonical(p)!==canonical(freezeCoveragePayloadV2(p.input as FrozenCoverageInputV2)))throw Error();return raw as ReturnType<typeof freezeCoveragePayloadV2>;}catch{throw frozenCoverageIntegrity();}
}

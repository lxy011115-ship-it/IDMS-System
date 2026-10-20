import {canonical,digest} from './imports.ts';
import {object,keys} from './schema-primitives.ts';
import {qualityPolicyIntegrity,type QualityPolicyContext} from './quality-policy-history.ts';
import {evaluateQualityPolicy} from './quality-policy-evaluation.ts';
import {coverageV2MathInput,validateFrozenCoverageInputV2,frozenCoverageVersionV2,type FrozenCoverageInputV2} from './frozen-coverage-v2.ts';
import {receiptVerificationVersion} from './receipt-identity-v2.ts';

export const policyEvaluationVersionV2='governed-data-quality-2.0.0' as const;
export function evaluateQualityPolicyV2(raw:FrozenCoverageInputV2,context:QualityPolicyContext){const result=evaluateQualityPolicy(coverageV2MathInput(raw),context);return {...result,ruleVersion:policyEvaluationVersionV2,coverageRuleVersion:frozenCoverageVersionV2,receiptVerificationVersion,receiptVerification:'PERSISTED_UUID_EQUIVALENT_ORIGINAL_BINDING_NOT_HISTORICAL_HMAC'};}
export function qualityEvaluationPackageV2(raw:FrozenCoverageInputV2,policy:QualityPolicyContext){
 validateFrozenCoverageInputV2(raw);const input=JSON.parse(JSON.stringify(raw)) as FrozenCoverageInputV2,context=JSON.parse(JSON.stringify(policy)) as QualityPolicyContext;if(canonical(input)!==canonical(raw)||canonical(context)!==canonical(policy))throw qualityPolicyIntegrity();const result=evaluateQualityPolicyV2(input,context);
 return {format:'idms-quality-policy-evaluation-v2' as const,input,policy:context,result,inputDigest:digest(canonical(input)),policyDigest:digest(canonical(context)),resultDigest:digest(canonical(result)),verification:'SHA_AND_RECOMPUTATION_NOT_AN_EXTERNAL_SIGNATURE' as const};
}
export function verifyQualityEvaluationPackageV2(raw:unknown){
 try{const p=object(raw);keys(p,['format','input','policy','result','inputDigest','policyDigest','resultDigest','verification']);if(p.format!=='idms-quality-policy-evaluation-v2'||canonical(p)!==canonical(qualityEvaluationPackageV2(p.input as FrozenCoverageInputV2,p.policy as QualityPolicyContext)))throw Error();return {consistent:true,ruleVersion:policyEvaluationVersionV2,inputDigest:p.inputDigest,policyDigest:p.policyDigest,resultDigest:p.resultDigest,status:(p.result as {status:string}).status,externalAuthenticity:'NOT_PROVEN',persistentApprovalReport:false};}catch{throw qualityPolicyIntegrity();}
}

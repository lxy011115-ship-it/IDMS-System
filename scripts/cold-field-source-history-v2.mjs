import {resolve,isAbsolute,dirname} from 'node:path';
import {lstat} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {readRuntimeColdReviewWithFieldSourceV2} from './runtime-cold-readonly-control-v7.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {verifyFieldMapFullFieldSourceHistoryV1} from './field-map-full-field-source-history-v1.mjs';

const owners=new WeakMap();
const freeze=value=>{const stack=[value];while(stack.length){const item=stack.pop();if(item&&typeof item==='object'&&!Object.isFrozen(item)){for(const child of Object.values(item))stack.push(child);Object.freeze(item);}}return value;};
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>canonical(a)===canonical(b);

/** Historical SOURCE projection; cannot grant current HELD, SQL or activation. */
export async function readColdFieldSourceHistoryV2(raw,macKey){
  need(exact(raw,['trust','tenantId','publicKeys','workDirectory'])&&typeof raw.tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(raw.tenantId)&&typeof raw.workDirectory==='string'&&isAbsolute(raw.workDirectory)&&raw.workDirectory===resolve(raw.workDirectory),'COLD_FIELD_HISTORY_CONTEXT');
  need(Buffer.isBuffer(macKey)&&macKey.length===32&&!macKey.every(value=>value===0),'COLD_FIELD_HISTORY_MAC_KEY');
  const trust=structuredClone(raw.trust),tenantId=raw.tenantId,key=Buffer.from(macKey);
  try{
    const initial=await readRuntimeColdReviewWithFieldSourceV2(trust),source=initial.source,map=source.fullFacts.databases.find(value=>value.map?.tenantId===tenantId)?.map,fieldMap=source.fieldSource.fieldMaps.find(value=>value.binding.tenantId===tenantId);
    need(map&&fieldMap,'COLD_FIELD_HISTORY_TENANT');
    // Evidence is selected exclusively by the immutable SOURCE, never by a
    // caller's event list, expected facts or alternate evidence-file path.
    const before=await lstat(map.evidenceFile,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n,'COLD_FIELD_HISTORY_SOURCE_FILE');
    need((await coldFileHashV1(map.evidenceFile,2*1024**3)).sha256===map.evidenceSha256,'COLD_FIELD_HISTORY_SOURCE_FILE');
    const projection=await verifyFieldMapFullFieldSourceHistoryV1({file:map.evidenceFile,expectedFacts:map.facts,workDirectory:raw.workDirectory,publicKeys:raw.publicKeys});
    const after=await lstat(map.evidenceFile,{bigint:true});for(const name of ['dev','ino','nlink','size','mtimeNs','ctimeNs'])need(before[name]===after[name],'COLD_FIELD_HISTORY_SOURCE_CHANGED');
    need((await coldFileHashV1(map.evidenceFile,2*1024**3)).sha256===map.evidenceSha256&&same(projection.fieldSourceFacts,fieldMap.fieldFacts),'COLD_FIELD_HISTORY_SOURCE_CHANGED');
    const final=await readRuntimeColdReviewWithFieldSourceV2(trust);need(same(final.source,source),'COLD_FIELD_HISTORY_SOURCE_CHANGED');
    const sourceBinding={format:'COLD_FIELD_HISTORY_SOURCE_BINDING_V1',controlId:source.controlId,sourceHash:trust.sourceHash,fieldSourceSha256:source.fieldSource.sha256,fullFactsSha256:source.fullFacts.sha256,tenantId,mapBinding:fieldMap.binding.mapBinding,mapEvidenceSha256:map.evidenceSha256,mapFactsSha256:map.facts.factsSha256,mapHead:map.facts.head};
    const fingerprint=createHmac('sha256',key).update('IDMS_COLD_FIELD_AUTHENTICATED_SOURCE_HISTORY_V1\n'+canonical(sourceBinding)+'\n'+canonical(projection.fieldHistory)).digest('hex');
    freeze(sourceBinding);freeze(projection.fieldHistory);const value=Object.freeze({sourceBinding,history:projection.fieldHistory,fingerprint,evidence:Object.freeze({format:'COLD_FIELD_HISTORY_SOURCE_V1',tenantId,issuances:projection.fieldHistory.issuances.length,events:projection.fieldHistory.events.length,completeSourceRootDomainReceiptChainAndRuntimeIndicesVerified:true,allStoredAndRejectedReceiptAuditAndPointMembersVerified:true,sourceSelectedEvidenceFileAndTrustedFacts:true,sourceAndEvidenceUnchangedAfterProjection:true,historicalOnly:true,currentHeldSessionVerified:false,currentTargetSqlCommitOrIdentityProven:false,wholeFieldPrivateFileSetAndEmptyWalBound:false,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false}),close(){owners.delete(value);},toJSON(){need(false,'COLD_FIELD_HISTORY_PRIVATE_ONLY');}});owners.set(value,{trust:structuredClone(trust),tenantId});return value;
  }catch{throw Object.assign(Error('COLD_FIELD_HISTORY_UNVERIFIABLE'),{code:'COLD_FIELD_HISTORY_UNVERIFIABLE'});}
  finally{key.fill(0);}
}

export function assertColdFieldSourceHistoryV2(value,context){const record=owners.get(value);need(record&&exact(context,['trust','tenantId'])&&same(record.trust,context.trust)&&record.tenantId===context.tenantId,'COLD_FIELD_HISTORY_ORIGINAL_OWNER');return value;}

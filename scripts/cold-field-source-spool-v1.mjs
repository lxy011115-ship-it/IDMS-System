import {createHmac} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {fieldEventProfile,fieldStreamBinding,fieldStreamId} from '../integrations/field-event.ts';
import {readColdFieldSourceHistoryV1} from './cold-field-source-history-v1.mjs';
import {inspectColdFieldSpoolSnapshotV2} from './cold-field-spool-snapshot-v2.mjs';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>canonical(a)===canonical(b);

/** Actual immutable SOURCE history plus provided captured main-spool bytes. */
export async function inspectColdFieldSourceSpoolV1(input,raw,macKey){
  need(exact(raw,['trust','tenantId','profile','contextLease','eventKey','platformPublicKey','historyPublicKeys','capacity','maxBytes','workDirectory']),'COLD_FIELD_SOURCE_SPOOL_CONTEXT');
  need(Buffer.isBuffer(input)&&Buffer.isBuffer(raw.eventKey)&&Buffer.isBuffer(macKey)&&macKey.length===32&&Array.isArray(raw.historyPublicKeys),'COLD_FIELD_SOURCE_SPOOL_BYTES');
  const bytes=Buffer.from(input),eventKey=Buffer.from(raw.eventKey),key=Buffer.from(macKey),trust=structuredClone(raw.trust),options={tenantId:raw.tenantId,platformPublicKey:raw.platformPublicKey,capacity:raw.capacity,maxBytes:raw.maxBytes,workDirectory:raw.workDirectory},publicKeys=[...raw.historyPublicKeys];
  try{
    const profile=fieldEventProfile(raw.profile),lease=structuredClone(raw.contextLease),stream=fieldStreamId(fieldStreamBinding(profile,lease,options.platformPublicKey));
    need(profile.source.tenantId===options.tenantId,'COLD_FIELD_SOURCE_SPOOL_TENANT');
    const source=await readColdFieldSourceHistoryV1({trust,tenantId:options.tenantId,publicKeys,workDirectory:options.workDirectory},key);
    const issued=source.history.issuances.find(value=>same(value.body,lease.body));need(issued,'COLD_FIELD_SOURCE_SPOOL_LEASE');
    const registry=source.history.registries.find(value=>value.auditEventId===issued.registryEventId),channel=registry?.snapshot.channels.find(value=>value.profileDigest===lease.body.profileDigest&&value.profile.source.edgeId===profile.source.edgeId);
    need(channel&&same(channel.profile,profile),'COLD_FIELD_SOURCE_SPOOL_PROFILE');
    const members=source.history.events.filter(value=>value.event.streamId===stream&&value.receipt.status==='STORED');
    const snapshot=await inspectColdFieldSpoolSnapshotV2(bytes,{profile,contextLease:lease,eventKey,platformPublicKey:options.platformPublicKey,acknowledgedEvents:members.map(value=>value.event),acknowledgedReceipts:members.map(value=>({eventDigest:value.receipt.eventDigest,receiptAuditId:value.receipt.auditEventId,receiptAt:value.receipt.receivedAt,status:value.receipt.status,pointId:value.receipt.pointId})),sourceLeaseBodies:source.history.issuances.map(value=>value.body),capacity:options.capacity,maxBytes:options.maxBytes,workDirectory:options.workDirectory},key);
    const fingerprint=createHmac('sha256',key).update('IDMS_COLD_FIELD_SOURCE_SPOOL_V1\n'+canonical(source.sourceBinding)+'\n'+source.fingerprint+'\n'+snapshot.fingerprint).digest('hex');
    return Object.freeze({sourceBinding:source.sourceBinding,fingerprint,evidence:Object.freeze({format:'COLD_FIELD_SOURCE_SPOOL_V1',tenantId:options.tenantId,pending:snapshot.evidence.pending,rejected:snapshot.evidence.rejected,acknowledged:snapshot.evidence.acknowledged,sequence:snapshot.evidence.sequence,actualSourceCompleteRootAndHistoryVerified:true,providedSnapshotMacAndAllEventAndAckSignaturesVerified:true,allProvidedEventIssuancesMatchActualSource:true,allRetainedAckAuditAndTimeAndPointOutcomesMatchActualSource:true,originalSpoolOpened:false,wholePrivateFileSetAndEmptyWalBound:false,currentHeldSessionVerified:false,currentTargetSqlCommitOrIdentityProven:false,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false}),toJSON(){need(false,'COLD_FIELD_SOURCE_SPOOL_PRIVATE_ONLY');}});
  }catch{throw Object.assign(Error('COLD_FIELD_SOURCE_SPOOL_UNVERIFIABLE'),{code:'COLD_FIELD_SOURCE_SPOOL_UNVERIFIABLE'});}
  finally{bytes.fill(0);eventKey.fill(0);key.fill(0);}
}

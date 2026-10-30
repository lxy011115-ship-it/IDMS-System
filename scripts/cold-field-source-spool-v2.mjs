import {createHmac} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {fieldEventProfile} from '../integrations/field-event.ts';
import {readColdFieldSourceHistoryV2,assertColdFieldSourceHistoryV2} from './cold-field-source-history-v2.mjs';
import {inspectColdFieldSpoolSnapshotV3} from './cold-field-spool-snapshot-v3.mjs';
import {coldFieldSourceStreamBindingV1} from './cold-field-source-stream-binding-v1.mjs';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const same=(a,b)=>canonical(a)===canonical(b);

/** SOURCE-authenticated stream binding also covers empty or no-ACK snapshots. */
export async function inspectColdFieldSourceSpoolV2(input,raw,macKey,sourceHistory){
  need(exact(raw,['trust','tenantId','profile','streamId','eventKey','platformPublicKey','historyPublicKeys','capacity','maxBytes','workDirectory']),'COLD_FIELD_SOURCE_SPOOL_CONTEXT');
  need(Buffer.isBuffer(input)&&Buffer.isBuffer(raw.eventKey)&&Buffer.isBuffer(macKey)&&macKey.length===32&&Array.isArray(raw.historyPublicKeys),'COLD_FIELD_SOURCE_SPOOL_BYTES');
  const bytes=Buffer.from(input),eventKey=Buffer.from(raw.eventKey),key=Buffer.from(macKey),trust=structuredClone(raw.trust),options={tenantId:raw.tenantId,streamId:raw.streamId,platformPublicKey:raw.platformPublicKey,capacity:raw.capacity,maxBytes:raw.maxBytes,workDirectory:raw.workDirectory},publicKeys=[...raw.historyPublicKeys];
  let createdHistory;
  try{
    const profile=fieldEventProfile(raw.profile);need(profile.source.tenantId===options.tenantId&&typeof options.streamId==='string'&&/^[a-f0-9]{64}$/.test(options.streamId),'COLD_FIELD_SOURCE_SPOOL_TENANT');
    if(sourceHistory===undefined)createdHistory=await readColdFieldSourceHistoryV2({trust,tenantId:options.tenantId,publicKeys,workDirectory:options.workDirectory},key);
    const source=assertColdFieldSourceHistoryV2(sourceHistory??createdHistory,{trust,tenantId:options.tenantId}),candidates=[];
    for(const issued of source.history.issuances){
      const registry=source.history.registries.find(value=>value.auditEventId===issued.registryEventId),channel=registry?.snapshot.channels.find(value=>value.profileDigest===issued.body.profileDigest&&value.profile.source.edgeId===profile.source.edgeId);
      if(!channel||!same(channel.profile,profile))continue;
      const candidate=coldFieldSourceStreamBindingV1(profile,issued.body,options.platformPublicKey);if(candidate.streamId===options.streamId)candidates.push(candidate);
    }
    need(candidates.length>0,'COLD_FIELD_SOURCE_SPOOL_STREAM');
    const members=source.history.events.filter(value=>value.event.streamId===options.streamId),stored=members.filter(value=>value.receipt.status==='STORED');
    const snapshot=await inspectColdFieldSpoolSnapshotV3(bytes,{profile,streamId:options.streamId,eventKey,platformPublicKey:options.platformPublicKey,acknowledgedEvents:stored.map(value=>value.event),acknowledgedReceipts:stored.map(value=>({eventDigest:value.receipt.eventDigest,receiptAuditId:value.receipt.auditEventId,receiptAt:value.receipt.receivedAt,status:value.receipt.status,pointId:value.receipt.pointId})),sourceLeaseBodies:source.history.issuances.map(value=>value.body),capacity:options.capacity,maxBytes:options.maxBytes,workDirectory:options.workDirectory},key);
    const maximumRecordedSequence=members.reduce((value,member)=>Math.max(value,member.event.sequenceNo),0);need(snapshot.evidence.sequence>=maximumRecordedSequence,'COLD_FIELD_SOURCE_SPOOL_SEQUENCE_ROLLBACK');
    const fingerprint=createHmac('sha256',key).update('IDMS_COLD_FIELD_SOURCE_SPOOL_V2\n'+canonical(source.sourceBinding)+'\n'+source.fingerprint+'\n'+snapshot.fingerprint).digest('hex');
    return Object.freeze({sourceBinding:source.sourceBinding,fingerprint,evidence:Object.freeze({format:'COLD_FIELD_SOURCE_SPOOL_V2',tenantId:options.tenantId,pending:snapshot.evidence.pending,rejected:snapshot.evidence.rejected,acknowledged:snapshot.evidence.acknowledged,sequence:snapshot.evidence.sequence,maximumRecordedSequence,streamBindingDerivedFromActualSourceIssuanceAndRegistry:true,contextSignedLeaseOrAckRequiredForBinding:false,actualSourceCompleteRootAndHistoryVerified:true,providedSnapshotMacAndAllEventAndAckSignaturesVerified:true,allProvidedEventIssuancesMatchActualSource:true,allRetainedAckOutcomesMatchActualSource:true,spoolSequenceNotBehindSourceCommittedHistory:true,originalSpoolOpened:false,wholePrivateFileSetAndEmptyWalBound:false,currentHeldSessionVerified:false,currentTargetSqlCommitOrIdentityProven:false,completeFieldMaterialsVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false}),toJSON(){need(false,'COLD_FIELD_SOURCE_SPOOL_PRIVATE_ONLY');}});
  }catch{throw Object.assign(Error('COLD_FIELD_SOURCE_SPOOL_UNVERIFIABLE'),{code:'COLD_FIELD_SOURCE_SPOOL_UNVERIFIABLE'});}
  finally{createdHistory?.close();bytes.fill(0);eventKey.fill(0);key.fill(0);}
}

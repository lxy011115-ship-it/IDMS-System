import {canonicalEqual} from '../server/canonical-state.ts';
import {recoveryNeed as need,sourceSummary} from './edge-recovery-operation.mjs';
export const recoveryCases={
 memory:{script:'scripts/verify-telemetry-recovery-memory.mjs',root:'work/pg-physical-platform-v1-20261022',name:'telemetry-memory-verification.json'},
 composition:{script:'scripts/verify-telemetry-recovery-composition.mjs',root:'work/telemetry-recovery-20261101',name:'verification.json'},
 edge:{script:'scripts/verify-telemetry-edge-control.mjs',root:'work/telemetry-edge-control-20261105',name:'verification.json'},
 main:{script:'scripts/verify-telemetry-main-control.mjs',root:'work/telemetry-main-control-20261105',name:'verification.json'}
};
export const requiredRecoveryChecks={
 composition:['REAL_APP_ROLE_RECEIVER_MQTT_AND_SQLITE_READY','NO_BUSINESS_ACK_OR_VISIBLE_ROWS_BEFORE_ACTUAL_COMMIT','REAL_POSTIMAGE_TRANSACTION_ROLLBACK_AND_EXACT_BYTE_REPLAY_APPEND_ONCE','ACTUAL_PG_COMMIT_RESULT_LOSS_NO_ACK_THEN_ORIGINAL_EVENT_RESOLVES_WITHOUT_DUPLICATES','ACK_WITH_NO_SUBSCRIBER_AND_SQLITE_REOPEN_RECONNECT_REPLAY_ARE_RECOVERABLE','REAL_BROKER_INVALID_EVENT_FORGED_ACK_AND_WRONG_DIGEST_PRESERVE_ORIGINAL_PENDING','TWO_ACTUAL_RECEIVERS_COMMIT_ONE_POINT_RECEIPT_AND_AUDIT','REAL_READONLY_AUTHORITY_BINDS_REGISTRY_AUDIT_RECEIPTS_POINTS_AND_REFUSES_OWN_QA_TAMPER','ACTUAL_RECEIVER_TERMINAL_AND_COORDINATOR_LOCK_PRECEDE_BACKUP_RESTORE_AND_CURSOR_UPGRADE','REAL_COMMITTED_SEQUENCE_REJECTIONS_QUARANTINE_EXACT_ORIGINALS_AND_NEW_CURSOR_STORES_SUCCESSFULLY'],
 edge:['ACTUAL_EDGE_PAUSES_CAPTURE_AND_HOLDS_ONE_BUSINESS_ACK_SLOT','ACTUAL_MQTT_WRONG_SIGNATURE_AND_DIGEST_DO_NOT_RELEASE_SLOT','ACTUAL_OPC_RESUMES_FUTURE_SEQUENCE_AND_NORMAL_EDGE_EXIT_PRESERVES_UNACKNOWLEDGED_MESSAGE','ACTUAL_EDGE_WAITS_FOR_IN_FLIGHT_OPC_RESPONSE_AND_PRESERVES_CAPTURE_BEFORE_SQLITE_CLOSE','ACTUAL_SIMULATOR_NORMAL_EXIT_CLOSES_STATUS_AND_OPC_LISTENERS'],
 main:['ACTUAL_MAIN_LOADS_OWNED_APP_ROLES_AND_SUBSCRIBES_MQTT','ACTUAL_STOP_WAITS_FOR_ORIGINAL_HTTP_AND_ADMITTED_TELEMETRY_WITHOUT_EARLY_COMMIT','ACTUAL_MAIN_NORMAL_EXIT_DRAINS_HTTP_AND_SQL_COMMIT_CLOSES_POOLS_AND_RETAINS_UNACKNOWLEDGED_EDGE_ORIGINAL']
};
const normalEnd=e=>e&&e.exitCode===0&&e.signal===null&&e.stdoutClosed===true&&e.stderrClosed===true;
const serviceEnd=p=>p&&normalEnd(p.end)&&p.final?.phase==='TERMINAL'&&p.final.drainCompleted===true&&p.final.exitCode===0&&p.final.signal===null;
export function validateRecoveryCase(kind,r,source){
 need(Object.hasOwn(recoveryCases,kind)&&r?.passed===true&&r.syntheticOnly===true&&!r.failure,'RECOVERY_CASE_NOT_PASSED');
 const before=kind==='memory'?r.sourceBefore:r.sourceBefore?.runtime,after=kind==='memory'?r.sourceAfter:r.sourceAfter?.runtime;
 need(before&&after&&canonicalEqual(sourceSummary(before),source)&&canonicalEqual(sourceSummary(after),source),'RECOVERY_CASE_SOURCE_CHANGED');
 if(kind==='memory'){
  need(r.enterpriseDml===0&&r.taskBytes===536870912&&r.watermarks?.total>0&&r.watermarks.total<=r.taskBytes&&r.finalAccountedBytes===0&&r.fullDigestAndAuditChainVerified===true&&r.ownedPostgresNormalStop===true,'RECOVERY_MEMORY_PROOF_INVALID');
  need(Array.isArray(r.cases)&&r.cases.length===4&&[75171,85171].every(history=>[true,false].every(rollback=>r.cases.filter(c=>c.history===history&&c.rollback===rollback&&c.accountingReturnedToBaseline===true&&Array.isArray(c.stages)&&canonicalEqual(c.stages.map(s=>s.stage),['reader','workspace','after','postImageComplete'])&&c.stages.every(s=>Number.isSafeInteger(s.bytes)&&s.bytes>0&&s.bytes<=r.taskBytes)).length===1)),'RECOVERY_MEMORY_COVERAGE_INCOMPLETE');return;
 }
 need(canonicalEqual(r.checks,requiredRecoveryChecks[kind]),'RECOVERY_CASE_COVERAGE_INCOMPLETE');const broker=r.cleanup?.broker;
 need(broker?.normalStop===true&&broker.code===0&&broker.signal===null&&broker.stdoutClosed===true&&broker.stderrClosed===true,'RECOVERY_CASE_BROKER_EXIT_UNPROVEN');
 if(kind==='edge')need(r.enterpriseDatabaseContacted===false&&r.format==='IDMS_ACTUAL_EDGE_CONTROL_QA_V1'&&Array.isArray(r.children)&&r.children.length===3&&r.children.filter(c=>c.service==='edge').length===2&&r.children.filter(c=>c.service==='simulator').length===1&&r.children.every(c=>c.normalExit===true&&c.proof?.result?.status==='NORMAL_EXIT'&&serviceEnd(c.proof.terminal)),'RECOVERY_EDGE_EXIT_UNPROVEN');
 else{
  need(r.originalDatabaseContacted===false&&r.cleanup.ownedPostgresNormalStop===true&&r.ownedPg?.sourceControl?.state==='shut down','RECOVERY_CASE_DATABASE_EXIT_UNPROVEN');
  if(kind==='composition')need(r.actualEnterpriseDml===0&&r.fullFinalDigestAndAuditChainVerified===true&&r.cleanup.receiverProcessesNormalExit===true&&r.unknownCommitFault==='ACTUAL_COMMIT_COMPLETED_CLIENT_RESULT_DISCARDED_IN_OWN_QA_PROCESS','RECOVERY_COMPOSITION_PROOF_INVALID');
  else need(r.format==='IDMS_ACTUAL_MAIN_CONTROL_QA_V1'&&r.main?.end?.status==='NORMAL_EXIT'&&serviceEnd(r.main.proof),'RECOVERY_MAIN_EXIT_UNPROVEN');
 }
 need(canonicalEqual(r.sourceBefore.caseSourcePins,r.sourceAfter.caseSourcePins)&&Array.isArray(r.sourceAfter.caseSourcePins)&&r.sourceAfter.caseSourcePins.some(p=>p.path===recoveryCases[kind].script),'RECOVERY_CASE_PINS_INCOMPLETE');
}

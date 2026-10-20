import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {canonical,digest} from '../../server/imports.ts';
import {readCurrentRecoveryWorkflow} from '../field-recovery-current-workflow.mjs';
export async function verifyRestoredRecoveryWorkflow({authority,target,directory,external}){
 assert.match(target.database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);const original=JSON.parse(await readFile(resolve(directory,'workflow-seeded-orders.json'),'utf8')),client=new pg.Client({host:authority.host,port:authority.port,database:target.database,user:'idms_bootstrap',password:authority.bootstrapPassword});await client.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const rows=(await client.query('SELECT body FROM business_work_orders ORDER BY ordinal')).rows.map(r=>r.body);assert.equal(canonical(rows),canonical(original));const outbox=(await client.query('SELECT command_id::text,entity_id::text,request_digest,envelope,response,status FROM workflow_outbox')).rows;assert.ok(outbox.length>=14);assert.ok(outbox.every(r=>r.status==='SYNCED'&&rows.some(o=>o.id===r.entity_id)));for(const row of outbox){const {requestDigest,...wire}=row.envelope;assert.equal(requestDigest,digest(canonical(wire)));assert.equal(requestDigest,row.request_digest);assert.equal(row.response.commandId,row.command_id);assert.equal(row.response.requestDigest,requestDigest);}
  for(const o of rows){const latest=outbox.find(r=>r.command_id===o.workflow.commandId);assert.ok(latest);assert.equal(latest.response.state,o.state);assert.equal(latest.response.version,o.version);assert.equal(latest.response.processInstanceId,o.workflow.processInstanceId);if(o.resolution){const {digest:sha,...body}=o.resolution;assert.equal(digest(canonical(body)),sha);}}
  await client.query('ROLLBACK');const current=await readCurrentRecoveryWorkflow(external,rows);assert.equal(current.snapshot.cases.length,4);assert.equal(current.snapshot.activeProcessIds.length,3);assert.equal(current.snapshot.cases.filter(c=>c.ended).length,1);assert.ok(current.snapshot.cases.some(c=>c.history.filter(t=>t.key==='repair').length>=2));
  return {actualFourWorkOrdersRestoredByteForByte:true,actualWorkflowOutboxFrozenRequestsAndReceiptsRestored:true,actualRepairEvidenceDigestsRemainValid:true,actualCurrentFlowableCasesTasksVariablesAndHistoryMatchRestoredOrders:true,actualThreeActiveAndOneClosedProcess:true,actualReturnHistoryPreserved:true,workOrderCount:4,outboxCommandCount:outbox.length,states:rows.map(o=>o.state).sort(),externalWorkflowSha256:current.sha256};
 }finally{if(['T','E'].includes(client.getTransactionStatus?.()))await client.query('ROLLBACK');await client.end();}
}

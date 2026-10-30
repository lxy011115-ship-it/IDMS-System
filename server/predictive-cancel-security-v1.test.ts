import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {canonical,digest} from './imports.ts';
import {WorkflowCancelReservationTransportV1,WorkflowReservationProofV1} from './workflow-cancel-reservation-transport-v1.ts';
import {PredictiveReconciliationAuthV1,ReconciliationGrantV1} from './predictive-reconciliation-auth-v1.ts';
import {cancelOpenV1,cancelActionV1} from './predictive-cancel-contract-v1.ts';

const config=(baseUrl='http://127.0.0.1:1')=>({workflow:{baseUrl,tenantId:'sandbox',serviceToken:'old-private-service-credential-'.repeat(2)},reservation:{baseUrl,tenantId:'sandbox',token:'new-private-reservation-credential-'.repeat(2),authorityId:randomUUID(),catalogHash:'a'.repeat(64)}});
const envelope=()=>{const e={commandId:randomUUID(),entityId:randomUUID(),action:'create' as const,expectedVersion:1,actor:{id:randomUUID(),type:'USER' as const,permissions:['predict:approve']},assignee:'',correlationId:'unit-protocol-binding'};return {...e,requestDigest:digest(canonical(e))};};

test('reservation refuses a foreign origin or tenant and reuse of the original service credential',()=>{
 const c=config();
 for(const patch of [{baseUrl:'http://127.0.0.1:2'},{baseUrl:c.reservation.baseUrl+'/path'},{tenantId:'acme'},{token:c.workflow.serviceToken},{authorityId:''},{catalogHash:''}])assert.throws(()=>new WorkflowCancelReservationTransportV1({...c,reservation:{...c.reservation,...patch}}),/WORKFLOW_RESERVATION_CONFIG/);
 assert.throws(()=>new WorkflowReservationProofV1(Symbol('untrusted'),'',{} as any,{} as any),/PROOF_CONSTRUCTOR/);
});

test('a syntactically valid server reply cannot bind a foreign entity or control, or release a blocked case',async()=>{
 let reply:any;const server=createServer((req,res)=>{req.resume();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(reply));});await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
 try{
  const c=config('http://127.0.0.1:'+(server.address() as any).port),transport=new WorkflowCancelReservationTransportV1(c),e=envelope(),id=randomUUID();
  const valid={format:'IDMS_WORKFLOW_CANCEL_RESERVATION_V1',tenantId:'sandbox',authorityId:c.reservation.authorityId,catalogHash:c.reservation.catalogHash,controlId:id,decision:{format:'IDMS_WORKFLOW_CANCEL_RECONCILIATION_V1',tenantId:'sandbox',authorityId:c.reservation.authorityId,controlId:id,commandId:e.commandId,entityId:e.entityId,requestDigest:e.requestDigest,outcome:'BLOCKED',creation:null},phase:'BLOCKED',case:null,domainReceiptDigest:null};
  reply=valid;const proof=await transport.reserve(id,e);assert.equal(proof.forReconciliation(transport.binding,e,id).phase,'BLOCKED');
  assert.throws(()=>proof.forReconciliation(transport.binding,{...e,entityId:randomUUID()},id),/PROOF_BINDING/);
  assert.throws(()=>proof.forReconciliation(transport.binding,e,randomUUID()),/PROOF_BINDING/);
  const copy=proof.forReconciliation(transport.binding,e,id);copy.decision.entityId=randomUUID();assert.equal(proof.forReconciliation(transport.binding,e,id).decision.entityId,e.entityId);
  reply={...valid,decision:{...valid.decision,entityId:randomUUID()}};await assert.rejects(()=>transport.reserve(id,e),/DECISION_BINDING/);
  reply={...valid,controlId:randomUUID()};await assert.rejects(()=>transport.reserve(id,e),/RESULT_BINDING/);
  reply=valid;await assert.rejects(()=>transport.release(id,e,'b'.repeat(64)),/RELEASE_PROOF/);
 }finally{server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}
});

test('reconciliation credentials accept only opaque encrypted sessions, never a job bearer or caller-created grant',()=>{
 assert.throws(()=>new PredictiveReconciliationAuthV1({} as any,{mode:'MEMORY'} as any),/ENCRYPTED_OIDC_REQUIRED/);
 const auth=new PredictiveReconciliationAuthV1({} as any,{mode:'POSTGRES_ENCRYPTED'} as any);
 for(const ref of [{kind:'BEARER',value:'a'.repeat(43)},{kind:'SESSION',value:'short'},{kind:'SESSION',value:'a'.repeat(43),roles:['final-approver']}])assert.throws(()=>auth.grant(ref as any),/SESSION_REQUIRED/);
 assert.throws(()=>new ReconciliationGrantV1(Symbol('untrusted'),{} as any,{} as any,{} as any),/GRANT_CONSTRUCTOR/);
});

test('wire requests refuse identity injection, numeric revisions and unbounded or missing review evidence',()=>{
 const open={id:randomUUID(),commandId:randomUUID(),expectedNativeHash:'a'.repeat(64)};
 assert.deepEqual(cancelOpenV1(open),open);assert.throws(()=>cancelOpenV1({...open,actorId:randomUUID()}),/INPUT/);
 const review={operationId:randomUUID(),expectedRevision:'1',evidenceDigest:'a'.repeat(64),decision:'APPROVE',comment:'reviewed evidence'};
 for(const patch of [{expectedRevision:1},{expectedRevision:'0'},{expectedRevision:'9223372036854775807'},{evidenceDigest:''},{comment:'x'.repeat(2001)},{decision:'APPROVED'}])assert.throws(()=>cancelActionV1('REVIEW',{...review,...patch}),/ACTION_INPUT/);
 assert.throws(()=>cancelActionV1('REVIEW',{...review,reviewerId:randomUUID()}),/INPUT/);
});

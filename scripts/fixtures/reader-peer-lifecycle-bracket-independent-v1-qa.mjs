import assert from 'node:assert/strict';
import {canonical} from '../../server/imports.ts';

/** Pure consumer of the original helper's recorded close event and fresh
 * lifecycle receipts. Does not attach, replay SQL, or mint a live capability. */
export function verifyReaderPeerLifecycleBracketIndependentQaV1({proof,reply,binding,pid,request}){
 const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
 assert.equal(proof.format,'IDMS_READER_PEER_ORIGINAL_LIFECYCLE_BRACKET_V1');
 assert(uuid(request.requestId)&&uuid(request.leaseId));assert(['ACQUIRE','PROBE','CAPTURE','RELEASE'].includes(request.operation));assert.match(request.configSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(proof.request,request);assert.equal(proof.bracket.format,'IDMS_READER_PEER_LIFECYCLE_BRACKET_V1');assert.equal(proof.bracket.requestId,request.requestId);
 assert.equal(proof.freshLifecycleProbes,2);assert.equal(proof.freshOriginalPeerAgentOperations,1);assert.equal(proof.helperProcessesStarted,1);assert.equal(proof.cachedObservationUsed,false);
 const expected={format:'IDMS_WORKFLOW_LIFECYCLE_V1',phase:'BOUND',pid:String(pid),start:binding.start,owner:binding.owner,deployment:binding.deployment,jarSha256:binding.jarSha256,agentSha256:binding.agentSha256,requestId:'-',directory:binding.directory};
 assert.deepEqual(proof.bracket.before,expected);assert.deepEqual(proof.bracket.after,expected);
 assert.deepEqual(proof.binding,{...binding,requestId:request.requestId,agentSha256:reply.binding.agentSha256});
 assert.deepEqual(reply.binding,{...expected,phase:'READER_PEER',requestId:request.requestId,agentSha256:proof.binding.agentSha256});
 assert.equal(reply.payload.operation,request.operation);assert.equal(reply.payload.requestId,request.requestId);assert.equal(reply.payload.leaseId,request.leaseId);assert.equal(reply.payload.tenantId,request.tenantId);
 const terminal=proof.helperTerminal;assert.equal(terminal.format,'IDMS_READER_PEER_BRACKET_HELPER_EXIT_V1');assert(Number.isSafeInteger(terminal.pid)&&terminal.pid>0&&terminal.pid!==pid);assert.deepEqual(terminal.exit,{code:0,signal:null});
 for(const key of ['originalChildHandleHeld','stdoutClosed','stderrClosed'])assert.equal(terminal[key],true);for(const key of ['spawnError','overflow','targetSignalSent'])assert.equal(terminal[key],false);
 assert(Number.isFinite(Date.parse(proof.observedAt)));assert.equal(canonical(proof.bracket.before),canonical(proof.bracket.after));
 return{format:'IDMS_READER_PEER_BRACKET_INDEPENDENT_QA_V1',freshLifecycleProbes:2,originalPeerAgentOperations:1,actualOriginalHelperExitAndBothStreamsBound:true,cachedObservationUsed:false,currentSqlOrAttachReplayed:false,runtimeAuthorityGranted:false};
}

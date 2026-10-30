import {resolve} from 'node:path';
import {coldReadonlyInputQaV3,coldReviewUnitIdV3 as id} from './cold-readonly-review-input-v3.mjs';
import {reviewSourceHashV1 as hash} from '../../scripts/workflow-review-source-facts-v1.mjs';

// Metadata-only vectors. They cannot create a production owned FIELD capability.
export function currentWorkflowSourceInputQaV1(format='RUNTIME_COLD_SOURCE_V1'){
 const {source}=coldReadonlyInputQaV3(),contract=source.readerContract;
 const binding={database:'workflow_db',databaseOid:'201',ownerOid:'100',controlOid:'10',deployment:id,catalogHash:'d'.repeat(64),actorOids:['101','102']};
 source.active=[binding];source.backupId=id;
 contract.installationId=id;
 const f=contract.readers[0].facts;
 Object.assign(f.identity,{control_oid:'10',current_oid:'10',standby:false});
 f.fence={deployment:id,databaseOid:'201',ownerOid:'100',controlOid:'10'};
 const {sha256:prior,...facts}=f;f.sha256=hash(facts);
 contract.readers[0].fenceBinding=structuredClone(binding);
 const {sha256:old,...body}=contract;contract.sha256=hash(body);
 source.format=format;
 if(format==='RUNTIME_COLD_SOURCE_V1'){source.readerSourceContract=contract;delete source.readerContract;}
 const trust={format:format==='RUNTIME_COLD_SOURCE_V1'?'RUNTIME_COLD_TRUST_V1':'RUNTIME_COLD_REVIEW_TRUST_V3',controlId:source.controlId,sourceHash:hash(source)};
 const targetDirectory=resolve('work/unit-current-reader/actual-restored-target');
 const state={phase:'ADMITTED',source,details:{targetDirectory,restore:{directory:targetDirectory,backupId:source.backupId,systemIdentifier:source.inventory.identity.system_id,fullArchiveAuthenticationVerified:true,fullFileHashesVerified:true},admission:{authorityHash:'e'.repeat(64)}}};
 const owner={format:'OWNED_APPLICATION_FIELD_SOURCE_PRIVATE_V1',tenantIds:['acme'],originalTerminal:{normalFullGroup:true,allOwnedTerminalProven:true,allOwnedResourcesRetired:true,exit:{code:0,signal:null}},originalDeploymentBinding:{controlId:source.controlId,sourceHash:trust.sourceHash,authorityHash:state.details.admission.authorityHash}};
 return{owner,trust,state};
}
export function resealCurrentWorkflowSourceQaV1(v){
 const contract=v.state.source.readerSourceContract??v.state.source.readerContract;
 if(contract){for(const r of contract.readers){const{sha256,...facts}=r.facts;r.facts.sha256=hash(facts);}const{sha256,...body}=contract;contract.sha256=hash(body);}
 v.trust.sourceHash=hash(v.state.source);v.owner.originalDeploymentBinding.sourceHash=v.trust.sourceHash;return v;
}

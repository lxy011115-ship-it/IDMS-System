import {resolve,join} from 'node:path';
import {coldReadonlyInputQaV3,coldReviewUnitIdV3 as id} from './cold-readonly-review-input-v3.mjs';
import {stateEmptyHashes} from '../../server/state-map-v1.ts';
import {reviewSourceHashV1 as hash} from '../../scripts/workflow-review-source-facts-v1.mjs';
import {coldSourceMapProfileV1} from '../../scripts/cold-source-full-facts-v1.mjs';
// Metadata-only vectors. They cannot pass real evidence reconstruction or mint a prepared control.
export function coldSourceFullSetUnitV1(){
 const {source,trust,config}=coldReadonlyInputQaV3(),controlDirectory=resolve('work/unit-cold-source/control'),empty=hash('');
 const gate={format:'RUNTIME_WRITE_FENCE_BINDING_V1',deployment:id,host:'127.0.0.1',port:25433,systemIdentifier:source.inventory.identity.system_id,database:'workflow_db',databaseOid:'201',ownerOid:'100',controlOid:'10',actorOids:['101','102'],catalogHash:'d'.repeat(64)};
 const frame={inventory:source.inventory,active:[gate],retired:[],structures:source.inventory.databases.map(d=>({database:d.datname,sha256:'e'.repeat(64)})),closedReceipt:{databases:[{database:gate.database,operationId:id,revision:0}]}};
 const binding={tenantId:'acme',databaseOid:'201',roleOid:'101',catalogHash:'f'.repeat(64)},profile=coldSourceMapProfileV1(frame,gate,binding,resolve(source.inventory.identity.directory));
 const factsBody={format:'FIELD_MAP_FULL_FACTS_V1',tenantId:'acme',profileSha256:hash(profile),head:{revision:'0',rootId:null,rootHash:stateEmptyHashes[0],count:'0',receiptHash:'0'.repeat(64)},nodes:0,leaves:0,valueBytes:0,lookups:0,receiptRows:0,relations:[],sqlBytes:0,payloadSha256:hash({unitMetadataOnly:true}),auditSha256:hash([]),auditEvents:0,evidencePrefixSha256:empty,entireCurrentRootVerified:true,allSqlReceiptsVerified:true,fullDomainPayloadReconstructed:true,currentOidcApprovalVerified:false,formalFieldActivationGranted:false},facts={...factsBody,factsSha256:hash(factsBody)};
 const databases=source.inventory.databases.map(d=>{const body={format:'COLD_REVIEW_SQL_FACTS_V1',identity:{systemIdentifier:source.inventory.identity.system_id,database:d.datname,databaseOid:d.oid,controlOid:'10'},relations:[{oid:'301',schema:'public',name:'unit_records',kind:'r',rows:0,bytes:0,sha256:empty},...['pg_largeobject_metadata','pg_largeobject'].map(name=>({schema:'pg_catalog',name,kind:'LARGE_OBJECT',rows:0,bytes:0,sha256:empty}))],totalRows:0,totalBytes:0};return{database:d.datname,databaseOid:d.oid,sqlFacts:{...body,sha256:hash(body)},map:d.oid==='201'?{format:'COLD_SOURCE_FULL_MAP_V1',tenantId:'acme',profile,facts,evidenceFile:join(controlDirectory,'source-full-maps','source-map-acme-'+id+'.jsonl'),evidenceSha256:empty}:null};});
 const body={format:'COLD_SOURCE_FULL_FACTS_SET_V1',databases};return{frame,set:{...body,sha256:hash(body)},controlDirectory,source,trust,config};
}
export function rehashColdUnitV1(v,key='sha256'){const {[key]:old,...body}=v;v[key]=hash(body);return v;}

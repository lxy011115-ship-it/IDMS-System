import {seedStore} from '../../server/store.ts';
import {createBatch,approveBatch,emptyImports,canonical,digest} from '../../server/imports.ts';
import {appendAudit} from '../../server/audit.ts';
import {tenantPayload,splitBatch} from '../../server/entity-repository.ts';
import {projectVerifiedRead} from '../../server/read-workspace.ts';
import {entityTables} from '../../server/entity-schema.ts';
const upload={tenantId:'acme',actorId:'cold-uploader',actorType:'USER',authMode:'oidc',roles:['data-uploader'],correlationId:'cold-unit'},review={...upload,actorId:'cold-reviewer',roles:['final-approver']};
export function smallColdFixture(size=100000,extraAudits=20){
 const store=seedStore(),imports=emptyImports(),original=Buffer.alloc(size);for(let n=0;n<original.length;n++)original[n]=(n*31)%256;
 const row={source_record_id:'cold-device',device_code:'COLD-1',device_name:'分段汉字😀与引号"\n',site_code:'FACTORY-01',line_code:'LINE-01'};
 const batch=createBatch(imports,store,{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'cold-unit',rows:[row],original,filename:'汉字😀.json',mime:'application/json',sourceKind:'API_JSON'},upload);
 approveBatch(imports,store,batch.batchId,{decision:'APPROVED',comment:'独立核查',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},review);
 for(let n=0;n<extraAudits;n++)appendAudit(store,{tenantId:'acme',objectType:'UNIT',objectId:'event-'+n,action:'COLD_EVIDENCE',actorType:'USER',actorId:'unit',correlationId:'cold',metadata:{unicode:'\u0000汉字😀',n}});
 imports.requests.push({key:'acme:cold-import',digest:digest('input'),batchId:batch.batchId});store.idempotency.set('acme:cold-command',{value:'😀',nested:[null,1,{b:2,a:1}]});
 const {audits,idempotency,...business}=store;return tenantPayload({version:2,business,imports,audits,idempotency:[...idempotency]},'acme');
}
export function coldModel(payload){
 const tenant='acme',revision=7,payloadDigest=digest(canonical(payload)),data=projectVerifiedRead(payload),batchRanks=new Map(payload.imports.batches.map((b,i)=>[b.batchId,BigInt(i+1)])),snapshot={data,revision,payloadDigest,batchRanks},lean=[];
 const add=(kind,identity,ordinal,detail)=>lean.push({kind,identity,ordinal:String(ordinal),tenant_id:tenant,detail,content:null});
 add('state',tenant,revision,{schemaVersion:3,payloadDigest});for(const [key,items]of Object.entries(payload.business))items.forEach((body,i)=>add('business:'+key,body.id,i+1,body));
 payload.imports.batches.forEach((b,i)=>{const parts=splitBatch(b);add('batch',b.batchId,i+1,parts.body);for(const input of parts.input)add('input',b.batchId,input.ordinal,{body:input.body,validOrdinal:input.validOrdinal});});
 payload.imports.records.forEach((r,i)=>add('record',r.batchId,i+1,r));payload.business.workOrders.forEach(r=>add('mirror',r.id,0,r));
 const rows=[],source=(phase,kind,identity,ordinal,detail,content=null,suborder=0)=>rows.push({phase,kind,tenant_id:tenant,identity,ordinal:String(ordinal),detail,content,suborder:String(suborder)}),frame=phase=>rows.push({phase,kind:'frame',tenant_id:'',identity:'',ordinal:'-1',detail:null,content:null,suborder:'0'});
 source(0,'state',tenant,revision,{schemaVersion:3,payloadDigest});frame(1);payload.audits.forEach((event,i)=>source(1,'audit',event.eventId,i+1,{event,hash:event.hash,previousHash:event.previousHash}));frame(2);payload.idempotency.forEach(([key,value],i)=>source(2,'receipt',key,i+1,value));frame(3);
 payload.imports.batches.forEach((b,i)=>{const bytes=Buffer.from(b.originalBase64,'base64');source(3,'file-meta',b.batchId,i+1,{sha256:b.fileSha256,bytes:bytes.length});for(let at=0;at<bytes.length;at+=49152)source(3,'file-chunk',b.batchId,i+1,{offset:at},Buffer.from(bytes.subarray(at,at+49152)),at+1);});
 frame(4);payload.imports.requests.forEach((r,i)=>source(4,'request',r.key,i+1,r));frame(5);return {snapshot,lean,rows};
}
export function cloneColdRows(rows){return rows.map(({content,...row})=>({...structuredClone(row),content:content===null?null:Buffer.from(content)}));}

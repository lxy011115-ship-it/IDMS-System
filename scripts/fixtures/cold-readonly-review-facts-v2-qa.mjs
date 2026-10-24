import assert from 'node:assert/strict';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {canonical} from '../../server/imports.ts';
const q=s=>'"'+s.replaceAll('"','""')+'"',hash=v=>createHash('sha256').update(v).digest('hex');
export async function captureColdReviewDataQaV2(cluster,inventory,flow){
 const databases=[],workflows={};
 for(const db of inventory.databases){const c=new pg.Client({...cluster.account,database:db.datname});try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const relations=[];for(const r of(await c.query("SELECT c.oid,n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname NOT IN('information_schema','runtime_write_fence_v1') AND c.relkind IN('r','S') ORDER BY c.oid")).rows){const name=q(r.nspname)+'.'+q(r.relname);if(r.relkind==='S')relations.push({schema:r.nspname,name:r.relname,kind:'sequence',...(await c.query('SELECT last_value::text,is_called FROM '+name)).rows[0]});else{const rows=(await c.query('SELECT to_jsonb(t)::text AS value FROM '+name+' t ORDER BY to_jsonb(t)::text COLLATE "C"')).rows;let bytes=0;const digest=createHash('sha256');for(const row of rows){const value=row.value+'\n';bytes+=Buffer.byteLength(value);digest.update(value);}relations.push({schema:r.nspname,name:r.relname,kind:'table',rows:rows.length,bytes,sha256:digest.digest('hex')});}}
  databases.push({database:db.datname,databaseOid:db.oid,relations});const tenant=Object.keys(flow.tenants).find(id=>flow.tenants[id].database===db.datname);if(tenant){const cases=(await c.query('SELECT entity_id,process_id,version,state,assignee,evidence_digest,submitted_by FROM public.idms_workflow_cases ORDER BY entity_id COLLATE "C"')).rows,commands=(await c.query('SELECT command_id::text,request_digest,response FROM public.idms_workflow_commands ORDER BY command_id::text COLLATE "C"')).rows;assert(cases.length>0);workflows[tenant]={cases,commands};}await c.query('COMMIT');
 }finally{await c.end();}}
 const body={format:'COLD_REVIEW_DATA_FINGERPRINT_QA_V2',databases,workflows};return{...body,sha256:hash(canonical(body))};
}
export function compareColdReviewWorkflowQaV2(actual,want,tenant){
 assert.equal(actual.tenantId,tenant);assert.equal(actual.readOnly,true);assert.equal(actual.isolation,'repeatable read');assert.equal(actual.commandCount,want.commands.length);assert.equal(actual.cases.length,want.cases.length);
 for(const row of want.cases){const view=actual.cases.find(v=>v.entityId===row.entity_id);assert(view);assert.equal(view.processInstanceId,row.process_id);for(const [key,source]of Object.entries({state:'state',version:'version',assignee:'assignee',evidenceDigest:'evidence_digest',submittedBy:'submitted_by'}))assert.equal(view[key],row[source]);const commands=want.commands.filter(c=>c.response.entityId===row.entity_id&&c.response.version===row.version);assert.equal(commands.length,1);assert.equal(view.lastCommandId,commands[0].command_id);}
}

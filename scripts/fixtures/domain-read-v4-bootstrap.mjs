import pg from 'pg';
import {readEntities} from '../../server/entity-repository.ts';
import {tenantWorkspace,workspacePayload} from '../../server/tenant-workspace.ts';
import {savePostgres} from '../../server/postgres-repository.ts';
import {createBatch,approveBatch} from '../../server/imports.ts';
import {enrichTelemetryDomainModel} from './telemetry-domain-v4-model.mjs';
import {BusinessMaintenanceGate,inspectBusinessMaintenanceBinding} from '../business-maintenance-gate.mjs';
import {captureLegacyV3Map,commitLegacyV3Fence} from '../legacy-v4-source.mjs';
import {LegacyV4MapBuilder,verifyLegacyV4Map,sealLegacyV4Map} from '../legacy-v4-target.mjs';
import {activateTelemetryDomainV4} from '../telemetry-map-activation-v4.mjs';
export async function bootstrapDomainReadV4Qa(qa,source,clock){
 const account=qa.business.tenants.sandbox,app=new pg.Client({host:qa.authority.host,port:qa.authority.port,...account}),root=new pg.Client({...qa.adminAccount,database:account.database});let gate;
 app.on('error',()=>{});root.on('error',()=>{});await app.connect();await root.connect();
 try{
  await app.query('BEGIN');await app.query('SELECT revision FROM public.business_state WHERE tenant_id=$1 FOR UPDATE',['sandbox']);const loaded=await readEntities(app,'sandbox'),workspace=tenantWorkspace(loaded.payload),model=enrichTelemetryDomainModel(workspace,source,clock);
  const profile=workspace.store.templates.find(t=>t.manifest.purpose==='equipment-profile'),author={tenantId:'sandbox',actorId:'read-author',actorType:'USER',authMode:'oidc',roles:['data-uploader'],correlationId:'read-qa'},reviewer={...author,actorId:'read-reviewer',roles:['final-approver']},rows=Array.from({length:36},(_,i)=>({source_record_id:'read-asset-'+i,device_code:'READ-'+String(i).padStart(3,'0'),device_name:'Read QA '+i,site_code:i%2?'HIDDEN-SITE':'V4-SITE',line_code:i%2?'HIDDEN-LINE':'V4-LINE'})),batch=createBatch(workspace.imports,workspace.store,{dataType:'DEVICE',sourceSystem:'read-qa',templateVersion:'1.0.0',rows,original:Buffer.from(JSON.stringify(rows)),filename:'read-qa.json',mime:'application/json',sourceKind:'API_JSON',equipmentProfileRef:{templateId:profile.id,version:profile.version,contentDigest:profile.contentDigest}},author);if(batch.status!=='AWAITING_APPROVAL')throw Error(JSON.stringify(batch.errors));approveBatch(workspace.imports,workspace.store,batch.batchId,{decision:'APPROVED',comment:'独立批准查询资产',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},reviewer);
  await app.query('INSERT INTO public.telemetry_points SELECT * FROM jsonb_populate_record(NULL::public.telemetry_points,$1::jsonb)',[JSON.stringify(model.point)]);await app.query('INSERT INTO public.telemetry_receipts SELECT * FROM jsonb_populate_record(NULL::public.telemetry_receipts,$1::jsonb)',[JSON.stringify(model.receipt)]);await savePostgres(workspacePayload(workspace,'sandbox'),{tenantId:'sandbox',client:app,...loaded});await app.query('COMMIT');
  const expected=await inspectBusinessMaintenanceBinding(root,account,'sandbox');gate=new BusinessMaintenanceGate(qa.authority,{sandbox:{account,expected}});await gate.acquire();const target=qa.targets.sandbox,builder=new LegacyV4MapBuilder(target.account,target.binding);await builder.begin();const manifest=await captureLegacyV3Map(gate,'sandbox',e=>builder.accept(e)),head=await builder.finish(),verification=await verifyLegacyV4Map(target.account,target.binding,head,manifest),fence=await commitLegacyV3Fence(gate,manifest),seal=await sealLegacyV4Map(target.account,target.binding,head,manifest,fence,verification),activation=await activateTelemetryDomainV4({account:target.account,binding:target.binding,sealKey:seal.command.operations[0].key,sources:[source]});return {model,target,activation};
 }finally{await gate?.release();await app.query('ROLLBACK').catch(()=>{});await app.end();await root.end();}
}

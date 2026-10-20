import pg from 'pg';
import {readEntities} from '../../server/entity-repository.ts';
import {tenantWorkspace,workspacePayload} from '../../server/tenant-workspace.ts';
import {savePostgres} from '../../server/postgres-repository.ts';
import {enrichTelemetryDomainModel} from './telemetry-domain-v4-model.mjs';
import {BusinessMaintenanceGate,inspectBusinessMaintenanceBinding} from '../business-maintenance-gate.mjs';
import {captureLegacyV3Map,commitLegacyV3Fence} from '../legacy-v4-source.mjs';
import {LegacyV4MapBuilder,verifyLegacyV4Map,sealLegacyV4Map} from '../legacy-v4-target.mjs';
import {activateTelemetryDomainV4} from '../telemetry-map-activation-v4.mjs';
export async function bootstrapTelemetryMapV4Qa(qa,source,clock){
 const account=qa.business.tenants.sandbox,app=new pg.Client({host:qa.authority.host,port:qa.authority.port,...account}),root=new pg.Client({...qa.adminAccount,database:account.database});let gate;
 app.on('error',()=>{});root.on('error',()=>{});await app.connect();await root.connect();
 try{
  await app.query('BEGIN');await app.query('SELECT revision FROM public.business_state WHERE tenant_id=$1 FOR UPDATE',['sandbox']);const loaded=await readEntities(app,'sandbox'),workspace=tenantWorkspace(loaded.payload),model=enrichTelemetryDomainModel(workspace,source,clock);
  await app.query('INSERT INTO public.telemetry_points SELECT * FROM jsonb_populate_record(NULL::public.telemetry_points,$1::jsonb)',[JSON.stringify(model.point)]);await app.query('INSERT INTO public.telemetry_receipts SELECT * FROM jsonb_populate_record(NULL::public.telemetry_receipts,$1::jsonb)',[JSON.stringify(model.receipt)]);await savePostgres(workspacePayload(workspace,'sandbox'),{tenantId:'sandbox',client:app,...loaded});await app.query('COMMIT');
  const expected=await inspectBusinessMaintenanceBinding(root,account,'sandbox');gate=new BusinessMaintenanceGate(qa.authority,{sandbox:{account,expected}});await gate.acquire();const target=qa.targets.sandbox,builder=new LegacyV4MapBuilder(target.account,target.binding);await builder.begin();const manifest=await captureLegacyV3Map(gate,'sandbox',e=>builder.accept(e)),head=await builder.finish(),verification=await verifyLegacyV4Map(target.account,target.binding,head,manifest),fence=await commitLegacyV3Fence(gate,manifest),seal=await sealLegacyV4Map(target.account,target.binding,head,manifest,fence,verification),activation=await activateTelemetryDomainV4({account:target.account,binding:target.binding,sealKey:seal.command.operations[0].key,sources:[source]});return {model,target,activation};
 }finally{await gate?.release();await app.query('ROLLBACK').catch(()=>{});await app.end();await root.end();}
}

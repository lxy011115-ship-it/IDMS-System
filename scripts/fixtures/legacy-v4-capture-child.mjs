import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {BusinessMaintenanceGate,inspectBusinessMaintenanceBinding} from '../business-maintenance-gate.mjs';
import {captureLegacyV3Map,commitLegacyV3Fence} from '../legacy-v4-source.mjs';
import {LegacyV4MapBuilder,verifyLegacyV4Map,sealLegacyV4Map} from '../legacy-v4-target.mjs';
import {privateNewFile} from '../backup-support.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8')),tenant=config.tenant,source=new pg.Client({...config.adminAccount,database:config.source.database}),observer=new pg.Client({...config.adminAccount,database:'postgres'}),old=new pg.Client({host:config.adminAccount.host,port:config.adminAccount.port,...config.source});
let gate,output;await source.connect();await observer.connect();await old.connect();
try{
 const expected=await inspectBusinessMaintenanceBinding(source,config.source,tenant);gate=new BusinessMaintenanceGate(config.authority,{[tenant]:{account:config.source,expected}},config.operationId);await gate.acquire();
 const builder=new LegacyV4MapBuilder(config.target.account,config.target.binding);await builder.begin();const manifest=await captureLegacyV3Map(gate,tenant,e=>builder.accept(e)),head=await builder.finish();
 await privateNewFile(join(config.directory,'captured.private.json'),JSON.stringify({manifest,head}));
 const verification=await verifyLegacyV4Map(config.target.account,config.target.binding,head,manifest);
 await assert.rejects(sealLegacyV4Map(config.target.account,config.target.binding,head,manifest,{operationId:config.operationId,oldRuntimeTableAndColumnDmlRevoked:false},verification),/SEAL_PRECONDITION/);
 const pid=(await old.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await old.query('BEGIN');const wait=old.query('SELECT revision FROM public.business_state WHERE tenant_id=$1 FOR UPDATE',[tenant]).then(value=>({value}),error=>({error}));
 let blocked=false;for(let i=0;i<100;i++){const row=(await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];if(row?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(ok=>setTimeout(ok,20));}assert.equal(blocked,true);
 const fence=await commitLegacyV3Fence(gate,manifest),w=await wait;if(w.error)assert.equal(w.error.code,'42501');else await assert.rejects(old.query('UPDATE public.business_state SET revision=revision WHERE tenant_id=$1',[tenant]),e=>e.code==='42501');await old.query('ROLLBACK');
 await assert.rejects(old.query("SELECT nextval('public.audit_ledger_sequence_no_seq')"),e=>e.code==='42501');assert.equal((await old.query('SELECT count(*)::int AS n FROM public.business_state')).rows[0].n,1);
 output={phase:'FENCED_UNSEALED',tenantId:tenant,operationId:config.operationId,childPid:process.pid,manifest,head,verification,fence,queuedLegacyRootTransactionCouldNotPerformLaterDml:true,oldSequenceUsageDenied:true,oldReadStillAvailable:true,sealBeforeFenceRefused:true,businessFormatActivated:false};
}finally{await gate?.release();await source.end();await observer.end();await old.query('ROLLBACK').catch(()=>{});await old.end();}
await privateNewFile(join(config.directory,'fenced-unsealed.private.json'),JSON.stringify(output));console.log(JSON.stringify({tenantId:tenant,phase:output.phase,sourceBaseTables:output.manifest.tableFacts.length,mapEntries:output.verification.entries,childPid:process.pid}));

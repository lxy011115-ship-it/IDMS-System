import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {createMaintenanceConsoleBusinessQaV4} from './maintenance-console-business-v4-qa.mjs';
import {maintenanceJobsSchemaSqlV4} from '../maintenance-jobs-schema-v4.mjs';
import {inspectMaintenanceJobCatalogV4} from '../../server/maintenance-job-catalog-v4.ts';
import {inspectStateMapCatalog} from '../../server/state-map-catalog-v1.ts';
import {MaintenanceJobCryptoV4} from '../../server/maintenance-job-crypto-v4.ts';
/** Fresh schemas inside exactly the owned QA databases; the parent fixture owns cleanup. */
export async function createMaintenanceConsolePgV4Qa(){
 const gateways=Object.fromEntries(['acme','sandbox'].map(tenantId=>[tenantId,{tenantId,baseUrl:'http://127.0.0.1:1',serviceToken:randomBytes(32).toString('base64url'),model:{name:'qwen3:4b',digest:'sha256:'+'0'.repeat(64)}}]));
 const qa=await createMaintenanceConsoleBusinessQaV4(gateways);
 try{
  for(const [tenant,t] of Object.entries(qa.targets)){
   const c=new pg.Client({...qa.adminAccount,database:t.account.database});await c.connect();
   try{
    const owner=(await c.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0].owner;
    await c.query('BEGIN');await c.query(await maintenanceJobsSchemaSqlV4({tenant,owner,worker:t.account.user,ingress:t.queue.ingressAccount.user,deployment:t.queue.deployment}));await c.query('COMMIT');
    assert.equal(await inspectStateMapCatalog(c),t.binding.catalogHash);
    const catalogHash=await inspectMaintenanceJobCatalogV4(c),worker={...t.queue.worker,catalogHash},ingress={...t.queue.ingressBinding,catalogHash};
    const ring={format:1,activeKeyId:'maintenance-qa-1',keys:[{keyId:'maintenance-qa-1',key:randomBytes(32).toString('base64url')}]};
    t.maintenance={worker,ingress,crypto:new MaintenanceJobCryptoV4(ring,worker),ring};
   }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}
  }
  return qa;
 }catch(e){await qa.close();throw e;}
}

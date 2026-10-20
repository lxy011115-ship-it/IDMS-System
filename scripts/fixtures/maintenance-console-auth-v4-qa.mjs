import assert from 'node:assert/strict';
import pg from 'pg';
import {createMaintenanceConsoleSessionQaV4} from './maintenance-console-session-v4-qa.mjs';
import {maintenanceJobsSchemaSqlV4} from '../maintenance-jobs-schema-v4.mjs';
import {inspectMaintenanceJobCatalogV4} from '../../server/maintenance-job-catalog-v4.ts';
import {inspectStateMapCatalog} from '../../server/state-map-catalog-v1.ts';
export async function createMaintenanceConsoleAuthV4Qa(){
 const qa=await createMaintenanceConsoleSessionQaV4();try{
  for(const [tenant,t]of Object.entries(qa.targets)){const c=new pg.Client({...qa.adminAccount,database:t.account.database});await c.connect();try{
   const owner=(await c.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0].owner;await c.query('BEGIN');await c.query(await maintenanceJobsSchemaSqlV4({tenant,owner,worker:t.account.user,ingress:t.queue.ingressAccount.user,deployment:t.queue.deployment}));await c.query('COMMIT');assert.equal(await inspectStateMapCatalog(c),t.binding.catalogHash);const catalogHash=await inspectMaintenanceJobCatalogV4(c);t.maintenance={worker:{...t.queue.worker,catalogHash},ingress:{...t.queue.ingressBinding,catalogHash}};
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}}
  return qa;
 }catch(e){await qa.close();throw e;}
}

import assert from 'node:assert/strict';
import pg from 'pg';
import {createPredictiveConsoleSessionQaV4} from './predictive-console-session-v4-qa.mjs';
import {predictiveJobsSchemaSqlV4} from '../predictive-jobs-schema-v4.mjs';
import {inspectPredictiveJobCatalogV4} from '../../server/predictive-job-catalog-v4.ts';
import {inspectStateMapCatalog} from '../../server/state-map-catalog-v1.ts';
export async function createPredictiveConsoleAuthV4Qa(){
 const qa=await createPredictiveConsoleSessionQaV4();try{
  for(const [tenant,t]of Object.entries(qa.targets)){const c=new pg.Client({...qa.adminAccount,database:t.account.database});await c.connect();try{
   const owner=(await c.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0].owner;await c.query('BEGIN');await c.query(await predictiveJobsSchemaSqlV4({tenant,owner,worker:t.account.user,ingress:t.queue.ingressAccount.user,deployment:t.queue.deployment}));await c.query('COMMIT');assert.equal(await inspectStateMapCatalog(c),t.binding.catalogHash);const catalogHash=await inspectPredictiveJobCatalogV4(c);t.predictive={worker:{...t.queue.worker,catalogHash},ingress:{...t.queue.ingressBinding,catalogHash}};
  }finally{await c.query('ROLLBACK').catch(()=>{});await c.end();}}
  return qa;
 }catch(e){await qa.close();throw e;}
}

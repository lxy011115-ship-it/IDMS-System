import assert from 'node:assert/strict';
import {seedStore} from '../../server/store.ts';
import {loadImports,mutate,consistentRead} from '../../server/import-api.ts';
import {closePostgres} from '../../server/postgres-repository.ts';
if(!process.send||!/^lease-probe-[a-f0-9]{10}$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Connection probe requires isolated QA IPC');
const store=seedStore();await loadImports(store);const target=store.devices.find(d=>d.tenantId==='acme'),expected=target.name;
let proceed;const gate=new Promise(ok=>proceed=ok);process.once('message',()=>proceed());
await assert.rejects(mutate(store,async (client,{store})=>{const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;store.devices.find(d=>d.id===target.id).name='QA_UNCOMMITTED';process.send({type:'QA_TRANSACTION_IDLE',pid});await gate;await client.query('SELECT 1');},'acme'));
await consistentRead(store,'acme',async({store})=>{assert.equal(store.devices.find(d=>d.id===target.id).name,expected);});await closePostgres();await new Promise(ok=>process.send({type:'QA_CONNECTION_RECOVERED'},ok));process.disconnect();

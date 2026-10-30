// Separate process used only for a parent-owned disposable proof database.
import pg from 'pg';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spareAuditProofCache} from '../../server/spares-audit-proof.ts';
import {spareTransaction} from '../../server/spares-transaction.ts';
import {resident} from '../../server/capacity.ts';
const [database,marker]=process.argv.slice(2);assert.match(database||'',/^idms_spares_proof_qa_[a-f0-9]{12}$/);assert.match(marker||'',/^owned-spares-proof:[a-f0-9]{12}$/);
const runtime=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),app=JSON.parse(await readFile('.local/postgres-business.json','utf8')).tenants.acme,pool=new pg.Pool({host:runtime.host,port:runtime.port,user:app.user,password:app.password,database,max:1});
try{
 const initial=spareAuditProofCache.snapshot();assert.equal(initial.entries,0);
 await spareTransaction(pool,{tenantId:'qa'}, {},async c=>{const identity=(await c.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0];assert.equal(identity.marker,marker);const revision=(await c.query("SELECT revision::text FROM idms_spares.state WHERE tenant_id='qa'")).rows[0].revision;await spareAuditProofCache.verify(c,'qa',revision);});
 const after=spareAuditProofCache.snapshot();assert.ok(after.entries>0);assert.equal(resident.snapshot().categories.task,0);console.log(JSON.stringify({initialEntries:initial.entries,afterEntries:after.entries,bodyRows:after.bodyRows}));
}finally{spareAuditProofCache.clear();await pool.end();}

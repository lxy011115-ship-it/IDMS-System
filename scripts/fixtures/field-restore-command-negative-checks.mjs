import assert from 'node:assert/strict';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import pg from 'pg';
import {canonical} from '../../server/imports.ts';
import {quoteIdentifier as q} from '../../server/postgres-schema.ts';
import {closeSourceConnection} from '../field-source-freeze.mjs';
export async function exerciseRestoreCommandNegatives({authority,target,args,cli,expected}){
 const directory=dirname(args['--target-runtime-config']),op=args['--operation-id'],ops=resolve(directory,'recovery.json.operations');assert.match(basename(directory),/^formal-archive-[a-f0-9]{10}$/);assert.match(target.database,/^idms_fieldarchivetarget_[a-f0-9]{10}$/);
 const connect=async()=>{const c=new pg.Client({host:authority.host,port:authority.port,user:'idms_bootstrap',password:authority.bootstrapPassword,database:target.database});await c.connect();return c;};
 const image=async()=>{const c=await connect();try{return canonical({root:(await c.query('SELECT * FROM public.business_state')).rows,audits:(await c.query('SELECT * FROM public.audit_ledger ORDER BY sequence_no')).rows,sequence:(await c.query('SELECT last_value::text,is_called FROM public.audit_ledger_sequence_no_seq')).rows});}finally{await closeSourceConnection(c);}};
 const before=await image(),cases=[];
 async function refused(name){const r=await cli('restore-target',args,1);assert.match(r.code,/^FIELD_[A-Z0-9_]+$/);assert.equal(await image(),before);cases.push(name);}
 const resultFile=resolve(ops,op+'.restore-result.json'),original=await readFile(resultFile),result=JSON.parse(original);try{await writeFile(resultFile,canonical({...result,finalFactsSha256:'0'.repeat(64)}));await refused('conflicting-result-refused-without-rewriting-data');}finally{await writeFile(resultFile,original);}
 const plan=resolve(ops,op+'.restore-phase-data.json'),held=resolve(directory,'owned-held-data-plan.json');try{await rename(plan,held);await refused('missing-committed-plan-refused-without-recopy');}finally{await rename(held,plan);}
 let admin=await connect();try{await admin.query(`GRANT INSERT ON idms_field.receipts TO ${q(target.backupRole)}`);}finally{await closeSourceConnection(admin);}
 try{await refused('sealed-permission-drift-refused-without-repair');admin=await connect();try{assert.equal((await admin.query("SELECT has_table_privilege($1,'idms_field.receipts','INSERT') AS allowed",[target.backupRole])).rows[0].allowed,true);}finally{await closeSourceConnection(admin);}}finally{admin=await connect();try{await admin.query(`REVOKE INSERT ON idms_field.receipts FROM ${q(target.backupRole)}`);}finally{await closeSourceConnection(admin);}}
 const other=await connect();try{await refused('unknown-live-target-session-refused-without-termination');assert.equal((await other.query('SELECT 1 AS alive')).rows[0].alive,1);}finally{await closeSourceConnection(other);}
 const final=await cli('restore-target',args);assert.equal(final.uniqueVerificationAuditEventId,expected.uniqueVerificationAuditEventId);assert.equal(final.finalFactsSha256,expected.finalFactsSha256);assert.equal(await image(),before);
 return {actualRefusedCases:cases,rootAuditAndSequenceUnchangedAfterEveryRefusal:true,permissionDriftNotAutomaticallyRepaired:true,unknownSessionRemainsAlive:true,restoredOriginalPrivateRecordsThenExactRepeatVerified:true};
}

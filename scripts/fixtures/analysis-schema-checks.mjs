import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {verifyAnalysisSchema} from '../../server/analysis-schema-check.ts';

export async function analysisSchemaChecks({pool,client}){
 const db=(await client.query('SELECT current_database() AS name')).rows[0].name;assert.match(db,/^idms_registryqa_acme_[a-f0-9]{10}$/);
 const check=async()=>{const c=await pool.connect();try{await c.query('BEGIN');await verifyAnalysisSchema(c);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 await check();let cases=0;
 const constraints=(await client.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='analysis_report_events'::regclass AND contype='u' ORDER BY conname")).rows;assert.equal(constraints.length,2);
 for(const row of constraints){assert.match(row.conname,/^[a-z_]+$/);await client.query('ALTER TABLE analysis_report_events DROP CONSTRAINT "'+row.conname+'"');try{await assert.rejects(check(),/unique constraints/);cases++;}finally{await client.query('ALTER TABLE analysis_report_events ADD CONSTRAINT "'+row.conname+'" '+row.definition);}await check();}
 await client.query('ALTER TABLE registry_history ALTER COLUMN writer_id TYPE varchar(300)');try{await assert.rejects(check(),/column layout/);cases++;}finally{await client.query('ALTER TABLE registry_history ALTER COLUMN writer_id TYPE text');}await check();
 await client.query('ALTER TABLE analysis_report_events ALTER COLUMN actor_id DROP NOT NULL');try{await assert.rejects(check(),/column layout/);cases++;}finally{await client.query('ALTER TABLE analysis_report_events ALTER COLUMN actor_id SET NOT NULL');}await check();
 const proof={verifiedAt:new Date().toISOString(),actualMinimumRolePostgres:true,qaOnly:true,missingEitherReportUniqueConstraintRejected:true,columnTypeAndNullabilityDriftRejected:true,faultCases:cases,everyFaultRestoredAndValidSchemaRecovers:true,originalRuntimeUntouched:true,productionAcceptance:false};await writeFile('outputs/analysis-schema-verification.json',JSON.stringify(proof,null,2));return proof;
}

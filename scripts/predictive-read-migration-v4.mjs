import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PredictiveReadMigrationV4,validatePredictiveReadMigrationPlanV4} from '../server/predictive-read-migration-v4.ts';
import {privateNewFile} from './backup-support.mjs';
const [mode,configPath,planPath,...extra]=process.argv.slice(2);assert.ok(['plan','apply','step','status'].includes(mode)&&configPath&&planPath&&!extra.length,'Usage: predictive-read-migration-v4.mjs plan|apply|step|status <private-config> <private-plan>');
const read=async(p,maximum=64*1024*1024)=>{const file=resolve(p),info=await stat(file);assert.ok(info.isFile()&&info.size<=maximum,'Migration file exceeds its limit');return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));},v=await read(configPath,2*1024*1024);
assert.ok(v&&Object.keys(v).sort().join(',')==='account,binding,format,predictorBinding,purpose,sources,workflowBinding'&&v.format===1&&v.purpose==='PREDICTIVE_READ_MIGRATION','Invalid migration configuration');
assert.ok(v.account&&!v.account.connectionString&&typeof v.account.host==='string'&&typeof v.account.user==='string'&&typeof v.account.database==='string'&&(['127.0.0.1','localhost','::1'].includes(v.account.host)||v.account.ssl?.rejectUnauthorized===true),'Migration requires explicit account and loopback or verified TLS');
const migration=new PredictiveReadMigrationV4(v.account,v.binding,v);let p;
if(mode==='plan'){p=await migration.prepare();await privateNewFile(resolve(planPath),JSON.stringify(p));console.log(JSON.stringify({operationId:p.operationId,planDigest:p.digest,sourceRevision:p.sourceHead.revision,operations:p.operations.length,summary:p.summary,plannedOnly:true}));}
else{p=await read(planPath);validatePredictiveReadMigrationPlanV4(p);const checkpoint=await (mode==='apply'?migration.run(p):mode==='step'?migration.step(p):migration.status(p));console.log(JSON.stringify({operationId:p.operationId,planDigest:p.digest,phase:checkpoint.phase,next:checkpoint.next,steps:checkpoint.steps,summary:p.summary,legacyJobAdoptionComplete:false}));}

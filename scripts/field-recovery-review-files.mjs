import {open,opendir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {canonical} from '../server/imports.ts';
import {readMaintenanceJson} from './field-maintenance-record.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {reviewPlan,reviewBaseline,reviewAttempt,reviewResult,reviewFail} from './field-recovery-review-record.mjs';
const kinds={plan:reviewPlan,baseline:reviewBaseline,submit:reviewAttempt,approve:reviewAttempt,result:reviewResult};
export class FieldReviewFiles {
 #guard;#files;#dir;#op;
 constructor(guard,files){this.#guard=guard;this.#files=files;this.#op=files.currentIntent.operationId;this.#dir=files.controlFile+'.operations';}
 path(kind,id,extension='json'){if(!Object.hasOwn(kinds,kind)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))reviewFail('FIELD_REVIEW_FILE_INVALID');return resolve(this.#dir,this.#op+'.review-'+kind+'-'+id+'.'+extension);}
 async read(kind,id){try{return kinds[kind](await readMaintenanceJson(this.path(kind,id),1048576));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async plans(){const values=[];let count=0;for await(const e of await opendir(this.#dir)){if(!e.name.startsWith(this.#op+'.review-'))continue;if(++count>1024||!e.isFile())reviewFail('FIELD_REVIEW_JOURNAL_LIMIT');const m=e.name.match(/\.review-(baseline|plan|submit|approve|result)-([a-f0-9-]{36})\.json$/);if(m){const p=await this.read(m[1],m[2]);if(p.operationId!==this.#op||m[1]==='plan'&&p.planId!==m[2]||['submit','approve','result'].includes(m[1])&&p.attemptId!==m[2])reviewFail('FIELD_REVIEW_FILE_INVALID');if(m[1]==='plan')values.push(p);}}if(values.length>64)reviewFail('FIELD_REVIEW_PLAN_LIMIT');return values;}
 async write(kind,id,value){value=kinds[kind](value);if(value.operationId!==this.#op)reviewFail('FIELD_REVIEW_FILE_INVALID');await this.#guard.assertHeld();await this.#files.assertRestoring();const existing=await this.read(kind,id);if(existing){if(canonical(existing)!==canonical(value))reviewFail('FIELD_REVIEW_JOURNAL_CONFLICT');return existing;}const bytes=Buffer.from(canonical(value));if(bytes.length>1048576)reviewFail('FIELD_REVIEW_FILE_LIMIT');const stage=this.path(kind,id,'tmp');let handle;try{handle=await open(stage,'wx',0o600);await handle.writeFile(bytes);await handle.sync();}catch(e){if(e.code!=='EEXIST')throw e;if(sourceFreezeSha(await readMaintenanceJson(stage,1048576))!==sourceFreezeSha(value))reviewFail('FIELD_REVIEW_STAGING_CONFLICT');}finally{await handle?.close();}await this.#guard.nativeMove({mode:'Journal',controlFile:this.#files.controlFile,source:stage,destination:this.path(kind,id),expectedSha256:'MISSING'});const recorded=await this.read(kind,id);if(canonical(recorded)!==canonical(value))reviewFail('FIELD_REVIEW_PUBLICATION_UNCONFIRMED');return recorded;}
}

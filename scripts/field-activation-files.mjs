import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {canonical} from '../server/imports.ts';
import {readMaintenanceJson} from './field-maintenance-record.mjs';
import {activationAttempt,activationBaseline,activationPrepared,activationResult,activationFail as fail} from './field-activation-record.mjs';
const kinds={attempt:activationAttempt,baseline:activationBaseline,prepared:activationPrepared,result:activationResult};
export class FieldActivationFiles {
 #guard;#publication;
 constructor(guard,publication){this.#guard=guard;this.#publication=publication;}
 path(kind,extension='json'){const i=this.#publication.intent;if(!Object.hasOwn(kinds,kind)||!['json','tmp'].includes(extension))fail('FIELD_ACTIVATION_FILE_INVALID');return resolve(this.#publication.controlFile+'.operations',i.operationId+'.activation-'+kind+'-'+i.attemptId+'.'+extension);}
 async read(kind){try{const value=kinds[kind](await readMaintenanceJson(this.path(kind),1048576)),i=this.#publication.intent;if(value.operationId!==i.operationId||value.attemptId!==i.attemptId)fail('FIELD_ACTIVATION_FILE_BINDING_CHANGED');return value;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async write(kind,raw){
  const value=kinds[kind](raw),i=this.#publication.intent;if(value.operationId!==i.operationId||value.attemptId!==i.attemptId)fail('FIELD_ACTIVATION_FILE_BINDING_CHANGED');await this.#guard.assertHeld();const state=await this.#publication.inspect();if(kind==='result'?!state.released||state.control.state!=='ACTIVE':!state.markerPresent||state.control.state!=='RESTORING')fail('FIELD_ACTIVATION_FILE_PHASE_INVALID');
  const existing=await this.read(kind);if(existing){if(canonical(existing)!==canonical(value))fail('FIELD_ACTIVATION_FILE_CONFLICT');return existing;}
  const bytes=Buffer.from(canonical(value));if(bytes.length>1048576)fail('FIELD_ACTIVATION_FILE_LIMIT');const stage=this.path(kind,'tmp');let handle;
  try{handle=await open(stage,'wx',0o600);await handle.writeFile(bytes);await handle.sync();}catch(e){if(e.code!=='EEXIST')throw e;if(canonical(await readMaintenanceJson(stage,1048576))!==canonical(value))fail('FIELD_ACTIVATION_STAGING_CONFLICT');}finally{await handle?.close();}
  await this.#guard.nativeMove({mode:'Journal',controlFile:this.#publication.controlFile,source:stage,destination:this.path(kind),expectedSha256:'MISSING'});const recorded=await this.read(kind);if(canonical(recorded)!==canonical(value))fail('FIELD_ACTIVATION_FILE_UNCONFIRMED');return recorded;
 }
}

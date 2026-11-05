import {join,resolve} from 'node:path';
import {readFile,open,lstat,realpath} from 'node:fs/promises';
import {canonicalEqual,canonicalDigest} from '../server/canonical-state.ts';
import {baseRuntimeBinding} from './edge-recovery-binding.mjs';
import {jsonFile,filePin,runtimeSourceEvidence} from './existing-platform-binding.mjs';
import {spoolSourceDigest,spoolKeyDigest} from '../services/edge/spool-v2.ts';
export const recoveryNeed=(v,code)=>{if(!v)throw Error(code);};
export const sourceSummary=s=>({digest:s.digest,files:s.files});
export async function recoveryPin(path,max=262144){const pin=await filePin(path,{max});recoveryNeed(pin.path===path,'RECOVERY_LINKED_PROOF_REFUSED');return pin;}
export async function recoveryWrite(file,value){
 const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');let fd;
 try{fd=await open(file,'wx',0o600);await fd.writeFile(bytes);await fd.sync();}catch(error){if(error.code!=='EEXIST')throw error;const s=await lstat(file);recoveryNeed(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&await realpath(file)===file,'RECOVERY_RECORD_FILE_INVALID');recoveryNeed(canonicalEqual(JSON.parse(await readFile(file,'utf8')),value),'RECOVERY_RECORD_CHANGED');}finally{await fd?.close();}
}
export async function recoveryOperation(p,directory,{sourceEvidence=runtimeSourceEvidence}={}){
 const planFile=join(directory,'plan.private.json'),beforeFile=join(directory,'binding-before.json'),plan=await jsonFile(planFile,262144),before=await jsonFile(beforeFile,262144),beforePin=await recoveryPin(beforeFile),source=sourceSummary(await sourceEvidence());
 recoveryNeed(plan.format==='IDMS_EDGE_RECOVERY_PLAN_V2'&&plan.project===p.binding.project&&directory===resolve(plan.project,'.local/edge-recovery',plan.operationId)&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(plan.operationId),'RECOVERY_PLAN_CONTEXT_INVALID');
 recoveryNeed(before.format===1&&canonicalEqual(before,baseRuntimeBinding(p.binding))&&beforePin.sha256===plan.originalBindingSha256,'RECOVERY_ORIGINAL_BINDING_CHANGED');
 recoveryNeed(canonicalEqual(sourceSummary(plan.sourceBefore),source)&&canonicalEqual(sourceSummary(plan.sourceAfter),source),'RECOVERY_PLAN_SOURCE_CHANGED');
 recoveryNeed(plan.sourceDigest===spoolSourceDigest(p.source)&&plan.keyDigest===spoolKeyDigest(p.source)&&plan.structureAndPrivilegesUnchanged===true&&plan.originalSchemaVersion===0&&plan.authority?.digest===canonicalDigest(plan.authority.evidence),'RECOVERY_PLAN_AUTHORITY_INVALID');
 const q=plan.proposal;recoveryNeed(q?.format==='IDMS_EDGE_RECOVERY_PROPOSAL_V2'&&q.operationId===plan.operationId&&q.path===p.spool&&q.sourceDigest===plan.sourceDigest&&q.keyDigest===plan.keyDigest&&q.postgresDigest===plan.authority?.digest&&q.durableSequence===plan.authority.evidence?.durableSequence&&[q.device,q.inode].every(v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,39})$/.test(v)),'RECOVERY_PLAN_PROPOSAL_INVALID');
 return {plan,before,beforePin,planPin:await recoveryPin(planFile),source,directory};
}

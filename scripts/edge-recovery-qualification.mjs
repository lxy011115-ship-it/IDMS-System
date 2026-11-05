import {open,lstat} from 'node:fs/promises';
import {join,resolve,dirname,basename,relative,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';
import {canonicalEqual,canonicalDigest} from '../server/canonical-state.ts';
import {privateDirectory} from './backup-support.mjs';
import {jsonFile,verifyPin} from './existing-platform-binding.mjs';
import {processFacts,sameProcess} from './existing-platform-process.mjs';
import {recoveryLocalRelease,recoveryRelease} from './edge-recovery-release.mjs';
import {recoveryNeed as need,recoveryPin,recoveryWrite} from './edge-recovery-operation.mjs';
import {recoveryCases,validateRecoveryCase} from './edge-recovery-cases.mjs';
const present=async p=>{try{await lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
function reportPath(kind,path){const c=recoveryCases[kind];need(typeof path==='string'&&path===resolve(path)&&dirname(dirname(path))===resolve(c.root)&&/^[a-f0-9]{12}$/.test(basename(dirname(path)))&&basename(path)===c.name,'RECOVERY_CASE_REPORT_PATH_INVALID');return path;}
async function checkReport(kind,pin,source){
 reportPath(kind,pin.path);await verifyPin(pin);const report=await jsonFile(pin.path,524288);validateRecoveryCase(kind,report,source);
 for(const p of report.sourceAfter?.caseSourcePins||[]){need(typeof p.path==='string','RECOVERY_CASE_PIN_PATH_INVALID');const rel=relative(resolve('.'),resolve(p.path));need(!isAbsolute(rel)&&!rel.startsWith('..')&&!isAbsolute(p.path)&&p.path.replaceAll('\\','/')===rel.replaceAll('\\','/'),'RECOVERY_CASE_PIN_PATH_INVALID');const actual=await recoveryPin(resolve(p.path));need(actual.sha256===p.sha256,'RECOVERY_CASE_SCRIPT_CHANGED');}
 return report;
}
async function caseProof(kind,context,p,output){
 const directory=join(context.directory,'qualification'),intentFile=join(directory,kind+'.intent.private.json'),startedFile=join(directory,kind+'.started.private.json'),terminalFile=join(directory,kind+'.terminal.private.json'),script=await recoveryPin(resolve(recoveryCases[kind].script)),intent={format:'IDMS_RECOVERY_QA_INTENT_V1',operationId:context.plan.operationId,kind,plan:context.planPin,source:context.source,release:context.release,script};
 await recoveryWrite(intentFile,intent);const contextDigest=canonicalDigest(intent);
 if(await present(terminalFile)){
  const t=await jsonFile(terminalFile,16384),s=await jsonFile(startedFile,16384);need(t.contextDigest===contextDigest&&s.contextDigest===contextDigest&&sameProcess(s.process,t.process)&&t.exitCode===0&&t.signal===null&&t.stdoutClosed&&t.stderrClosed&&!t.outputOverflow&&t.report,'RECOVERY_QUALIFICATION_TERMINAL_INVALID');await checkReport(kind,t.report,context.source);return {kind,script,report:t.report,terminal:await recoveryPin(terminalFile)};
 }
 if(await present(startedFile)){
  const prior=await jsonFile(startedFile,16384);need(prior.contextDigest===contextDigest,'RECOVERY_QUALIFICATION_CHILD_CONTEXT_CHANGED');const current=await processFacts(prior.process.pid);throw Error(current?(sameProcess(prior.process,current)?'RECOVERY_QUALIFICATION_CHILD_STILL_RUNNING':'RECOVERY_QUALIFICATION_CHILD_PID_REUSED'):'RECOVERY_QUALIFICATION_CHILD_RESULT_UNCONFIRMED');
 }
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^IDMS_|^NODE_OPTIONS$|^NODE_ENV$/.test(key)));
 const log=await open(join(directory,kind+'.private.log'),'wx',0o600);let tail='',bytes=0,overflow=false,writes=Promise.resolve();
 const child=spawn(process.execPath,['--max-old-space-size=1024',script.path],{cwd:resolve('.'),env:{...env,NODE_OPTIONS:'',NODE_ENV:'development',IDMS_QA_PG_BIN:dirname(p.binding.files.pgCtl.path),IDMS_QA_MQTT_BIN:dirname(p.binding.files.brokerExe.path)},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const append=b=>{const part=b.subarray(0,Math.max(0,262144-bytes));bytes+=b.length;if(bytes>262144)overflow=true;if(part.length)writes=writes.then(()=>log.write(part));tail=(tail+b.toString('utf8')).slice(-16384);};for(const stream of [child.stdout,child.stderr])stream.on('data',append);
 const terminal=new Promise(ok=>{child.once('error',error=>ok({spawnError:error.code}));child.once('close',(exitCode,signal)=>ok({exitCode,signal,stdoutClosed:child.stdout.closed,stderrClosed:child.stderr.closed}));});
 const identity=await processFacts(child.pid);need(identity,'RECOVERY_QUALIFICATION_CHILD_START_UNCONFIRMED');await recoveryWrite(startedFile,{format:'IDMS_RECOVERY_QA_STARTED_V1',contextDigest,process:identity});const end=await terminal;await writes;await log.close();
 const result=tail.trim().split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).findLast(r=>r&&typeof r.evidence==='string');
 let report=null;if(result)report=await recoveryPin(reportPath(kind,resolve(result.evidence)),524288);
 await recoveryWrite(terminalFile,{format:'IDMS_RECOVERY_QA_TERMINAL_V1',contextDigest,process:identity,...end,outputOverflow:overflow,report});need(!overflow&&end.exitCode===0&&end.signal===null&&end.stdoutClosed&&end.stderrClosed&&result?.passed===true&&report,'RECOVERY_QUALIFICATION_CASE_UNCONFIRMED');await checkReport(kind,report,context.source);output(JSON.stringify({stage:'QUALIFICATION_CASE_PASSED',kind}));return {kind,script,report,terminal:await recoveryPin(terminalFile)};
}
export async function qualifyRecovery(context,p,{assertStopped,output=console.log}={}){
 need(typeof assertStopped==='function','RECOVERY_QUALIFICATION_STOP_PROOF_REQUIRED');await assertStopped();
 if(await present(join(context.directory,'qualification.private.json'))){const q=await verifyRecoveryQualification(context);return {status:'RECOVERY_QUALIFIED',operationId:q.operationId,cases:q.cases.map(c=>c.kind),head:q.release.head,sqliteMigrated:false,replayed:true};}
 const directory=join(context.directory,'qualification'),firstIntent=join(directory,'memory.intent.private.json'),prior=await present(firstIntent)?await jsonFile(firstIntent,16384):null,release=await recoveryRelease(prior?.release);await privateDirectory(directory);const c={...context,release};const cases=[];
 for(const kind of Object.keys(recoveryCases)){need(canonicalEqual(await recoveryLocalRelease(),Object.fromEntries(['head','tree','branch','manifestSha256'].map(k=>[k,release[k]]))),'RECOVERY_RELEASE_CHANGED_DURING_QUALIFICATION');await assertStopped();cases.push(await caseProof(kind,c,p,output));}
 await assertStopped();await recoveryRelease(release);const value={format:'IDMS_EDGE_RECOVERY_QUALIFIED_V1',operationId:context.plan.operationId,plan:context.planPin,source:context.source,release,cases};await recoveryWrite(join(context.directory,'qualification.private.json'),value);return {status:'RECOVERY_QUALIFIED',operationId:value.operationId,cases:cases.map(c=>c.kind),head:release.head,sqliteMigrated:false};
}
export async function verifyRecoveryQualification(context){
 const file=join(context.directory,'qualification.private.json'),q=await jsonFile(file,262144);need(q.format==='IDMS_EDGE_RECOVERY_QUALIFIED_V1'&&q.operationId===context.plan.operationId&&canonicalEqual(q.plan,context.planPin)&&canonicalEqual(q.source,context.source)&&Array.isArray(q.cases)&&canonicalEqual(q.cases.map(c=>c.kind),Object.keys(recoveryCases)),'RECOVERY_QUALIFICATION_BINDING_INVALID');await verifyPin(q.plan);await recoveryRelease(q.release);
 for(const c of q.cases){need(c.script.path===resolve(recoveryCases[c.kind].script)&&c.terminal.path===join(context.directory,'qualification',c.kind+'.terminal.private.json'),'RECOVERY_QUALIFICATION_PATH_INVALID');await verifyPin(c.script);await verifyPin(c.terminal);const t=await jsonFile(c.terminal.path,16384),intent=await jsonFile(join(context.directory,'qualification',c.kind+'.intent.private.json'),16384),started=await jsonFile(join(context.directory,'qualification',c.kind+'.started.private.json'),16384);need(t.format==='IDMS_RECOVERY_QA_TERMINAL_V1'&&intent.format==='IDMS_RECOVERY_QA_INTENT_V1'&&intent.operationId===q.operationId&&intent.kind===c.kind&&t.contextDigest===canonicalDigest(intent)&&started.contextDigest===t.contextDigest&&sameProcess(started.process,t.process)&&canonicalEqual(intent.release,q.release)&&canonicalEqual(intent.plan,q.plan)&&canonicalEqual(intent.script,c.script)&&canonicalEqual(intent.source,q.source)&&t.exitCode===0&&t.signal===null&&t.stdoutClosed&&t.stderrClosed&&!t.outputOverflow&&canonicalEqual(t.report,c.report),'RECOVERY_QUALIFICATION_TERMINAL_INVALID');await checkReport(c.kind,c.report,context.source);}
 return {...q,pin:await recoveryPin(file)};
}

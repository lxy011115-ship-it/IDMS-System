import {DatabaseSync} from 'node:sqlite';
import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
import {createColdCurrentDeploymentReviewContractV1,validateColdCurrentDeploymentReviewContractV1,assertFreshColdCurrentDeploymentReviewIntentV1,initializeColdCurrentDeploymentReviewIntentV1,readColdCurrentDeploymentReviewIntentV1,closeColdCurrentDeploymentReviewInitializationV1} from './cold-current-deployment-review-contract-v1.mjs';

const owners=new WeakMap(),anchorName='currentDeploymentReviewContextFile',maximumBytes=2*1024**2;
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const normal=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const absolute=path=>typeof path==='string'&&path.length<=4096&&isAbsolute(path)&&resolve(path)===path&&!/[\u0000-\u001f\u007f]/.test(path);
const same=(a,b)=>canonical(a)===canonical(b);
const inside=(file,root)=>{const part=relative(normal(root),normal(file));return part===''||part!=='..'&&!part.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(part);};
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const identity=stat=>Object.fromEntries(['dev','ino','nlink','size','mtimeNs','ctimeNs'].map(key=>[key,String(stat[key])]));
function clear(record){if(!record||typeof record!=='object')return;record.journalKey='';if(record.readerCredentials&&typeof record.readerCredentials==='object'){record.readerCredentials.key='';if(Array.isArray(record.readerCredentials.readers))for(const reader of record.readerCredentials.readers)if(reader&&typeof reader==='object'){reader.password='';reader.token='';}}}
function owned(handle,closing=false){const owner=owners.get(handle);need(owner&&!owner.closed&&(closing||!owner.closing)&&!owner.failed,'CURRENT_DEPLOYMENT_CONTEXT_OWNER_NOT_MINTED');return owner;}
function current(owner){need(!owner.closing&&!owner.closed&&!owner.failed,'CURRENT_DEPLOYMENT_CONTEXT_OWNER_CLOSED');}

async function directoryChain(path){
  const chain=[];for(let current=path;;current=dirname(current)){const stat=await lstat(current,{bigint:true});need(stat.isDirectory()&&!stat.isSymbolicLink()&&normal(await realpath(current))===normal(current),'CURRENT_DEPLOYMENT_CONTEXT_DIRECTORY');chain.push({path:current,dev:String(stat.dev),ino:String(stat.ino)});if(dirname(current)===current)break;}return chain;
}
async function readPrivateFile(file){
  let handle,bytes;try{
    const directories=await directoryChain(dirname(file)),before=await lstat(file,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size>0n&&before.size<=BigInt(maximumBytes)&&normal(await realpath(file))===normal(file),'CURRENT_DEPLOYMENT_CONTEXT_FILE_TYPE');
    handle=await open(file,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0));need(same(identity(await handle.stat({bigint:true})),identity(before)),'CURRENT_DEPLOYMENT_CONTEXT_FILE_CHANGED');bytes=Buffer.alloc(Number(before.size));let at=0;while(at<bytes.length){const read=await handle.read(bytes,at,bytes.length-at,at);need(read.bytesRead>0,'CURRENT_DEPLOYMENT_CONTEXT_FILE_CHANGED');at+=read.bytesRead;}need((await handle.read(Buffer.alloc(1),0,1,at)).bytesRead===0,'CURRENT_DEPLOYMENT_CONTEXT_FILE_CHANGED');
    const after=await lstat(file,{bigint:true});need(after.isFile()&&!after.isSymbolicLink()&&same(identity(before),identity(after))&&same(identity(await handle.stat({bigint:true})),identity(before))&&same(await directoryChain(dirname(file)),directories),'CURRENT_DEPLOYMENT_CONTEXT_FILE_CHANGED');const text=new TextDecoder('utf8',{fatal:true}).decode(bytes),record=JSON.parse(text);need(canonical(record)===text,'CURRENT_DEPLOYMENT_CONTEXT_CANONICAL');return{record,snapshot:{file,sha256:hash(bytes),identity:identity(before),directories}};
  }catch(error){if(error.code==='ENOENT')throw Object.assign(Error('CURRENT_DEPLOYMENT_CONTEXT_FILE_MISSING'),{code:'CURRENT_DEPLOYMENT_CONTEXT_FILE_MISSING'});throw error;}finally{bytes?.fill(0);await handle?.close();}
}
async function verifyFile(owner){
  current(owner);let loaded;try{loaded=await readPrivateFile(owner.file);need(same(loaded.snapshot,owner.snapshot),'CURRENT_DEPLOYMENT_CONTEXT_FILE_CHANGED');validateColdCurrentDeploymentReviewContractV1(loaded.record,owner.context,owner.intentSha256);current(owner);}catch(error){owner.failed=true;throw error;}finally{clear(loaded?.record);}
}
function operation(handle,work){
  const owner=owned(handle);need(!owner.active,'CURRENT_DEPLOYMENT_CONTEXT_BUSY');let job;job=Promise.resolve().then(()=>{current(owner);return work(owner);}).then(value=>{current(owner);return value;}).finally(()=>{if(owner.active===job)owner.active=null;});owner.active=job;return job;
}
function descriptor(owner){const body=owner.privateRecord.intent.body;return{format:'COLD_CURRENT_DEPLOYMENT_CONTEXT_FILE_V1',purpose:body.purpose,controlId:body.controlId,sourceHash:body.sourceHash,reviewId:body.reviewId,operationId:body.operationId,intentSha256:owner.intentSha256,file:owner.snapshot};}
function fileSignature(owner,body){const key=Buffer.from(owner.privateRecord.journalKey,'hex');try{return createHmac('sha256',key).update('IDMS_CURRENT_DEPLOYMENT_CONTEXT_FILE_BINDING_V1\n'+canonical(body)).digest('hex');}finally{key.fill(0);}}
function verifyDescriptor(owner,details){const value=details[anchorName],body=descriptor(owner);need(exact(value,['body','signature'])&&same(value.body,body)&&typeof value.signature==='string'&&/^[a-f0-9]{64}$/.test(value.signature)&&timingSafeEqual(Buffer.from(value.signature,'hex'),Buffer.from(fileSignature(owner,body),'hex')),'CURRENT_DEPLOYMENT_CONTEXT_FILE_ANCHOR');}

/**
 * Fixed operation directory is a durable tombstone. Only its exclusive first
 * creator keeps a storage initializer. Existing or incomplete directories never
 * obtain a new initializer, reader key, intent time or runtime authority.
 */
export async function prepareColdCurrentDeploymentContextFileV1(raw){
  need(exact(raw,['context','request','workDirectory'])&&absolute(raw.workDirectory),'CURRENT_DEPLOYMENT_CONTEXT_FILES_REQUEST');const context=structuredClone(raw.context),request=structuredClone(raw.request),provisional=createColdCurrentDeploymentReviewContractV1(context,request);let keepInitializer=false,loaded;
  try{
    const work=raw.workDirectory,forbidden=[context.source.inventory.identity.directory,context.targetDirectory,dirname(context.trust.storeFile),context.originalReview.directory];need(forbidden.every(path=>typeof path==='string'&&path.length<=4096&&isAbsolute(path)&&!/[\u0000-\u001f\u007f]/.test(path)&&!inside(work,resolve(path))),'CURRENT_DEPLOYMENT_CONTEXT_IN_PROTECTED_DIRECTORY');await directoryChain(work);
    const directory=join(work,'current-deployment-context-'+request.operationId),file=join(directory,'context.private.json');let created=false;try{await mkdir(directory,{recursive:false,mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
    if(created){await privateDirectory(directory);await privateNewFile(file,canonical(provisional.privateRecord));loaded=await readPrivateFile(file);need(loaded.snapshot.sha256===hash(canonical(provisional.privateRecord)),'CURRENT_DEPLOYMENT_CONTEXT_FILE_CHANGED');}
    else loaded=await readPrivateFile(file);
    const expected=loaded.record.intent?.sha256,validated=validateColdCurrentDeploymentReviewContractV1(loaded.record,context,expected);need(validated.intent.body.reviewId===request.reviewId&&validated.intent.body.operationId===request.operationId,'CURRENT_DEPLOYMENT_CONTEXT_OPERATION_REBOUND');
    const handle=Object.freeze({}),owner={context,privateRecord:validated,intentSha256:expected,file,snapshot:loaded.snapshot,created,initialization:created?provisional.initialization:null,storageAttempted:false,recordAuthenticated:false,active:null,closing:false,closed:false,failed:false,closeJob:null};owners.set(handle,owner);keepInitializer=created;return handle;
  }finally{clear(loaded?.record);clear(provisional.privateRecord);if(!keepInitializer)closeColdCurrentDeploymentReviewInitializationV1(provisional.initialization);}
}

function controlTransaction(owner,raw,requireStored){
  need(exact(raw,['db','details'])&&raw.db instanceof DatabaseSync&&raw.db.isOpen&&raw.db.isTransaction===true,'CURRENT_DEPLOYMENT_ORIGINAL_TRANSACTION_REQUIRED');
  let rows;try{rows=raw.db.prepare('SELECT control_id,body,body_hash,phase,details,details_hash FROM cold_control WHERE id=1').all();}catch{need(false,'CURRENT_DEPLOYMENT_CONTROL_SOURCE');}
  need(rows.length===1,'CURRENT_DEPLOYMENT_CONTROL_SOURCE');const row=rows[0],context=owner.context;
  need(row.control_id===context.trust.controlId&&row.body_hash===context.trust.sourceHash&&hash(row.body)===context.trust.sourceHash&&row.body===canonical(context.source)&&row.phase==='REVIEW_READY_V3','CURRENT_DEPLOYMENT_CONTROL_SOURCE');
  need(typeof row.details==='string'&&hash(row.details)===row.details_hash,'CURRENT_DEPLOYMENT_CONTROL_DETAILS');let saved;try{saved=JSON.parse(row.details);}catch{need(false,'CURRENT_DEPLOYMENT_CONTROL_DETAILS');}
  need(saved&&Object.getPrototypeOf(saved)===Object.prototype&&canonical(saved)===row.details&&hash(saved.review)===owner.privateRecord.intent.body.originalIntentSha256,'CURRENT_DEPLOYMENT_CONTROL_ORIGINAL_INTENT');
  need(raw.details&&Object.getPrototypeOf(raw.details)===Object.prototype&&hash(raw.details.review)===owner.privateRecord.intent.body.originalIntentSha256,'CURRENT_DEPLOYMENT_ORIGINAL_INTENT_CHANGED');
  if(requireStored)need(['currentDeploymentReview','currentDeploymentReviewContextFile'].every(name=>Object.hasOwn(saved,name)&&Object.hasOwn(raw.details,name)&&same(saved[name],raw.details[name])),'CURRENT_DEPLOYMENT_STORED_CONTEXT_REQUIRED');
}
function authenticatedStored(owner,raw){
  controlTransaction(owner,raw,true);const value=readColdCurrentDeploymentReviewIntentV1({db:raw.db,details:raw.details,context:owner.context,privateRecord:owner.privateRecord,expectedIntentSha256:owner.intentSha256});verifyDescriptor(owner,raw.details);return value;
}

/** Data/storage operation only. The original coordinator must own and commit the transaction. */
export function recordColdCurrentDeploymentContextFileV1(handle,raw){
  return operation(handle,async owner=>{
    owner.recordAuthenticated=false;controlTransaction(owner,raw,false);await verifyFile(owner);let value;
    if(owner.created&&!owner.storageAttempted){
      need(!Object.hasOwn(raw.details,anchorName),'CURRENT_DEPLOYMENT_CONTEXT_FILE_ANCHOR');owner.storageAttempted=true;
      try{value=initializeColdCurrentDeploymentReviewIntentV1({db:raw.db,details:raw.details,initialization:owner.initialization});need(!value.alreadyRecorded,'CURRENT_DEPLOYMENT_CONTEXT_INITIALIZATION_CHANGED');const body=descriptor(owner);raw.details[anchorName]={body,signature:fileSignature(owner,body)};}catch(error){owner.failed=true;throw error;}
    }else{
      value={...authenticatedStored(owner,raw),alreadyRecorded:true};
    }
    await verifyFile(owner);owner.recordAuthenticated=true;return{...value,privateContextFileBound:true,originalFileIdentityAndBytesRechecked:true,createdContextFile:owner.created,reopenedContextFile:!owner.created};
  });
}

/** Private credentials remain inaccessible until the corresponding row and both anchors authenticate. */
export function readColdCurrentDeploymentContextPrivateV1(handle,raw){
  return operation(handle,async owner=>{need(owner.recordAuthenticated,'CURRENT_DEPLOYMENT_RECORDED_CONTEXT_REQUIRED');owner.recordAuthenticated=false;await verifyFile(owner);authenticatedStored(owner,raw);assertFreshColdCurrentDeploymentReviewIntentV1(owner.privateRecord,owner.context,owner.intentSha256);await verifyFile(owner);owner.recordAuthenticated=true;return structuredClone(owner.privateRecord);});
}
export function revalidateColdCurrentDeploymentContextFileV1(handle){return operation(handle,async owner=>{await verifyFile(owner);return{intentSha256:owner.intentSha256,privateContextFileBound:true,historicalDataOnly:true,ownedRuntimeSessionMinted:false};});}
export function inspectColdCurrentDeploymentContextFileV1(handle){const owner=owned(handle),body=owner.privateRecord.intent.body;return Object.freeze({format:'COLD_CURRENT_DEPLOYMENT_CONTEXT_FILE_STATUS_V1',purpose:body.purpose,reviewId:body.reviewId,operationId:body.operationId,intentSha256:owner.intentSha256,createdContextFile:owner.created,reopenedContextFile:!owner.created,recordAuthenticated:owner.recordAuthenticated,createdAt:body.createdAt,expiresAt:body.expiresAt,historicalDataOnly:true,ownedRuntimeSessionMinted:false,programStartupGranted:false,mqttApplicationProbeGranted:false,businessWritesEnabled:false,formalFieldActivationGranted:false});}
export function closeColdCurrentDeploymentContextFileV1(handle){
  const owner=owners.get(handle);need(owner,'CURRENT_DEPLOYMENT_CONTEXT_OWNER_NOT_MINTED');if(owner.closeJob)return owner.closeJob;owner.closing=true;owner.closeJob=(async()=>{await owner.active?.catch(()=>{});if(owner.initialization)closeColdCurrentDeploymentReviewInitializationV1(owner.initialization);clear(owner.privateRecord);owner.privateRecord=null;owner.context=null;owner.closed=true;return Object.freeze({format:'COLD_CURRENT_DEPLOYMENT_CONTEXT_FILE_CLOSED_V1',privateContextFileRetained:true,storageInitializerClosed:true,sqlOrRunningProgramsOwned:false});})();return owner.closeJob;
}

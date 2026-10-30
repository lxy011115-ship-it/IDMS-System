import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readApplicationFileV1,collectApplicationJsonGraphV1} from './runtime-application-config-v1.mjs';
import {loadRuntimeColdSiteV1,createRuntimeColdSiteHttpV1} from './runtime-cold-portable-entry-v1.mjs';
import {createFieldMapAuthorityGatewayV1,fieldMapAuthorityGatewayConfigV1} from './field-map-authority-gateway-v1.mjs';

const need=(v,code)=>{if(!v)throw Error(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const code=e=>/^[A-Z][A-Z0-9_]{3,120}$/.test(e?.message??'')?e.message:'FIELD_SITE_OPERATION_FAILED';
export function fieldMapSiteRuntimeConfigV1(raw){
 need(exact(raw,['format','purpose','baseRuntimeFile','field'])&&raw.format===1&&raw.purpose==='FIELD_MAP_SITE_RUNTIME_V1'&&text(raw.baseRuntimeFile)&&raw.field&&typeof raw.field.enabled==='boolean','FIELD_SITE_FIELDS');
 need(raw.field.enabled?exact(raw.field,['enabled','gatewayFile'])&&text(raw.field.gatewayFile):exact(raw.field,['enabled']),'FIELD_SITE_FIELD_CONFIG');return structuredClone(raw);
}

/** Own the pending SITE loader as well as the eventual field gateway. */
export function createFieldMapSiteRuntimeV1(file,{startupSignal}={}){
 need(text(file)&&(startupSignal===undefined||startupSignal instanceof AbortSignal),'FIELD_SITE_ARGUMENTS');const path=resolve(file),owner=randomUUID(),active=new Set(),pins=new Map();let base=null,browserHttp=null,gateway=null,phase='STARTING',closing=false,closed=false,requestId=null,closeJob=null,disposeJob=null,fieldStopJob=null,failure=null,readySucceeded=false;
 const cancelled=()=>{need(!closing&&!startupSignal?.aborted,'FIELD_SITE_CANCELLED');};
 const externalAbort=()=>queueMicrotask(()=>{void api.close().catch(()=>{});});startupSignal?.addEventListener('abort',externalAbort,{once:true});if(startupSignal?.aborted)externalAbort();
 async function json(file){const item=await readApplicationFileV1(file);if(pins.has(item.path))need(pins.get(item.path)===item.sha256,'FIELD_SITE_INPUT_CHANGED');else pins.set(item.path,item.sha256);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,''));}
 async function checkInputs(){cancelled();for(const [file,digest]of pins){need((await readApplicationFileV1(file)).sha256===digest,'FIELD_SITE_INPUT_CHANGED');cancelled();}}
 function selectRequest(input){need(exact(input,Object.keys(input))&&Object.keys(input).every(k=>k==='requestId')&&(input.requestId===undefined||uuid(input.requestId)),'FIELD_SITE_STOP_REQUEST');if(requestId)need(input.requestId===undefined||input.requestId===requestId,'FIELD_SITE_STOP_REQUEST_CHANGED');else requestId=input.requestId??randomUUID();}
 function stopField(){if(gateway&&!fieldStopJob){fieldStopJob=gateway.close({requestId});void fieldStopJob.catch(()=>{});}return fieldStopJob??Promise.resolve(null);}
 async function dispose(){return disposeJob??=(async()=>{const fields=await Promise.allSettled([stopField()]);await Promise.allSettled([...active]);let baseError=null;try{await base?.close();}catch(e){baseError=e;}need(fields.every(r=>r.status==='fulfilled')&&!baseError,'FIELD_SITE_DRAIN_FAILED');need(!gateway||gateway.state().closed&&gateway.state().activeHttp===0,'FIELD_SITE_FIELD_RETIREMENT_UNPROVEN');closed=true;})();}
 const api={owner,get ready(){return ready;},get config(){return base?.config;},get base(){return base?.base;},get coldGuard(){return base?.coldGuard;},fieldSnapshot(tenant){return gateway?.publicSnapshot(tenant)??null;},state(){return Object.freeze({format:'FIELD_MAP_SITE_STATE_V1',owner,phase,closing,closed,ready:readySucceeded&&!closing&&!closed&&(!gateway||gateway.state().ready),activeHttp:active.size,failure,field:gateway?.state()??null});},async assertCurrent(){await checkInputs();need(readySucceeded&&base,'FIELD_SITE_NOT_READY');return base.coldGuard.assertCurrent();},async handleHttp(req,res){
  if(closing||!readySucceeded){req.resume();if(!res.destroyed&&!res.writableEnded){res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({error:'系统维护中，请稍后重试'}));}return;}
  const job=Promise.resolve().then(async()=>{await checkInputs();if(gateway&&await gateway.handleHttp(req,res))return;await browserHttp(req,res);});active.add(job);try{await job;}finally{active.delete(job);}
 },requestStop(input={}){selectRequest(input);if(!closing){closing=true;phase='STOPPING';}return stopField();},close(input={}){
  selectRequest(input);if(closeJob)return closeJob;closing=true;phase='STOPPING';stopField();closeJob=(async()=>{await ready.catch(()=>{});await dispose();phase=failure?'FAILED':'CLOSED';startupSignal?.removeEventListener('abort',externalAbort);return Object.freeze({format:'FIELD_MAP_SITE_TERMINAL_V1',owner,requestId,normal:!failure,startupCancelled:!readySucceeded&&!failure,allOwnedResourcesRetired:true,state:api.state()});})();return closeJob;
 }};
 const ready=Promise.resolve().then(async()=>{
  try{cancelled();const config=fieldMapSiteRuntimeConfigV1(await json(path));for(const p of await collectApplicationJsonGraphV1([path])){if(pins.has(p.path))need(pins.get(p.path)===p.sha256,'FIELD_SITE_INPUT_CHANGED');else pins.set(p.path,p.sha256);}await checkInputs();const baseFile=resolve(dirname(path),config.baseRuntimeFile);need(baseFile!==path,'FIELD_SITE_BASE_ALIAS');
   const entry=await json(baseFile);need(exact(entry,['format','purpose','baseRuntimeFile','trustFile'])&&entry.format===1&&entry.purpose==='RUNTIME_COLD_SITE_V1'&&text(entry.baseRuntimeFile)&&text(entry.trustFile),'FIELD_SITE_COLD_ENTRY');const authorityEntryFile=resolve(dirname(baseFile),entry.baseRuntimeFile),authorityEntry=await json(authorityEntryFile);need(exact(authorityEntry,['format','purpose','baseRuntimeFile','authorityRuntimeFile'])&&authorityEntry.format===1&&authorityEntry.purpose==='SITE_CONSOLE_AUTHORITY_V1'&&text(authorityEntry.baseRuntimeFile)&&text(authorityEntry.authorityRuntimeFile),'FIELD_SITE_AUTHORITY_ENTRY');
   let gatewayFile;if(config.field.enabled){gatewayFile=resolve(dirname(path),config.field.gatewayFile);need(gatewayFile!==path&&gatewayFile!==baseFile,'FIELD_SITE_GATEWAY_ALIAS');need(fieldMapAuthorityGatewayConfigV1(await json(gatewayFile)).enabled,'FIELD_SITE_GATEWAY_DISABLED_CONFLICT');}
   base=await loadRuntimeColdSiteV1(baseFile);await checkInputs();const current=await base.coldGuard.assertCurrent();await checkInputs();browserHttp=await createRuntimeColdSiteHttpV1(base);
   if(config.field.enabled){const tenants=[...base.base.members].map(([tenantId,m])=>{const b=m.config.business;return{tenantId,host:b.account.host,port:b.account.port,database:b.account.database,databaseOid:b.binding.databaseOid,catalogHash:b.binding.catalogHash};});gateway=createFieldMapAuthorityGatewayV1(gatewayFile,{siteBinding:{trustFile:resolve(dirname(baseFile),entry.trustFile),authorityRuntimeFile:resolve(dirname(authorityEntryFile),authorityEntry.authorityRuntimeFile),sourceDirectory:current.source.inventory.identity.directory,targetDirectory:current.details.targetDirectory,tenants}});await gateway.ready;await checkInputs();}
   readySucceeded=true;phase='READY';return api.state();
  }catch(error){if(!closing&&!startupSignal?.aborted)failure=code(error);if(!requestId)requestId=randomUUID();closing=true;stopField();await dispose();phase=failure?'FAILED':'CLOSED';throw error;}
 });void ready.catch(()=>{});return api;
}

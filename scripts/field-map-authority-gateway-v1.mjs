import {randomUUID} from 'node:crypto';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {loadFieldMapAuthorityHostV1,fieldMapAuthorityHostConfigV1} from './field-map-authority-host-v1.mjs';
import {FieldMapPlatformV1} from '../server/field-map-platform-v1.ts';
import {FieldMapMqttIntakeV1} from '../server/field-map-mqtt-v1.ts';
import {createFieldMapHttpHandlerV1} from '../server/field-map-http-v1.ts';

const need=(v,code)=>{if(!v)throw Error(code);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const text=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\u0000-\u001f\u007f]/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const normal=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
const same=(a,b)=>normal(a)===normal(b);
const outside=(file,dir)=>{const p=relative(normal(dir),normal(file));return p!==''&&(p==='..'||p.startsWith('../')||p.startsWith('..\\')||isAbsolute(p));};
const safeCode=e=>/^[A-Z][A-Z0-9_]{3,120}$/.test(e?.message??'')?e.message:'FIELD_GATEWAY_OPERATION_FAILED';
const routes=new Set(['/api/v1/field-channel/lease','/api/v1/field-channel/lease/check']);

export function fieldMapAuthorityGatewayConfigV1(raw){
 need(raw&&raw.format===1&&raw.purpose==='FIELD_MAP_AUTHORITY_GATEWAY_V1'&&typeof raw.enabled==='boolean','FIELD_GATEWAY_FIELDS');
 if(!raw.enabled){need(exact(raw,['format','purpose','enabled']),'FIELD_GATEWAY_DISABLED_FIELDS');return structuredClone(raw);}
 need(exact(raw,['format','purpose','enabled','authorityHostFile','platformFile','intakeFile'])&&[raw.authorityHostFile,raw.platformFile,raw.intakeFile].every(text),'FIELD_GATEWAY_ENABLED_FIELDS');return structuredClone(raw);
}
export function fieldMapGatewaySiteBindingV1(raw){
 need(exact(raw,['trustFile','authorityRuntimeFile','sourceDirectory','targetDirectory','tenants'])&&[raw.trustFile,raw.authorityRuntimeFile,raw.sourceDirectory,raw.targetDirectory].every(v=>text(v)&&isAbsolute(v)),'FIELD_GATEWAY_SITE_BINDING');
 need(Array.isArray(raw.tenants)&&raw.tenants.length>0&&raw.tenants.length<=32,'FIELD_GATEWAY_SITE_TENANTS');const seen=new Set();
 for(const t of raw.tenants){need(exact(t,['tenantId','host','port','database','databaseOid','catalogHash'])&&typeof t.tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(t.tenantId)&&!seen.has(t.tenantId)&&['127.0.0.1','::1'].includes(t.host)&&Number.isInteger(t.port)&&t.port>1024&&t.port<=65535&&typeof t.database==='string'&&/^[a-z][a-z0-9_]{1,62}$/.test(t.database)&&typeof t.databaseOid==='string'&&/^[1-9][0-9]{0,9}$/.test(t.databaseOid)&&BigInt(t.databaseOid)<=4294967295n&&/^[a-f0-9]{64}$/.test(t.catalogHash),'FIELD_GATEWAY_SITE_TENANT');seen.add(t.tenantId);}
 return structuredClone(raw);
}

/** Return before any I/O, so the owning SITE can cancel and await startup. */
export function createFieldMapAuthorityGatewayV1(file,options={}){
 need(text(file)&&exact(options,Object.keys(options))&&Object.keys(options).every(k=>['siteBinding','startupSignal','readyTimeoutMs'].includes(k)),'FIELD_GATEWAY_ARGUMENTS');
 need(options.startupSignal===undefined||options.startupSignal instanceof AbortSignal,'FIELD_GATEWAY_SIGNAL');const timeout=options.readyTimeoutMs??30000;need(Number.isSafeInteger(timeout)&&timeout>=1000&&timeout<=120000,'FIELD_GATEWAY_TIMEOUT');
 const expected=options.siteBinding===undefined?null:fieldMapGatewaySiteBindingV1(options.siteBinding),owner=randomUUID(),path=resolve(file),stop=new AbortController(),pins=new Map(),requests=new Set();let enabled=null,phase='STARTING',failure=null,host=null,platform=null,intake=null,http=null,closing=false,closed=false,closeJob=null,disposeJob=null,requestId=null,readySucceeded=false;
 const cancelled=()=>{if(closing||stop.signal.aborted)throw Error('FIELD_GATEWAY_CANCELLED');};
 const externalAbort=()=>{stop.abort();queueMicrotask(()=>{void api.close().catch(()=>{});});};options.startupSignal?.addEventListener('abort',externalAbort,{once:true});if(options.startupSignal?.aborted)externalAbort();
 async function json(file){const item=await readApplicationFileV1(file);if(pins.has(item.path))need(pins.get(item.path)===item.sha256,'FIELD_GATEWAY_INPUT_CHANGED');else pins.set(item.path,item.sha256);return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(item.bytes).replace(/^\uFEFF/,''));}
 async function checkInputs(){cancelled();for(const [file,digest]of pins){need((await readApplicationFileV1(file)).sha256===digest,'FIELD_GATEWAY_INPUT_CHANGED');cancelled();}}
 function linked(tenants){need(expected,'FIELD_GATEWAY_SITE_BINDING_REQUIRED');for(const t of tenants){const target=expected.tenants.find(x=>x.tenantId===t.tenantId);need(target&&t.account.host===target.host&&t.account.port===target.port&&t.account.database===target.database&&t.binding.databaseOid===target.databaseOid&&t.binding.catalogHash===target.catalogHash,'FIELD_GATEWAY_SITE_DATABASE');}}
 const liveReady=()=>enabled===true&&!closing&&!closed&&readySucceeded&&platform?.configured&&platform.tenantIds().every(t=>platform.ownsReceiving(t))&&intake?.state().sources>0&&intake.state().connected===intake.state().sources;
 async function dispose(){return disposeJob??=(async()=>{
  const fields=await Promise.allSettled([Promise.resolve().then(()=>intake?.close()),Promise.resolve().then(()=>platform?.close())]);await Promise.allSettled([...requests].map(r=>r.job));const hosts=await Promise.allSettled([host?.close()]);
  need([...fields,...hosts].every(r=>r.status==='fulfilled'),'FIELD_GATEWAY_DRAIN_FAILED');const h=host?.state(),p=platform?.state(),m=intake?.state();
  need(requests.size===0&&(!h||h.closed&&h.active===0&&h.connectionsActive===0&&h.connectionsCreated===h.connectionsRetired)&&(!p||p.closed&&p.active===0&&p.tenants.every(t=>t.owner.closed&&!t.owner.held&&t.owner.active===0))&&(!m||m.closed&&!m.configured&&m.connected===0&&m.reconnecting===0),'FIELD_GATEWAY_RETIREMENT_UNPROVEN');closed=true;
 })();}
 const api={owner,get ready(){return ready;},publicSnapshot(tenant){return platform?.publicSnapshot(tenant)??null;},state(){return Object.freeze({format:'FIELD_MAP_AUTHORITY_GATEWAY_STATE_V1',owner,enabled,phase,ready:!!liveReady(),closing,closed,activeHttp:requests.size,failure,host:host?.state()??null,platform:platform?.state()??null,intake:intake?.state()??null});},async handleHttp(req,res){let pathname;try{pathname=new URL(req.url??'','http://idms.invalid').pathname;}catch{return false;}if(!routes.has(pathname)||enabled===false)return false;if(!http||closing||!readySucceeded){req.resume();if(!res.destroyed&&!res.writableEnded){res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({error:'现场接口暂不可用'}));}return true;}const record={req,res,job:null};const job=Promise.resolve().then(()=>http(req,res));record.job=job;requests.add(record);try{return await job;}finally{requests.delete(record);}},close(input={}){
  need(exact(input,Object.keys(input))&&Object.keys(input).every(k=>k==='requestId')&&(input.requestId===undefined||uuid(input.requestId)),'FIELD_GATEWAY_STOP_REQUEST');if(requestId)need(input.requestId===undefined||input.requestId===requestId,'FIELD_GATEWAY_STOP_REQUEST_CHANGED');else requestId=input.requestId??randomUUID();if(closeJob)return closeJob;
  closing=true;phase='STOPPING';stop.abort();for(const r of requests){r.req.destroy();r.res.destroy();}void Promise.resolve().then(()=>intake?.close()).catch(()=>{});void Promise.resolve().then(()=>platform?.close()).catch(()=>{});
  closeJob=(async()=>{await ready.catch(()=>{});await dispose();phase=failure?'FAILED':'CLOSED';options.startupSignal?.removeEventListener('abort',externalAbort);return Object.freeze({format:'FIELD_MAP_AUTHORITY_GATEWAY_TERMINAL_V1',owner,requestId,enabled,normal:!failure,startupCancelled:!readySucceeded&&!failure,allOwnedResourcesRetired:true,state:api.state()});})();return closeJob;
 }};
 const ready=Promise.resolve().then(async()=>{
  try{cancelled();const raw=fieldMapAuthorityGatewayConfigV1(await json(path));enabled=raw.enabled;cancelled();if(!enabled){phase='DISABLED';readySucceeded=true;return api.state();}
   need(expected,'FIELD_GATEWAY_SITE_BINDING_REQUIRED');const from=p=>resolve(dirname(path),p),hostFile=from(raw.authorityHostFile),platformFile=from(raw.platformFile),intakeFile=from(raw.intakeFile);need(new Set([path,hostFile,platformFile,intakeFile].map(normal)).size===4,'FIELD_GATEWAY_FILE_ALIAS');
   for(const file of [path,hostFile,platformFile,intakeFile])need(outside(file,expected.sourceDirectory)&&outside(file,expected.targetDirectory),'FIELD_GATEWAY_INPUT_IN_PGDATA');
   const hostConfig=fieldMapAuthorityHostConfigV1(await json(hostFile));need(same(resolve(dirname(hostFile),hostConfig.coldTrustFile),expected.trustFile)&&same(resolve(dirname(hostFile),hostConfig.authorityRuntimeFile),expected.authorityRuntimeFile),'FIELD_GATEWAY_SITE_AUTHORITY');linked(hostConfig.tenants);await json(platformFile);await json(intakeFile);await checkInputs();
   platform=new FieldMapPlatformV1();http=createFieldMapHttpHandlerV1(platform);host=await loadFieldMapAuthorityHostV1(hostFile);await checkInputs();const bindings=host.tenantBindings();linked([...bindings].map(([tenantId,t])=>({tenantId,...t})));
   const guarded=new Map([...bindings].map(([tenant,t])=>[tenant,{...t,guard:async(phase,signal)=>{await checkInputs();const combined=signal?AbortSignal.any([signal,stop.signal]):stop.signal;await t.guard(phase,combined);await checkInputs();}}]));
   await platform.start(platformFile,guarded);await checkInputs();intake=new FieldMapMqttIntakeV1(platform);await intake.start(intakeFile);const end=performance.now()+timeout;
   while(true){cancelled();await checkInputs();const m=intake.state();if(m.sources>0&&m.connected===m.sources&&platform.tenantIds().every(t=>platform.ownsReceiving(t)))break;need(performance.now()<end,'FIELD_GATEWAY_READY_TIMEOUT');await new Promise(ok=>setTimeout(ok,50));}
   readySucceeded=true;phase='READY';return api.state();
  }catch(error){if(!closing&&!stop.signal.aborted)failure=safeCode(error);stop.abort();await dispose();phase=failure?'FAILED':'CLOSED';throw error;}
 });void ready.catch(()=>{});return api;
}

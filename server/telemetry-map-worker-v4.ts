import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import pg from 'pg';
import mqtt from 'mqtt';
import type {ClientConfig} from 'pg';
import type {EdgeSource} from '../integrations/telemetry.ts';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {DomainMapV4,domainMapAssert as need} from './domain-map-v4.ts';
import {bindTelemetryMapMqttV4} from './telemetry-map-mqtt-v4.ts';
import {telemetryDomainFormat,type TelemetryDomainControl,type DomainRegistryHead} from './telemetry-map-v4.ts';
import {canonicalDigest} from './canonical-state.ts';
import {publicRegistry} from './registry-history.ts';
export interface TelemetryMapWorkerConfig {format:1;purpose:'TELEMETRY_DOMAIN_V4';account:ClientConfig;binding:StateMapBinding;sources:EdgeSource[];mqtt:{url:string;username:string;password:string;tls?:{ca?:string;cert?:string;key?:string;passphrase?:string;servername?:string}};managed?:{operationId:string;controlToken:string}}
const loopback=(host:string)=>['127.0.0.1','localhost','::1','[::1]'].includes(host);
const safeCode=(e:unknown)=>{const code=(e as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z0-9_]{1,80}$/.test(code)?code:'TELEMETRY_WORKER_FAILED';};
export async function startTelemetryMapWorkerV4(input:TelemetryMapWorkerConfig,onError:(error:unknown)=>void=()=>{}){
 const cfg=structuredClone(input);need(cfg?.format===1&&cfg.purpose==='TELEMETRY_DOMAIN_V4'&&cfg.account&&cfg.binding&&cfg.mqtt&&typeof cfg.mqtt.url==='string'&&Array.isArray(cfg.sources)&&cfg.sources.length>0,'WORKER_CONFIG');
 need(typeof cfg.account.host==='string'&&typeof cfg.account.user==='string'&&typeof cfg.account.database==='string'&&!cfg.account.connectionString,'WORKER_ACCOUNT');
 need(loopback(cfg.account.host)||typeof cfg.account.ssl==='object'&&cfg.account.ssl!==null&&cfg.account.ssl.rejectUnauthorized!==false,'WORKER_POSTGRES_TLS');
 const url=new URL(cfg.mqtt.url);need(!url.username&&!url.password&&(url.protocol==='mqtts:'||url.protocol==='mqtt:'&&loopback(url.hostname))&&typeof cfg.mqtt.username==='string'&&!!cfg.mqtt.username&&typeof cfg.mqtt.password==='string'&&!!cfg.mqtt.password,'WORKER_MQTT_TLS');
 if(cfg.managed)need(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(cfg.managed.operationId)&&/^[A-Za-z0-9_-]{32,128}$/.test(cfg.managed.controlToken),'WORKER_MANAGED_IDENTITY');
 const account={...cfg.account,connectionTimeoutMillis:3000,query_timeout:35000,statement_timeout:30000},store=new DomainMapV4(account,cfg.binding),s=await store.snapshot();
 try{const control=await s.get<TelemetryDomainControl>('domain_head','control'),registry=await s.get<DomainRegistryHead>('domain_head','registry');need(control.format===telemetryDomainFormat&&control.tenantId===cfg.binding.tenantId&&control.status==='ACTIVE','WORKER_INTAKE_NOT_ACTIVE');need(registry.configurationHash===canonicalDigest(publicRegistry(cfg.sources,cfg.binding.tenantId)),'WORKER_REGISTRY_STALE');}finally{await s.close();}
 const check=new pg.Client(account);check.on('error',()=>{});try{await check.connect();need((await check.query("SELECT has_function_privilege(session_user,'state_map_v1.apply_delta_v1(text,uuid,bigint,bytea,jsonb)','EXECUTE') AS writable")).rows[0].writable,'WORKER_WRITE_CAPABILITY');}finally{await check.end().catch(()=>{});}
 const client=mqtt.connect(cfg.mqtt.url,{...cfg.mqtt.tls,rejectUnauthorized:true,username:cfg.mqtt.username,password:cfg.mqtt.password,clientId:'idms-v4-telemetry-'+randomUUID(),protocolVersion:5,reconnectPeriod:1000,connectTimeout:3000,clean:true,resubscribe:false,properties:{receiveMaximum:10,maximumPacketSize:16384}});
 const report=(error:unknown)=>{try{onError(error);}catch{console.error('[IDMS v4 worker] error reporter failed');}};
 let stopping=false,inFlight=0,wake:(()=>void)|undefined,readyDone=false;const ready=new Promise<void>((ok,no)=>{
  client.on('error',error=>{report(error);if(!readyDone){readyDone=true;no(error);}});
  client.on('connect',()=>{void bindTelemetryMapMqttV4(client,store,cfg.sources,{onError:report}).then(()=>{
   const handle=client.handleMessage.bind(client);client.handleMessage=(packet,done)=>{if(stopping){done();return;}inFlight++;handle(packet,error=>{inFlight--;done(error);if(inFlight===0)wake?.();});};
   if(!readyDone){readyDone=true;ok();}
  }).catch(error=>{report(error);if(!readyDone){readyDone=true;no(error);}});});
 });
 const stop=async()=>{if(stopping)return;stopping=true;if(inFlight)await new Promise<void>(ok=>{wake=ok;});await new Promise<void>(ok=>{const timer=setTimeout(()=>client.end(true,{},()=>ok()),5000);client.end(false,{},()=>{clearTimeout(timer);ok();});});};
 try{await ready;}catch(e){await stop();throw e;}
 return {tenantId:cfg.binding.tenantId,sources:cfg.sources.length,client,store,stop};
}
export async function runTelemetryMapWorkerV4(file:string){
 const path=resolve(file),info=await stat(path);need(info.isFile()&&info.size>0&&info.size<=16*1024*1024,'WORKER_CONFIG_FILE');const cfg=JSON.parse(await readFile(path,'utf8')) as TelemetryMapWorkerConfig,emit=(type:string,extra:Record<string,unknown>={})=>{const value={type,pid:process.pid,operationId:cfg.managed?.operationId,...extra};process.stdout.write(JSON.stringify(value)+'\n');if(process.connected)process.send?.(value);};
 const worker=await startTelemetryMapWorkerV4(cfg,error=>process.stderr.write(JSON.stringify({type:'IDMS_TELEMETRY_ERROR',code:safeCode(error)})+'\n'));
 emit('IDMS_TELEMETRY_READY',{tenantId:worker.tenantId,sources:worker.sources});let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await worker.stop();emit('IDMS_TELEMETRY_STOPPED');if(process.connected)process.disconnect?.();};
 process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
 if(cfg.managed)process.on('message',(message:unknown)=>{const m=message as {type?:unknown;operationId?:unknown;controlToken?:unknown};if(m?.type!=='IDMS_TELEMETRY_STOP'||m.operationId!==cfg.managed!.operationId||typeof m.controlToken!=='string')return;const actual=Buffer.from(m.controlToken),expected=Buffer.from(cfg.managed!.controlToken);if(actual.length===expected.length&&timingSafeEqual(actual,expected))void stop();});
 return worker;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const file=process.env.IDMS_TELEMETRY_MAP_CONFIG;need(file,'WORKER_CONFIG_REQUIRED');await runTelemetryMapWorkerV4(file);}catch(error){process.stderr.write(JSON.stringify({type:'IDMS_TELEMETRY_STARTUP_REFUSED',code:safeCode(error)})+'\n');process.exitCode=1;if(process.connected)process.disconnect?.();}}

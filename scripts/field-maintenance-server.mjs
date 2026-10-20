import {createServer} from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAuth} from '../server/auth.ts';
import {MemoryAuthStore} from '../server/auth-state.ts';
import {readRequestBytes} from '../server/request-capacity.ts';
import {requiredScope} from '../server/access.ts';
import {DomainError} from '../server/service.ts';
import {withRequestCapacity} from '../server/request-capacity.ts';
import {reserveResponse} from '../server/request-capacity.ts';
import {fieldMaintenanceCapability,fieldMaintenanceReaderConfig,fieldMaintenanceFence,readMaintenanceJson,maintenanceFailure} from './field-maintenance-record.mjs';
import {readFieldMaintenance} from './field-maintenance-reader.mjs';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {maintenanceCookies} from './field-maintenance-cookies.mjs';
import {FieldMaintenanceAuthJournal} from './field-maintenance-auth-journal.mjs';
const fail=code=>{throw maintenanceFailure(code);};
export function authorizeFieldMaintenance(who,cap){if(who.authMode!=='oidc'||who.actorType!=='USER'||who.tenantId!==cap.tenantId||!who.roles?.some(r=>['system-admin','platform-certifier','tenant-admin','auditor','final-approver'].includes(r))||!(['TENANT','READONLY_TENANT'].includes(requiredScope(who.roles))||who.roles.includes('final-approver')&&who.scope?.provided&&['sites','lines','devices'].every(k=>who.scope[k]?.includes('*'))))throw new DomainError(403,'当前身份不能核对该企业的恢复维护操作');}
export async function startFieldMaintenance({configFile,expectedSha256,reviewBridge,onClosed}){
 if(process.env.NODE_ENV==='production')fail('FIELD_MAINTENANCE_PRODUCTION_GATE_PENDING');if(typeof expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSha256))fail('FIELD_MAINTENANCE_CONFIG_INVALID');
 configFile=resolve(configFile);const raw=await readMaintenanceJson(configFile);if(sourceFreezeSha(raw)!==expectedSha256)fail('FIELD_MAINTENANCE_CONFIG_CHANGED');const config=fieldMaintenanceReaderConfig(raw),capFile=resolve(dirname(configFile),config.capabilityFile),cap=fieldMaintenanceCapability(await readMaintenanceJson(capFile));if(sourceFreezeSha(cap)!==config.capabilitySha256)fail('FIELD_MAINTENANCE_CONFIG_CHANGED');
 const checkFiles=async()=>{if(sourceFreezeSha(await readMaintenanceJson(configFile))!==expectedSha256||sourceFreezeSha(await readMaintenanceJson(capFile))!==config.capabilitySha256)fail('FIELD_MAINTENANCE_CONFIG_CHANGED');await fieldMaintenanceFence(cap);};
 const origin=new URL(cap.auth.origin),lock=net.createServer(s=>s.destroy()),lockName='idms-field-maintenance-'+cap.sessionId,cookies=maintenanceCookies(cap),journal=new FieldMaintenanceAuthJournal(resolve(dirname(configFile),'auth-events.jsonl'),config.authJournalKey,cap.sessionId),inflight=new Set(),authState=new MemoryAuthStore();
 lock.maxConnections=1;lock.on('error',()=>{});let auth,server,watch,closing=false,checking=false,activeRead=false,closeJob;
 async function close(){if(closeJob)return closeJob;closing=true;clearInterval(watch);closeJob=(async()=>{let stopped=Promise.resolve();if(server?.listening){stopped=new Promise(ok=>server.close(ok));server.closeIdleConnections();}await Promise.allSettled([...inflight]);server?.closeIdleConnections();await stopped;await auth?.close();await journal.close();if(lock.listening)await new Promise(ok=>lock.close(ok));await onClosed?.();})();return closeJob;}
 function json(res,status,value){if(res.destroyed||res.writableEnded)return;const body=JSON.stringify(value);if(status<400)reserveResponse(Buffer.byteLength(body));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(body);}
 try{
  await new Promise((ok,no)=>{lock.once('error',no);lock.listen({path:process.platform==='win32'?'\\\\.\\pipe\\'+lockName:'\0'+lockName,exclusive:true},ok);});await checkFiles();await readFieldMaintenance(cap,config);await journal.open();
  auth=createAuth(config.auth,async(who,action)=>{authorizeFieldMaintenance(who,cap);try{await checkFiles();await journal.append(who,action);}catch(e){queueMicrotask(()=>close().catch(()=>{}));throw new DomainError(503,'维护认证记录或恢复围栏尚未确认');}},authState);
  const assets=new Map();for(const [url,file,type]of [['/','field-maintenance.html','text/html; charset=utf-8'],['/maintenance.js','field-maintenance.js','application/javascript; charset=utf-8'],['/maintenance.css','field-maintenance.css','text/css; charset=utf-8']])assets.set(url,{body:await readFile(fileURLToPath(new URL('../public/'+file,import.meta.url))),type});
  server=createServer({headersTimeout:15000,requestTimeout:20000,maxHeaderSize:16384},(req,res)=>{
   let task;task=withRequestCapacity(req,res,async()=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
     if(closing)throw new DomainError(503,'维护核对入口已关闭');if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.headers.host!==origin.host)throw new DomainError(400,'维护请求地址不匹配');
     const seen=new Set();for(let i=0;i<req.rawHeaders.length;i+=2){const h=req.rawHeaders[i].toLowerCase();if(['host','authorization','origin','x-tenant-id','x-csrf-token'].includes(h)){if(seen.has(h))throw new DomainError(400,'维护请求含重复授权头');seen.add(h);}}
     const url=new URL(req.url,cap.auth.origin);if(!['GET','HEAD'].includes(req.method||'')&&!(req.method==='POST'&&(url.pathname==='/api/v1/auth/logout'||reviewBridge&&url.pathname==='/api/v1/recovery/review'))){res.setHeader('connection','close');req.resume();return json(res,423,{code:'FIELD_MAINTENANCE_WRITE_CLOSED',message:'恢复维护期间业务、现场和审批写入口未开放'});}
     await checkFiles();
     if(url.pathname==='/health'&&req.method==='GET'&&!url.search)return json(res,200,{status:'UP',mode:'RECOVERY_MAINTENANCE',fieldEnabled:false,businessWritesEnabled:false,activationEnabled:false,productionAcceptance:false});
     const adapted=cookies.request(req),restoreHeaders=cookies.response(res);try{if(url.pathname.startsWith('/api/v1/auth/')){if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)>1024)throw new DomainError(413,'维护登录请求体超出限制');await auth.handle(adapted,res,url);return;}}finally{restoreHeaders();}
     if(assets.has(url.pathname)&&!url.search){const a=assets.get(url.pathname);reserveResponse(a.body.length);res.writeHead(200,{'content-type':a.type,'cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:a.body);return;}
     if(reviewBridge&&url.pathname==='/api/v1/recovery/review'&&req.method==='POST'&&!url.search){
      if(req.headers.authorization||req.headers.origin!==cap.auth.origin||req.headers['content-type']!=='application/json')throw new DomainError(403,'请在本维护页面使用当前登录会话操作');
      const who=await auth.context(adapted);authorizeFieldMaintenance(who,cap);if(activeRead)throw new DomainError(429,'已有核对正在进行，请稍后重试');
      let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readRequestBytes(req,2048)));}catch(e){if(e instanceof DomainError)throw e;throw new DomainError(400,'恢复审批请求无效');}
      if(!body||Object.getPrototypeOf(body)!==Object.prototype||!['SUBMIT','APPROVE'].includes(body.action)||Object.keys(body).some(k=>!['action','planId','expectedFactsSha256','supersedesPlanId'].includes(k))||typeof body.planId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.planId)||body.expectedFactsSha256!==cap.factsSha256||body.supersedesPlanId!==undefined&&(typeof body.supersedesPlanId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.supersedesPlanId)))throw new DomainError(400,'计划或数据摘要已变化，请重新核对');
      const key=(adapted.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('idms_session='))?.slice(13),accessToken=await authState.withSession(key||'',async session=>{if(session.identity.actorId!==who.actorId||session.identity.tenantId!==cap.tenantId||session.expiresAt<=Date.now())throw new DomainError(401,'请重新登录');return {value:session.tokens.access_token};});if(!accessToken)throw new DomainError(401,'请重新登录');
      activeRead=true;try{await readFieldMaintenance(cap,config);await checkFiles();const reply=await reviewBridge({...body,accessToken,capabilitySha256:config.capabilitySha256});if(reply.rotation)queueMicrotask(()=>close().catch(()=>{}));json(res,reply.ok?200:reply.rotation?503:403,{...reply,message:reply.rotation?'维护锚点已更换，请重新登录核对当前结果':'当前身份或恢复条件不允许此操作'});return;}catch(e){queueMicrotask(()=>close().catch(()=>{}));throw e;}finally{activeRead=false;}
     }
     if(url.pathname!=='/api/v1/recovery/status'||req.method!=='GET'||url.search)throw new DomainError(404,'维护核对接口不存在');
     const who=await auth.context(adapted);authorizeFieldMaintenance(who,cap);if(activeRead)throw new DomainError(429,'已有核对正在进行，请稍后重试');activeRead=true;
     try{const view=await readFieldMaintenance(cap,config);await journal.append(who,'RECOVERY_VIEW_READ');await checkFiles();json(res,200,{...view,reviewActionsAvailable:!!reviewBridge});}catch(e){queueMicrotask(()=>close().catch(()=>{}));throw e;}finally{activeRead=false;}
    }catch(e){json(res,e instanceof DomainError?e.status:503,{code:typeof e.code==='string'&&/^FIELD_[A-Z0-9_]+$/.test(e.code)?e.code:'FIELD_MAINTENANCE_UNAVAILABLE',message:e instanceof DomainError?e.message:'恢复围栏或目标核对尚未确认，维护入口不能继续提供结果'});}
   }).catch(()=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"code":"FIELD_MAINTENANCE_UNAVAILABLE"}');}}).finally(()=>inflight.delete(task));inflight.add(task);
  });server.on('error',()=>{});await new Promise((ok,no)=>{server.once('error',no);server.listen({host:origin.hostname.replace(/^\[|\]$/g,''),port:Number(origin.port),exclusive:true},ok);});
  watch=setInterval(async()=>{if(checking||closing)return;checking=true;try{await checkFiles();}catch{close().catch(()=>{});}finally{checking=false;}},1000);watch.unref();
  return {origin:cap.auth.origin,operationId:cap.operationId,sessionId:cap.sessionId,cookiePrefix:cookies.prefix,close,get closing(){return closing;}};
 }catch(e){await close();throw e;}
}

import {readFile} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {loadSiteConsoleRuntimeV4R3} from './site-console-runtime-v4-r3.ts';
import {createSiteConsoleHttpV4} from './site-console-http-v4.ts';
import {PredictiveConsoleReadV4} from './predictive-console-http-v4.ts';
import {PredictiveConsoleQueryV4} from './predictive-console-query-v4.ts';
import {createPredictiveAdoptionUiHttpV4R2} from './predictive-adoption-ui-http-v4-r2.ts';
import {PredictiveLegacyReadV4} from './predictive-legacy-adoption-v4.ts';
import {predictiveReadIdentityV4} from './predictive-read-contract-v4.ts';
import {GovernanceConsoleReadV4} from './governance-console-read-v4.ts';
import {DomainError} from './service.ts';
import {withRequestCapacity,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
type Runtime=Awaited<ReturnType<typeof loadSiteConsoleRuntimeV4R3>>;
const modules=[{label:'数据与审计',href:'/governance/'},{label:'预测与复核',href:'/predictive/'},{label:'维修工单',href:'/maintenance/'}];
const nav='<nav class="site-shell-nav" aria-label="站点导航"><a href="/">工作台首页</a>'+modules.map(m=>'<a href="'+m.href+'">'+m.label+'</a>').join('')+'</nav>';
export function siteConsoleShellV4R3(html:string){if(html.split('</header>').length!==2||html.split('</head>').length!==2)throw Error('SITE_R3_STATIC_SHELL_VERSION');return Buffer.from(html.replace('</head>','<link rel="stylesheet" href="/site/navigation.css"></head>').replace('</header>','</header>'+nav));}
export async function createSiteConsoleHttpV4R3(runtime:Runtime){
 const base=await createSiteConsoleHttpV4(runtime.base),routes=new Map<string,{query:PredictiveConsoleQueryV4;governance:GovernanceConsoleReadV4;handle:(req:IncomingMessage,res:ServerResponse)=>Promise<void>}>();
 for(const [tenant,p]of runtime.predictive){const b=p.config.business,read=new PredictiveConsoleReadV4(b.account,b.binding),query=new PredictiveConsoleQueryV4({account:b.account,binding:b.binding,codec:runtime.auth.auditCursors,queue:p.queue,proof:read});routes.set(tenant,{query,governance:new GovernanceConsoleReadV4(b.account,b.binding,runtime.auth.auditCursors),handle:await createPredictiveAdoptionUiHttpV4R2({legacy:new PredictiveLegacyReadV4(b.account,b.binding,query),adoption:p.adoption,auth:runtime.auth,provider:runtime.provider,read,query,queue:p.queue,crypto:p.crypto,tenantId:tenant})});}
 const assets=new Map<string,{bytes:Buffer;mime:string}>();
 for(const [path,file,mime]of [['/','site-console-v4-r3.html','text/html; charset=utf-8'],['/site/console-r3.css','site-console-v4-r3.css','text/css; charset=utf-8'],['/site/navigation.css','site-console-navigation-v4-r2.css','text/css; charset=utf-8']])assets.set(path,{bytes:await readFile(new URL('../public/'+file,import.meta.url)),mime});
 for(const [path,file]of [['/governance/','governance-audit-v4.html'],['/maintenance/','maintenance-console-v4.html'],['/predictive/','predictive-console-v4-r2.html']])assets.set(path,{bytes:siteConsoleShellV4R3(await readFile(new URL('../public/'+file,import.meta.url),'utf8')),mime:'text/html; charset=utf-8'});
 const first=routes.values().next().value!;let authorizing=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;const bytes=Buffer.from(JSON.stringify(value));reserveResponse(bytes.length);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store'});res.end(bytes);};
  try{
   res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=()');res.setHeader('cache-control','no-store');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
   if((req.url?.length||0)>8192)throw new DomainError(400,'SITE_R3_URL');const url=new URL(req.url||'/','http://localhost'),asset=assets.get(url.pathname);
   if(asset){res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=()');res.setHeader('cache-control','no-store');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");if(!['GET','HEAD'].includes(req.method||'')){res.setHeader('allow','GET, HEAD');throw new DomainError(405,'SITE_R3_METHOD');}res.writeHead(200,{'content-type':asset.mime,'content-length':asset.bytes.length});res.end(req.method==='HEAD'?undefined:asset.bytes);return;}
   if(url.pathname==='/api/v4/site/health'){if(req.method!=='GET'||url.search)throw new DomainError(400,'SITE_R3_QUERY');send(200,{status:'UP',mode:'v4-console-integration-r3'});return;}
   if(url.pathname==='/predictive'||url.pathname.startsWith('/predictive/')){await first.handle(req,res);return;}
   if(url.pathname!=='/api/v4/site/context'&&!url.pathname.startsWith('/api/v4/predictive/')){await base(req,res);return;}
   if(authorizing>=32)throw new DomainError(429,'SITE_R3_AUTH_BUSY');authorizing++;let ctx;try{ctx=await runtime.auth.context(req);}finally{authorizing--;}
   if(req.aborted||res.destroyed)return;if(req.headers['x-tenant-id']!==ctx.tenantId||req.headers['x-idms-actor-id']!==ctx.actorId)throw new DomainError(403,'SITE_R3_IDENTITY_CHANGED');const route=routes.get(ctx.tenantId);if(!route)throw new DomainError(403,'SITE_R3_TENANT_UNREGISTERED');
   if(url.pathname.startsWith('/api/v4/predictive/')){await route.handle(req,res);return;}
   if(req.method!=='GET'||url.search)throw new DomainError(400,'SITE_R3_QUERY');
   await withRequestCapacity(req,res,async()=>{bindRequestTenant(ctx.tenantId);await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(32*1024*1024);try{const g=await route.governance.context(ctx),p=await route.query.context(ctx);if(g.tenant.id!==p.tenant.id||g.phase!==p.phase)throw new DomainError(503,'SITE_R3_CONTEXT_CHANGED');const current=await runtime.auth.context(req);if(predictiveReadIdentityV4(current)!==predictiveReadIdentityV4(ctx))throw new DomainError(409,'SITE_R3_IDENTITY_CHANGED');send(200,{tenant:p.tenant,phase:p.phase,modules});}finally{release();}}),requestSignal());});
  }catch(error){if(res.headersSent){res.destroy();return;}res.setHeader('x-content-type-options','nosniff');res.setHeader('cache-control','no-store');send(error instanceof DomainError?error.status:503,{error:error instanceof DomainError?error.message:'SITE_R3_UNAVAILABLE'});}
 };
}

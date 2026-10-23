import {createColdBrowserPageCollectorV2} from './cold-browser-page-capture-v2-qa.mjs';
import {summarizeColdBrowserDevicePageV1} from './cold-browser-scope-v1-qa.mjs';
import {captureColdBrowserWriteBodyV1,summarizeColdBrowserWriteResponseV1} from './cold-browser-write-ledger-v1-qa.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadRuntimeColdSiteV1,createRuntimeColdSiteHttpV1} from '../runtime-cold-portable-entry-v1.mjs';
import {privateNewFile} from '../backup-support.mjs';

assert.equal(process.argv.length,3);const config=JSON.parse(await readFile(process.argv[2],'utf8'));assert.match(config.owner,/^[a-f0-9-]{36}$/);
const runtime=await loadRuntimeColdSiteV1(config.runtimeFile),handler=await createRuntimeColdSiteHttpV1(runtime),hash=v=>createHash('sha256').update(v).digest('hex');
await privateNewFile(config.ledgerFile,JSON.stringify({format:'IDMS_BROWSER_HTTP_LEDGER_V1',owner:config.owner,pid:process.pid,origin:runtime.config.auth?.origin??config.origin})+'\n');
const fd=openSync(config.ledgerFile,'a');let sequence=0,failed=false,stopping=false,server;
function append(value){try{assert(sequence<5000);writeSync(fd,JSON.stringify({owner:config.owner,sequence:++sequence,at:Date.now(),...value})+'\n');}catch{failed=true;}}
function cookieHash(value,name){const matches=String(value??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));if(matches.length!==1)return null;const id=matches[0].slice(name.length+1);return /^[A-Za-z0-9_-]{20,120}$/.test(id)?hash(id):null;}
function observe(req,res,path,body){const record={method:req.method,path,status:res.statusCode,sessionCookieHash:cookieHash(req.headers.cookie,'idms_session'),csrfHeaderPresent:typeof req.headers['x-csrf-token']==='string'};try{const referer=new URL(req.headers.referer);if(referer.origin===config.origin)record.page=referer.pathname;}catch{}
 if(path==='/api/v1/auth/login'&&res.statusCode===303){const u=new URL(String(res.getHeader('location')));record.authorization={origin:u.origin,clientId:u.searchParams.get('client_id'),responseType:u.searchParams.get('response_type'),codeChallengeMethod:u.searchParams.get('code_challenge_method'),challengePresent:/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('code_challenge')??''),statePresent:!!u.searchParams.get('state'),redirectUri:u.searchParams.get('redirect_uri')};}
 if(path==='/api/v1/auth/callback'){const value=res.getHeader('set-cookie'),cookies=Array.isArray(value)?value:[value].filter(Boolean),session=cookies.find(x=>String(x).startsWith('idms_session='));record.callback={sessionCookieHash:session?cookieHash(String(session),'idms_session'):null,httpOnly:!!session&&/;\s*HttpOnly(?:;|$)/i.test(String(session)),sameSiteLax:!!session&&/;\s*SameSite=Lax(?:;|$)/i.test(String(session))};}
 if(path==='/api/v1/auth/session'&&res.statusCode===200){const value=JSON.parse(body.toString('utf8'));record.session={authenticated:value.authenticated===true};if(value.authenticated){const u=value.user;assert(typeof u.actorId==='string'&&typeof u.tenantId==='string');record.session={authenticated:true,actorId:u.actorId,tenantId:u.tenantId,roles:Array.isArray(u.roles)?u.roles.filter(x=>typeof x==='string'):[],permissions:Array.isArray(u.permissions)?u.permissions.filter(x=>typeof x==='string'):[],expiresAt:value.expiresAt,csrfPresent:typeof value.csrfToken==='string'&&value.csrfToken.length>0};}}
 if(path==='/api/v1/auth/session'&&record.session?.authenticated){const s=JSON.parse(body.toString('utf8')).user.scope;assert(s&&Array.isArray(s.sites)&&Array.isArray(s.lines)&&Array.isArray(s.devices)&&typeof s.provided==='boolean');record.session.scope={sites:s.sites,lines:s.lines,devices:s.devices,provided:s.provided};}
 if(path==='/api/v4/predictive/devices'&&res.statusCode===200){record.devicePage=summarizeColdBrowserDevicePageV1(JSON.parse(body.toString('utf8')));record.deviceQueryCursorPresent=new URL(req.url,'http://localhost').searchParams.has('cursor');}
 Object.assign(record,summarizeColdBrowserWriteResponseV1(path,body));
 append(record);
}
const collector=createColdBrowserPageCollectorV2({...config,work:config.work,cookieHash:value=>cookieHash(value,'idms_session')});
server=createServer(async(req,res)=>{if(await collector.handle(req,res))return;const path=new URL(req.url??'/','http://localhost').pathname;if(req.method==='GET'&&path==='/maintenance/')collector.injectMaintenance(res);const tracked=path.startsWith('/api/'),capture=path==='/api/v1/auth/session'||path==='/api/v4/predictive/devices'||captureColdBrowserWriteBodyV1(path),parts=[];let bytes=0;const write=res.write.bind(res),end=res.end.bind(res),take=(v,encoding)=>{if(!capture||v===undefined||v===null)return;const b=Buffer.isBuffer(v)?v:Buffer.from(v,typeof encoding==='string'?encoding:'utf8');bytes+=b.length;assert(bytes<=(path==='/api/v1/auth/session'?65536:2*1024**2));parts.push(b);};
 if(capture){res.write=function(chunk,encoding,cb){try{take(chunk,encoding);}catch{failed=true;}return write(chunk,encoding,cb);};res.end=function(chunk,encoding,cb){try{take(chunk,encoding);}catch{failed=true;}return end(chunk,encoding,cb);};}
 if(tracked)res.once('finish',()=>{try{observe(req,res,path,Buffer.concat(parts));}catch{failed=true;}});
 handler(req,res).catch(()=>{failed=true;if(!res.headersSent)res.writeHead(503);res.end();});
});
const stop=()=>{if(stopping)return;stopping=true;server.closeIdleConnections();server.close();};
process.on('message',m=>{if(m?.type==='SITE_CONSOLE_STOP')stop();if(m?.type==='QA_BROWSER_FLUSH'&&m.owner===config.owner){try{fsyncSync(fd);process.send?.({event:'QA_BROWSER_FLUSHED',owner:config.owner,request:m.request,failed});}catch{failed=true;}}});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
try{await new Promise((ok,no)=>{server.once('error',no);server.listen(runtime.config.port,runtime.config.host,ok);});console.log(JSON.stringify({event:'COLD_BROWSER_PAGE_HTTP_READY',owner:config.owner,port:runtime.config.port}));await new Promise(ok=>server.once('close',ok));}
finally{if(server.listening)await new Promise(ok=>server.close(ok));await runtime.close();fsyncSync(fd);closeSync(fd);if(process.connected)process.disconnect();if(failed)process.exitCode=1;}

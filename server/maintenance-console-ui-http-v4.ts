import {readFile} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createMaintenanceConsoleHttpV4} from './maintenance-console-http-v4.ts';
/** UI assets wrap the verified HTTP boundary; no new business privilege. */
export async function createMaintenanceConsoleUiHttpV4(options:Parameters<typeof createMaintenanceConsoleHttpV4>[0]){
 const files=[['/maintenance/','maintenance-console-v4.html','text/html; charset=utf-8'],['/maintenance/console.js','maintenance-console-v4.js','text/javascript; charset=utf-8'],['/maintenance/protocol.js','maintenance-console-protocol-v4.js','text/javascript; charset=utf-8'],['/maintenance/console.css','maintenance-console-v4.css','text/css; charset=utf-8']],assets=new Map<string,{body:Buffer;mime:string}>();
 for(const [path,file,mime]of files)assets.set(path,{body:await readFile(new URL('../public/'+file,import.meta.url)),mime});const backend=createMaintenanceConsoleHttpV4(options);
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const path=req.url?.split('?')[0];if(path==='/maintenance'&&req.method==='GET'){res.writeHead(302,{location:'/maintenance/','cache-control':'no-store'});res.end();return;}const file=assets.get(path||'');if(!file){await backend(req,res);return;}
  res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=()');res.setHeader('cache-control','no-store');
  if(!['GET','HEAD'].includes(req.method||'')){res.writeHead(405,{allow:'GET, HEAD'});res.end();return;}res.writeHead(200,{'content-type':file.mime,'content-length':file.body.length});res.end(req.method==='HEAD'?undefined:file.body);
 };
}

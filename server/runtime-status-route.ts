import {createHash,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {RuntimeReadiness} from './runtime-readiness.ts';
import {resident} from './capacity.ts';
import {validateRuntimeResources,type RuntimeResources} from './runtime-resource-contract.ts';

/** Cached/memory-only route. No downstream I/O or refresh method is reachable here. */
export function runtimeStatusRoutes(monitor:RuntimeReadiness,resources:()=>RuntimeResources,token?:string,startup?:()=>{contract:string;telemetryConnected:boolean;telemetrySubscribed:boolean;telemetryClosing:boolean;telemetryIntake?:ReturnType<import('./telemetry-intake-diagnostics.ts').TelemetryIntakeDiagnostics['snapshot']>}) {
  const validToken=typeof token==='string' && Buffer.byteLength(token)>=32 && token.length<=4096 && !/[\r\n]/.test(token);
  const expected=validToken?createHash('sha256').update(token!).digest():Buffer.alloc(32);
  let active=0;
  function authorized(req:IncomingMessage) {
    const host=req.socket.remoteAddress,raw=req.rawHeaders;
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(host||'') || req.headers.origin!==undefined || req.headers.cookie!==undefined) return false;
    if(raw.filter((_,i)=>i%2===0 && raw[i].toLowerCase()==='authorization').length!==1) return false;
    const header=req.headers.authorization;
    if(typeof header!=='string' || !header.startsWith('Bearer ') || header.length>4103) return false;
    const actual=createHash('sha256').update(header.slice(7)).digest();
    return timingSafeEqual(expected,actual);
  }
  function send(req:IncomingMessage,res:ServerResponse,status:number,data:unknown) {
    const text=JSON.stringify(data);if(Buffer.byteLength(text)>16384)throw Error('STATUS_RESPONSE_LIMIT');
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(text)});
    res.end(req.method==='HEAD'?undefined:text);
  }
  const unavailable={format:1,status:'NOT_READY',checkedAt:null,ageMs:null,productionApproved:false};
  return function handle(req:IncomingMessage,res:ServerResponse,url:URL):boolean {
    if(!['/api/v1/ready','/api/v1/runtime/status'].includes(url.pathname))return false;
    if(active>=16){res.setHeader('Retry-After','1');send(req,res,503,unavailable);return true;}
    active++;let account:ReturnType<typeof resident.account>|undefined,released=false;
    const release=()=>{if(released)return;released=true;active--;account?.release();res.off('finish',release);res.off('close',release);};
    res.once('finish',release);res.once('close',release);
    try {
      if(!['GET','HEAD'].includes(req.method||'')){res.setHeader('Allow','GET, HEAD');res.setHeader('Connection','close');send(req,res,405,{code:'METHOD_NOT_ALLOWED'});return true;}
      if(url.search || req.headers['transfer-encoding']!==undefined || req.headers['content-length']!==undefined && req.headers['content-length']!=='0'){
        res.setHeader('Connection','close');send(req,res,400,{code:'INVALID_STATUS_REQUEST'});return true;
      }
      account=resident.account('response');account.grow(16384);
      if(url.pathname==='/api/v1/runtime/status'){
        if(!validToken){send(req,res,503,{code:'MAINTENANCE_NOT_CONFIGURED'});return true;}
        if(!authorized(req)){send(req,res,401,{code:'MAINTENANCE_UNAUTHORIZED'});return true;}
        let measured:RuntimeResources|undefined;
        try {measured=validateRuntimeResources(resources());} catch {}
        send(req,res,200,{...monitor.view().detail,resources:measured||null,resourceCode:measured?'CHECK_PASSED':'RESOURCE_CONTRACT_INVALID',...(startup?{startup:startup()}:{})});
      } else {const view=monitor.view();send(req,res,view.ready?200:503,view.publicResult);}
    } catch {
      if(!res.headersSent){res.setHeader('Retry-After','1');send(req,res,503,unavailable);}
      else res.destroy();
    }
    return true;
  };
}

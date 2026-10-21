import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
/** Fault only a genuine upstream response; never synthesizes a successful service result. */
export async function createPredictiveAdoptionNetworkQa(baseUrl,kind){
 assert.ok(['FLOW','PREDICTOR'].includes(kind));const upstream=new URL(baseUrl);assert.equal(upstream.hostname,'127.0.0.1');const events=[];let mode='NORMAL',held;
 const event=v=>{events.push({...v,at:new Date().toISOString()});assert.ok(events.length<1000);};
 const server=createServer(async(req,res)=>{try{
  const chunks=[];let size=0;for await(const b of req){size+=b.length;assert.ok(size<=256*1024);chunks.push(b);}const body=Buffer.concat(chunks),path=req.url||'/',target=req.method==='POST'&&path===(kind==='FLOW'?'/v1/commands':'/v1/analyze'),r=await fetch(new URL(path,upstream),{method:req.method,headers:{authorization:String(req.headers.authorization||''),'content-type':'application/json',...(kind==='FLOW'?{'x-idms-tenant':String(req.headers['x-idms-tenant']||'')}:{})},...(!['GET','HEAD'].includes(req.method||'')?{body}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});let text=await r.text();
  if(target&&r.ok){const selected=mode;mode='NORMAL';let commandId;if(kind==='FLOW')commandId=JSON.parse(body).commandId;event({kind:'REAL_RESPONSE',service:kind,status:r.status,...(commandId?{commandId}:{}),sha256:createHash('sha256').update(text).digest('hex')});
   if(selected==='DROP'){event({kind:'DROPPED_ACTUAL_RESPONSE',commandId});res.destroy();return;}
   if(selected==='CORRUPT'){const v=JSON.parse(text);if(kind==='FLOW')v.requestDigest='0'.repeat(64);else v.inputDigest='0'.repeat(64);text=JSON.stringify(v);event({kind:'CORRUPTED_ACTUAL_RECEIPT',commandId});}
   if(selected==='HOLD'){event({kind:'HELD_REAL_RESPONSE',service:kind});await new Promise(ok=>{held=ok;});held=undefined;event({kind:'RELEASED_REAL_RESPONSE',service:kind});}
  }
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json'});res.end(text);
 }catch{event({kind:'NETWORK_ERROR',service:kind});res.destroy();}});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));return {baseUrl:'http://127.0.0.1:'+server.address().port,events,arm(next){assert.ok(['NORMAL','HOLD','CORRUPT','DROP'].includes(next));assert.ok(!held&&mode==='NORMAL');mode=next;},release(){assert.ok(held,'No real response currently held');held();},get held(){return !!held;},async close(){held?.();await new Promise(ok=>server.close(ok));}};
}

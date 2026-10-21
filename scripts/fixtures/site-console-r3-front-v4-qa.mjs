import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
/** Actual network fault boundary; no product controllers or browser session injection. */
export async function createSiteConsoleR3FrontQa(port){
 const events=[],held=new Map(),sessions=new Map();let fault='';
 const release=key=>{assert.ok(held.has(key));held.get(key)();held.delete(key);};
 const server=createServer(async(req,res)=>{try{
  const path=(req.url||'/').split('?')[0],chunks=[];let bytes=0;for await(const b of req){bytes+=b.length;assert.ok(bytes<=2*1024*1024);chunks.push(b);}const body=Buffer.concat(chunks),actor=req.headers['x-idms-actor-id'],sid=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('idms_session='))?.slice(13);if(typeof actor==='string'&&sid)sessions.set(actor,sid);
  const post=req.method==='POST'&&/^\/api\/v4\/predictive\/legacy\/commands\/[^/]+\/adopt$/.test(path),candidate=req.method==='GET'&&/^\/api\/v4\/predictive\/legacy\/commands\/[^/]+$/.test(path),selected=post&&['HOLD_ADOPTION','DROP_ADOPTION'].includes(fault)||candidate&&fault==='HOLD_CANDIDATE'?fault:'';if(selected)fault='';let controlId,commandId;
  if(post){controlId=JSON.parse(body).adoptionId;commandId=path.split('/').at(-2);events.push({kind:'ADOPTION_POST',actor,controlId,commandId});if(selected==='HOLD_ADOPTION'){events.push({kind:'HELD_ADOPTION',controlId,commandId});await new Promise(ok=>held.set('adoption',ok));}}
  const headers={...req.headers};delete headers.connection;delete headers['content-length'];const upstream=await new Promise((ok,no)=>{const r=request('http://127.0.0.1:'+port+(req.url||'/'),{method:req.method,headers},response=>{const parts=[];response.on('data',b=>parts.push(b));response.once('end',()=>ok({status:response.statusCode,headers:response.headers,bytes:Buffer.concat(parts)}));response.once('error',no);});r.once('error',no);r.setTimeout(30000,()=>r.destroy(Error('SITE_R3_FORWARD_TIMEOUT')));if(!['GET','HEAD'].includes(req.method||''))r.write(body);r.end();});
  if(path==='/api/v1/auth/login'&&typeof upstream.headers.location==='string'){const u=new URL(upstream.headers.location);events.push({kind:'PKCE_LOGIN',method:u.searchParams.get('code_challenge_method'),challenge:!!u.searchParams.get('code_challenge')});}if(path==='/api/v1/auth/callback')events.push({kind:'PKCE_CALLBACK',status:upstream.status});
  if(post){events.push({kind:'ADOPTION_RESPONSE',controlId,commandId,status:upstream.status});if(selected==='DROP_ADOPTION'&&upstream.status===202){events.push({kind:'DROPPED_ACCEPTANCE',controlId,commandId,partialBody:true});res.writeHead(202,{'content-type':'application/json','content-length':upstream.bytes.length});res.flushHeaders();await new Promise(ok=>res.write(upstream.bytes.subarray(0,8),ok));res.destroy();return;}}
  if(selected==='HOLD_CANDIDATE'){events.push({kind:'HELD_CANDIDATE',actor,path});await new Promise(ok=>held.set('candidate',ok));}
  const out={};for(const [k,v]of Object.entries(upstream.headers))if(!['connection','content-length','transfer-encoding'].includes(k)&&v!==undefined)out[k]=v;res.writeHead(upstream.status,out);res.end(upstream.bytes);
 }catch{res.destroy();}});
 await new Promise(ok=>server.listen(0,'localhost',ok));return {origin:'http://localhost:'+server.address().port,events,sessions,held,arm(value){assert.equal(fault,'');assert.ok(['HOLD_ADOPTION','DROP_ADOPTION','HOLD_CANDIDATE'].includes(value));fault=value;},release,async close(){for(const key of [...held.keys()])release(key);await new Promise(ok=>server.close(ok));}};
}

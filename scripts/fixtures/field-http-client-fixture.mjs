import {createServer} from 'node:http';
import {fieldIssuanceFixture} from './field-issuance-model.mjs';
import {appendFieldRegistryObservation} from '../../server/field-registry.ts';
import {prepareFieldLeaseIssuance} from '../../server/field-lease-issue.ts';
import {fieldCurrentLeaseCheck} from '../../server/field-current-check.ts';
import {verifyFieldLeaseRequest} from '../../integrations/field-request.ts';
import {signFieldLease} from '../../integrations/field-lease.ts';
import {verifyFieldCheckRequest,signFieldCheck} from '../../integrations/field-check.ts';
import {FieldLeaseClient} from '../../services/field/lease-client.ts';
export async function fieldHttpClientFixture(run){
 const f=fieldIssuanceFixture(),state={mode:null,lease:0,check:0,held:[],closedResponses:0,lastCheck:null},clients=[],sockets=new Set();appendFieldRegistryObservation(f.store,f.snapshot,'http-client-fixture');
 const server=createServer(async(req,res)=>{res.on('close',()=>state.closedResponses++);let input='';for await(const part of req)input+=part;try{const data=JSON.parse(input),isCheck=req.url.endsWith('/check');isCheck?state.check++:state.lease++;let result;if(isCheck){verifyFieldCheckRequest(data,f.requestKey,Date.now());result=signFieldCheck(fieldCurrentLeaseCheck(f.store,f.imports,data,f.snapshot,f.keys.publicKey,Date.now()),f.keys.privateKey);}else{verifyFieldLeaseRequest(data,f.requestKey,Date.now());result=signFieldLease(prepareFieldLeaseIssuance(f.store,f.imports,data,f.snapshot),f.keys.privateKey);}const mode=state.mode;state.mode=null;
   if(mode==='REDIRECT'){res.writeHead(307,{Location:'/redirect-target'});res.end();return;}if(mode==='HOLD'){state.held.push(()=>{if(!res.destroyed){res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}});return;}if(mode==='BAD_SIGNATURE')result.signature=(result.signature[0]==='A'?'B':'A')+result.signature.slice(1);if(mode==='FOREIGN')result.body.tenantId='sandbox';if(mode==='UNKNOWN')result.secret='PRIVATE';if(mode==='REPLAY_CHECK')result=state.lastCheck;if(isCheck&&mode!=='REPLAY_CHECK')state.lastCheck=structuredClone(result);res.setHeader('content-type','application/json');if(mode==='LARGE'){res.end(JSON.stringify({padding:'x'.repeat(9000)}));return;}if(mode==='UTF8'){res.end(Buffer.from([0xff,0x00,0x7b]));return;}if(mode==='INVALID_JSON'){res.end('{bad');return;}res.end(JSON.stringify(result));
  }catch{if(!res.destroyed){res.statusCode=503;res.setHeader('content-type','application/json');res.end('{"error":"OWNED_FIXTURE_FAILURE"}');}}});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const url='http://127.0.0.1:'+server.address().port+'/api/v1/field-channel/lease',make=(options={})=>{const client=new FieldLeaseClient({profile:f.profile,requestKey:f.requestKey,platformPublicKey:f.keys.publicKey,url,timeoutMs:1000,...options});clients.push(client);return client;};
 try{await run({...f,state,url,make,sockets});}finally{for(const c of clients)await c.close();for(const release of state.held.splice(0))release();server.closeAllConnections();await new Promise(ok=>server.close(ok));}
}

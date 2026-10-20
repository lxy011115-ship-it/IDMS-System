import assert from 'node:assert/strict';
// Parent IPC owns transitions. This gate does not freeze background SQL.
export function createCoreMaintenanceHttpGate(handler){
 let writable=false,epoch=0,blocked=0;
 const state=()=>({writable,epoch,blocked});
 return {state,setWritable(value,expectedEpoch){assert.equal(typeof value,'boolean');assert.equal(expectedEpoch,epoch,'HTTP maintenance epoch changed');if(value!==writable){writable=value;epoch++;}return state();},handler(req,res){let path;try{path=new URL(req.url,'http://127.0.0.1').pathname;}catch{path='';}const logout=req.method==='POST'&&path==='/api/v1/auth/logout',read=['GET','HEAD'].includes(req.method)&&!['/api/v1/auth/login','/api/v1/auth/callback'].includes(path);if(!writable&&!read&&!logout){blocked++;res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Connection':'close','Retry-After':'1'});res.end(JSON.stringify({error:'核心维护核验中，请使用同一业务幂等键稍后重试',code:'CORE_MAINTENANCE_READ_ONLY'}));req.resume();return;}return handler(req,res);}};
}

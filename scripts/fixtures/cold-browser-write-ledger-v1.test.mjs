import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {captureColdBrowserWriteBodyV1,summarizeColdBrowserWriteResponseV1,verifyColdBrowserPositiveWritesV1} from './cold-browser-write-ledger-v1-qa.mjs';

function fixture(){
 const accounts={operator:{id:randomUUID()},analyst:{id:randomUUID()}},rows=[],hash=name=>createHash('sha256').update(name).digest('hex');let sequence=0;
 const add=(name,value)=>{const row={sequence:++sequence,sessionCookieHash:hash(name),...value};rows.push(row);return row;};
 for(const name of Object.keys(accounts)){
  add(name,{method:'GET',path:'/api/v1/auth/login',status:303,authorization:{codeChallengeMethod:'S256',challengePresent:true,statePresent:true}});
  add(name,{method:'GET',path:'/api/v1/auth/callback',status:303,callback:{sessionCookieHash:hash(name),httpOnly:true,sameSiteLax:true}});
  add(name,{method:'GET',path:'/api/v1/auth/session',status:200,session:{authenticated:true,actorId:accounts[name].id}});
 }
 const response=(name,module,method,path,value)=>add(name,{method,path,status:method==='POST'?202:200,page:'/'+module+'/',csrfHeaderPresent:method==='POST',...summarizeColdBrowserWriteResponseV1(path,Buffer.from(JSON.stringify(value)))});
 const job=(name,module,action,result)=>{const id=randomUUID(),commandId=randomUUID();response(name,module,'POST','/api/v4/'+module+'/jobs',{job:{id,commandId,action,status:'ACCEPTED',businessCommitted:false,result:null}});response(name,module,'GET','/api/v4/'+module+'/commands/'+commandId,{job:{id,commandId,action,status:'COMMITTED',businessCommitted:true,result}});};
 const alertId=randomUUID(),orderId=randomUUID();job('operator','governance','TEMPLATE_CREATE',{id:randomUUID()});job('analyst','predictive','ANALYZE',{alertId,status:'ANALYZED'});job('operator','predictive','REVIEW',{alertId,order:{id:orderId},status:'WORK_ORDER_CREATED'});
 for(const [i,action,state]of [[0,'claim','ASSIGNED'],[1,'start','IN_PROGRESS'],[2,'submit','AWAITING_APPROVAL'],[3,'approval','CLOSED']]){
  const name=action==='approval'?'operator':'analyst';job(name,'maintenance',action,{id:orderId});response(name,'maintenance','GET','/api/v4/maintenance/orders/'+orderId,{item:{id:orderId,state,version:i+2,assignee:accounts.analyst.id,workflow:{status:'SYNCED'},resolution:i>=2?{submittedBy:accounts.analyst.id}:null,approval:i===3?{approver:accounts.operator.id,decision:'APPROVED'}:null}});
 }
 return {rows,accounts};
}

test('write summary excludes credential and descriptive response fields',()=>{
 const marker='PRIVATE_RESPONSE_TOKEN_MUST_NOT_PERSIST',path='/api/v4/maintenance/commands/'+randomUUID();
 const out=summarizeColdBrowserWriteResponseV1(path,Buffer.from(JSON.stringify({csrfToken:marker,tokens:{access_token:marker},job:{id:randomUUID(),commandId:randomUUID(),action:'submit',status:'COMMITTED',businessCommitted:true,sealedGrant:marker,result:{id:randomUUID(),password:marker,comment:marker,token:marker}}})));
 assert(!JSON.stringify(out).includes(marker));assert.equal(out.job.action,'submit');assert.equal(out.job.businessCommitted,true);assert.equal(captureColdBrowserWriteBodyV1('/api/v1/auth/session'),false);
});
test('linked real-session metadata and committed transitions produce a bounded proof',()=>{const f=fixture(),p=verifyColdBrowserPositiveWritesV1(f.rows,f.accounts);assert.equal(p.finalState,'CLOSED');assert.equal(p.repairCommandIds.length,4);assert.deepEqual(p.orderStates.map(r=>r.state),['ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL','CLOSED']);assert.notEqual(p.performedBy,p.approvedBy);});
test('a backend session without browser callback metadata is insufficient',()=>{const f=fixture();assert.throws(()=>verifyColdBrowserPositiveWritesV1(f.rows.filter(r=>r.path!=='/api/v1/auth/callback'),f.accounts),/BROWSER_WRITE_REAL_SESSION/);});
test('missing CSRF-protected GUI acceptance cannot pass',()=>{const f=fixture();for(const r of f.rows)r.csrfHeaderPresent=false;assert.throws(()=>verifyColdBrowserPositiveWritesV1(f.rows,f.accounts),/BROWSER_GUI_COMMITTED/);});
test('a terminal queue flag without verified business completion cannot pass',()=>{const f=fixture();for(const r of f.rows)if(r.job?.action==='REVIEW')r.job.businessCommitted=false;assert.throws(()=>verifyColdBrowserPositiveWritesV1(f.rows,f.accounts),/BROWSER_GUI_COMMITTED/);});
test('repair closure by its submitter is refused by the evidence checker',()=>{const f=fixture();f.rows.find(r=>r.order?.state==='CLOSED').order.approver=f.accounts.analyst.id;assert.throws(()=>verifyColdBrowserPositiveWritesV1(f.rows,f.accounts));});
test('missing confirmed workflow state or non-advancing version cannot pass',()=>{const f=fixture();f.rows.find(r=>r.order?.state==='IN_PROGRESS').order.workflowStatus='PENDING';assert.throws(()=>verifyColdBrowserPositiveWritesV1(f.rows,f.accounts),/BROWSER_GUI_ORDER_STATE_IN_PROGRESS/);const g=fixture();g.rows.find(r=>r.order?.state==='CLOSED').order.version=2;assert.throws(()=>verifyColdBrowserPositiveWritesV1(g.rows,g.accounts),/BROWSER_GUI_ORDER_VERSION/);});

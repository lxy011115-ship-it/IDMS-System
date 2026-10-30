import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

// Exercise the production upload handler without a server or business writes.
const source=readFileSync(new URL('../public/manual.js',import.meta.url),'utf8');
const start=source.indexOf('async function upload(file){');
const end=source.indexOf('async function useSample(',start);
assert.ok(start>=0&&end>start);

function harness(accepted,onRefresh=()=>{}){
  const notices=[],requests=[];
  const state={type:'DEVICE',source:'training',aiMode:'gateway',selected:null,auth:{mode:'oidc',authenticated:true},batches:[],catalog:{items:[]}};
  const context=vm.createContext({state,FormData,crypto:webcrypto,can:()=>true,
    api:async(path,options)=>{requests.push({path,options});return accepted;},
    load:async()=>onRefresh(state),notify:message=>notices.push(message)});
  vm.runInContext(source.slice(start,end),context);
  return {state,notices,requests,upload:()=>context.upload(new File(['a,b\n1,2'],'training.csv',{type:'text/csv'}))};
}
const batch=(status,version=1)=>({batchId:'accepted-1',status,version,snapshotDigest:'a'.repeat(64)});

test('upload retains the refreshed batch when AI review advances during reload',async()=>{
  const accepted=batch('AI_PENDING'),latest=batch('HUMAN_REVIEW',2);
  const h=harness(accepted,state=>{state.batches=[latest];state.selected=latest;});
  await h.upload();
  assert.equal(h.state.selected,latest);
  assert.equal(h.state.selected.version,2);
  assert.match(h.notices[0],/人工复核依据/);
  assert.match(h.notices[0],/尚未入库/);
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].options.body.get('sourceSystem'),'training');
});

test('pending AI, validation failure and awaiting approval give distinct next steps',async()=>{
  for(const [status,expected,excluded] of [
    ['AI_PENDING',/仍在处理中/,/校验已完成/],
    ['VALIDATION_FAILED',/查看逐行错误/,/等待另一名人员终审/],
    ['AWAITING_APPROVAL',/等待另一名人员终审/,/仍在处理中/]
  ]){
    const h=harness(batch(status));await h.upload();
    assert.match(h.notices[0],expected);assert.doesNotMatch(h.notices[0],excluded);
    assert.match(h.notices[0],/尚未入库/);
  }
});

test('refresh that clears the authenticated session cannot resurrect its accepted batch',async()=>{
  const h=harness(batch('AI_PENDING'),state=>{state.auth={mode:'oidc',authenticated:false};state.selected=null;state.batches=[];});
  await h.upload();
  assert.equal(h.state.selected,null);
  assert.equal(h.notices.length,0);
});

test('accepted batch remains available if the follow-up refresh fails without another POST',async()=>{
  const accepted=batch('AI_PENDING');
  const h=harness(accepted,()=>{throw Error('refresh unavailable');});
  await assert.rejects(h.upload(),/refresh unavailable/);
  assert.equal(h.state.selected,accepted);
  assert.equal(h.requests.length,1);
  assert.equal(h.notices.length,0);
});

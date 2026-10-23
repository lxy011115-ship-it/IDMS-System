import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {privateNewFile} from '../backup-support.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fields = ['format','owner','nonce','origin','stage','capturedAt','local','session','indexedDbNames','cacheNames','recoveryView'];
const snapshotFields = ['owner','nonce','origin','capturedAt','local','session','indexedDbNames','cacheNames','recoveryView'];
export function validateColdBrowserPageCaptureV2(value, {owner,nonce,origin,startedAt,now=Date.now()}) {
 assert(value && typeof value==='object' && !Array.isArray(value), 'PAGE_CAPTURE_OBJECT');
 assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), 'PAGE_CAPTURE_FIELDS');
 assert.equal(value.format, 'IDMS_COLD_BROWSER_PAGE_CAPTURE_V2');
 assert(value.owner===owner && /^[a-f0-9-]{36}$/.test(owner) && value.nonce===nonce && /^[a-f0-9]{12}$/.test(nonce), 'PAGE_CAPTURE_OWNER');
 assert(value.origin===origin && new URL(origin).origin===origin && new URL(origin).hostname==='127.0.0.1' && new URL(origin).protocol==='http:', 'PAGE_CAPTURE_ORIGIN');
 assert(['active','switched','logout'].includes(value.stage), 'PAGE_CAPTURE_STAGE');
 assert(Number.isSafeInteger(value.capturedAt) && value.capturedAt>=startedAt && value.capturedAt<=now+1000 && now-value.capturedAt<=30000, 'PAGE_CAPTURE_TIME');
 for(const rows of [value.local,value.session]) {
  assert(Array.isArray(rows) && rows.length<=100, 'PAGE_CAPTURE_ENTRY_LIMIT');
  const seen=new Set();
  for(const row of rows) {
   assert(Array.isArray(row) && row.length===2 && row.every(v=>typeof v==='string'), 'PAGE_CAPTURE_ENTRY');
   assert(row[0].length<=512 && Buffer.byteLength(row[1])<=65536 && !seen.has(row[0]), 'PAGE_CAPTURE_ENTRY_SIZE_OR_DUPLICATE'); seen.add(row[0]);
  }
 }
 for(const names of [value.indexedDbNames,value.cacheNames]) assert(Array.isArray(names) && names.length<=100 && names.every(n=>typeof n==='string' && n.length<=512) && new Set(names).size===names.length, 'PAGE_CAPTURE_INVENTORY');
 if(value.stage==='logout') assert.equal(value.recoveryView,null,'PAGE_CAPTURE_LOGOUT_VIEW');
 else {
  const view=value.recoveryView;
  assert(view && Object.keys(view).sort().join(',')==='page,visibleReferenceIds' && view.page==='/maintenance/' && Array.isArray(view.visibleReferenceIds) && view.visibleReferenceIds.length<=100 && view.visibleReferenceIds.every(v=>typeof v==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v)) && new Set(view.visibleReferenceIds).size===view.visibleReferenceIds.length, 'PAGE_CAPTURE_RECOVERY_VIEW');
 }
 return value;
}

export function verifyColdBrowserPageSnapshotBindingV2(envelope, snapshot, {owner,nonce,origin,stage,index,expectedSessionHash,startedAt,now=Date.now()}) {
 assert(envelope && Object.keys(envelope).sort().join(',')==='acceptedAt,bodySha256,format,index,nonce,owner,sessionCookieHash,snapshot,stage', 'PAGE_CAPTURE_ENVELOPE_FIELDS');
 assert.equal(envelope.format,'IDMS_COLD_BROWSER_PAGE_RECEIPT_V2');
 assert(envelope.owner===owner && envelope.nonce===nonce && envelope.stage===stage && envelope.index===index, 'PAGE_CAPTURE_ENVELOPE_OWNER');
 const value=validateColdBrowserPageCaptureV2(envelope.snapshot,{owner,nonce,origin,startedAt,now:envelope.acceptedAt});
 assert(envelope.acceptedAt<=now+1000 && envelope.acceptedAt>=value.capturedAt && envelope.bodySha256===sha(JSON.stringify(value)), 'PAGE_CAPTURE_ENVELOPE_DIGEST');
 assert.equal(envelope.sessionCookieHash,expectedSessionHash,'PAGE_CAPTURE_SESSION_BINDING');
 assert.equal(value.stage,stage,'PAGE_CAPTURE_STAGE_BINDING');
 for(const field of snapshotFields) assert.deepEqual(snapshot[field],value[field],'PAGE_CAPTURE_SNAPSHOT_BINDING_'+field);
 return {pageCaptureIndex:index,pageCaptureSha256:envelope.bodySha256,pageAcceptedAt:envelope.acceptedAt,requestSessionBound:true};
}

export function verifyColdBrowserCookieSealV2(seal,envelope,snapshot,{pageBytes,snapshotBytes,adapterSha256,now=Date.now()}) {
 assert(seal&&seal.format==='IDMS_COLD_BROWSER_PAGE_SEAL_V2'&&seal.owner===envelope.owner&&seal.nonce===envelope.nonce&&seal.index===envelope.index&&seal.stage===envelope.stage,'PAGE_CAPTURE_SEAL_OWNER');
 const number=String(envelope.index).padStart(4,'0');
 assert(seal.pageFile==='browser-page-storage-'+number+'.private.json'&&seal.file==='browser-storage-'+number+'.private.json','PAGE_CAPTURE_SEAL_FILE');
 assert(seal.pageFileSha256===sha(pageBytes)&&seal.pageBodySha256===envelope.bodySha256&&seal.snapshotSha256===sha(snapshotBytes),'PAGE_CAPTURE_SEAL_DIGEST');
 assert(seal.implementationSha256===adapterSha256&&seal.cookieReadMethod==='Network.getCookies'&&seal.rawCookieValuesPersisted===false&&seal.rawStorageValuesDisplayed===false,'PAGE_CAPTURE_SEAL_IMPLEMENTATION');
 assert.deepEqual(seal.cookiePaths,['/','/maintenance/','/governance/','/predictive/','/reconciliation/','/api/v1/auth/login','/api/v1/auth/callback','/api/v1/auth/session','/api/v1/auth/logout'],'PAGE_CAPTURE_SEAL_COOKIE_PATHS');
 assert(Number.isSafeInteger(seal.cookieCapturedAt)&&seal.cookieCapturedAt>=envelope.acceptedAt&&seal.cookieCapturedAt-envelope.snapshot.capturedAt<=30000&&seal.cookieCapturedAt<=now+1000,'PAGE_CAPTURE_SEAL_TIME');
 assert(seal.cookieCount===snapshot.cookies.length&&seal.cookieMetadataSha256===sha(JSON.stringify(snapshot.cookies)),'PAGE_CAPTURE_SEAL_COOKIES');
 return {cookieReadMethod:seal.cookieReadMethod,cookieCapturedAt:seal.cookieCapturedAt,cookieCount:seal.cookieCount,adapterSha256:seal.implementationSha256,rawCookieValuesPersisted:false};
}

export function coldBrowserPageCollectorMarkupV2() {
 return '<section class="card" id="qa-storage-panel" aria-labelledby="qa-storage-heading"><h2 id="qa-storage-heading">独立测试：本页存储采集</h2><p>仅本轮恢复验收使用。只读本源存储，原始内容只写入本机私有证据，页面显示数量与摘要。</p><label>存储采集阶段<select id="qa-storage-stage"><option value="active">写入后</option><option value="switched">换号后</option><option value="logout">退出后</option></select></label><button id="qa-storage-capture" type="button">采集本页存储</button><p id="qa-storage-status" role="status">尚未采集</p><pre id="qa-storage-summary"></pre></section><script type="module" src="/__qa/browser-storage-v2/collector.js"></script>';
}

export function coldBrowserPageCollectorScriptV2({owner,nonce,origin}) {
 return `const config=${JSON.stringify({owner,nonce,origin})};
const status=document.querySelector('#qa-storage-status'),summary=document.querySelector('#qa-storage-summary'),button=document.querySelector('#qa-storage-capture');
function entries(storage){if(storage.length>100)throw Error('存储条目超限');const rows=[];for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key===null||key.length>512)throw Error('存储键不可用');const value=storage.getItem(key);if(value===null||new TextEncoder().encode(value).length>65536)throw Error('存储值不可用或超限');rows.push([key,value]);}if(rows.length!==storage.length||rows.some(([key,value])=>storage.getItem(key)!==value))throw Error('采集期间存储变化');return rows;}
const visible=element=>!!element&&!element.closest('[hidden]')&&element.getClientRects().length>0;
button.onclick=async()=>{button.disabled=true;try{if(location.origin!==config.origin||location.pathname!=='/maintenance/')throw Error('页面来源不匹配');const stage=document.querySelector('#qa-storage-stage').value;let recoveryView=null;
if(stage==='logout'){if(!visible(document.querySelector('#signed-out'))||visible(document.querySelector('#workspace')))throw Error('请先完成真实退出');}
else{const list=document.querySelector('#job-list');if(!visible(list)||document.querySelector('[data-tab="jobs"]').getAttribute('aria-selected')!=='true')throw Error('请先打开当前账号的我的作业');recoveryView={page:'/maintenance/',visibleReferenceIds:[...new Set(list.innerText.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g)||[])]};}
if(typeof indexedDB.databases!=='function'||typeof caches.keys!=='function')throw Error('浏览器缺少必需只读能力');status.textContent='正在只读采集本页存储';const local=entries(localStorage),session=entries(sessionStorage),indexedDbNames=(await indexedDB.databases()).map(v=>{if(typeof v.name!=='string')throw Error('数据库名称不可用');return v.name;}),cacheNames=await caches.keys();if(JSON.stringify(local)!==JSON.stringify(entries(localStorage))||JSON.stringify(session)!==JSON.stringify(entries(sessionStorage)))throw Error('采集期间存储变化');
const snapshot={format:'IDMS_COLD_BROWSER_PAGE_CAPTURE_V2',...config,stage,capturedAt:Date.now(),local,session,indexedDbNames,cacheNames,recoveryView};const response=await fetch('/__qa/browser-storage-v2/capture',{method:'POST',headers:{'Content-Type':'application/json','X-QA-Owner':config.owner,'X-QA-Nonce':config.nonce},body:JSON.stringify(snapshot)});if(!response.ok)throw Error('采集回执保存失败 '+response.status);const result=await response.json();summary.textContent=JSON.stringify(result,null,2);status.dataset.index=String(result.index);status.dataset.stage=stage;status.textContent='采集已保存：'+stage+' #'+result.index;
}catch(error){status.textContent='采集未完成：'+error.message;}finally{button.disabled=false;}};`;
}

export function createColdBrowserPageCollectorV2({owner,nonce,origin,work,startedAt,cookieHash}) {
 assert(/^[a-f0-9-]{36}$/.test(owner) && /^[a-f0-9]{12}$/.test(nonce) && Number.isSafeInteger(startedAt));
 assert.equal(new URL(origin).hostname,'127.0.0.1');
 let index=0,busy=false;
 const markup=Buffer.from(coldBrowserPageCollectorMarkupV2());
 return {
  injectMaintenance(res) {
   const head=res.writeHead.bind(res),end=res.end.bind(res);let expectedLength=null;
   res.writeHead=function(status,headers){assert.equal(status,200);assert(headers && /text\/html/.test(headers['content-type']) && Number.isSafeInteger(headers['content-length']),'PAGE_CAPTURE_HTML_HEADERS');expectedLength=headers['content-length']+markup.length;return head(status,{...headers,'content-length':expectedLength});};
   res.end=function(chunk,encoding,callback){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:'utf8');const text=bytes.toString('utf8');assert.equal(text.split('</body>').length,2,'PAGE_CAPTURE_HTML_BODY');const value=Buffer.from(text.replace('</body>',markup.toString('utf8')+'</body>'));assert.equal(value.length,expectedLength,'PAGE_CAPTURE_HTML_LENGTH');return end(value,typeof encoding==='function'?encoding:callback);};
  },
  async handle(req,res) {
   const url=new URL(req.url??'/',origin);
   if(!url.pathname.startsWith('/__qa/browser-storage-v2/'))return false;
   const respond=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
   let ownsBusy=false;
   try {
    assert.equal(req.headers.host,new URL(origin).host);assert.equal(url.search,'');
    if(req.method==='GET'&&url.pathname==='/__qa/browser-storage-v2/collector.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(coldBrowserPageCollectorScriptV2({owner,nonce,origin}));return true;}
    assert(req.method==='POST'&&url.pathname==='/__qa/browser-storage-v2/capture','PAGE_CAPTURE_ROUTE');
    assert(req.headers.origin===origin && req.headers['content-type']==='application/json' && req.headers['x-qa-owner']===owner && req.headers['x-qa-nonce']===nonce,'PAGE_CAPTURE_REQUEST_BINDING');
    const referer=new URL(req.headers.referer);assert(referer.origin===origin&&referer.pathname==='/maintenance/','PAGE_CAPTURE_REQUEST_PAGE');
    if(req.headers['content-length']!==undefined)assert(/^[0-9]+$/.test(req.headers['content-length'])&&Number(req.headers['content-length'])<=256*1024,'PAGE_CAPTURE_BODY_LIMIT');
    assert(!busy && index<3,'PAGE_CAPTURE_SEQUENCE');busy=true;ownsBusy=true;
    const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;assert(bytes<=256*1024,'PAGE_CAPTURE_BODY_LIMIT');chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8'),snapshot=JSON.parse(body);assert.equal(JSON.stringify(snapshot),body,'PAGE_CAPTURE_CANONICAL_BODY');
    validateColdBrowserPageCaptureV2(snapshot,{owner,nonce,origin,startedAt});assert.equal(snapshot.stage,['active','switched','logout'][index],'PAGE_CAPTURE_STAGE_ORDER');
    const next=index+1,envelope={format:'IDMS_COLD_BROWSER_PAGE_RECEIPT_V2',owner,nonce,index:next,stage:snapshot.stage,acceptedAt:Date.now(),sessionCookieHash:cookieHash(req.headers.cookie),bodySha256:sha(body),snapshot};
    const file='browser-page-storage-'+String(next).padStart(4,'0')+'.private.json';await privateNewFile(join(work,file),JSON.stringify(envelope));index=next;
    respond(201,{owner,nonce,index,stage:snapshot.stage,file,bodySha256:envelope.bodySha256,localKeys:snapshot.local.length,sessionKeys:snapshot.session.length,indexedDbCount:snapshot.indexedDbNames.length,cacheCount:snapshot.cacheNames.length,visibleRecoveryReferences:snapshot.recoveryView?.visibleReferenceIds.length??0,rawValuesDisplayed:false});
   }catch{req.resume();if(!res.headersSent)respond(400,{error:'PAGE_CAPTURE_REJECTED'});else res.destroy();}
   finally{if(ownsBusy)busy=false;}
   return true;
  }
 };
}

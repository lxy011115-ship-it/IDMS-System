import assert from 'node:assert/strict';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
/** Called only through CUA with its supported tab/CDP handles; no independent browser client. */
export async function capturePageSnapshot({tab,cdp,ready,index,stage}){
 assert(Number.isInteger(index)&&index>=1&&index<=3&&['active','switched','logout'][index-1]===stage);
 assert.equal(new URL(await tab.url()).origin,ready.origin);assert.equal(new URL(await tab.url()).pathname,'/maintenance/');
 const number=String(index).padStart(4,'0'),pageName='browser-page-storage-'+number+'.private.json',finalName='browser-storage-'+number+'.private.json';
 for(const name of [pageName,finalName,'browser-storage-'+number+'.capture.json'])await assert.rejects(lstat(join(ready.work,name)),{code:'ENOENT'});
 await tab.playwright.locator('#qa-storage-stage').selectOption(stage);
 await tab.getAXState({emit:false});
 await tab.playwright.getByRole('button',{name:'采集本页存储',exact:true}).click();
 await tab.getAXState({emit:false});
 await tab.playwright.getByText('采集已保存：'+stage+' #'+index,{exact:true}).waitFor({state:'visible',timeoutMs:15000});
 const pageBytes=await readFile(join(ready.work,pageName)),page=JSON.parse(pageBytes.toString('utf8'));
 assert.equal(page.owner,ready.owner);assert.equal(page.nonce,ready.nonce);assert.equal(page.index,index);assert.equal(page.stage,stage);assert.equal(page.bodySha256,sha(JSON.stringify(page.snapshot)));
 const cookiePaths=['/','/maintenance/','/governance/','/predictive/','/reconciliation/','/api/v1/auth/login','/api/v1/auth/callback','/api/v1/auth/session','/api/v1/auth/logout'];
 const observed=await cdp.send('Network.getCookies',{urls:cookiePaths.map(path=>ready.origin+path)}),cookieCapturedAt=Date.now();
 assert(Array.isArray(observed.cookies)&&observed.cookies.length<=100);assert(cookieCapturedAt>=page.snapshot.capturedAt&&cookieCapturedAt-page.snapshot.capturedAt<=30000);
 const cookies=observed.cookies.map(c=>({name:c.name,valueSha256:sha(c.value),domain:c.domain,path:c.path,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite??null,session:c.session,expires:c.expires}));
 const sessions=cookies.filter(c=>c.name==='idms_session');assert.equal(sessions.length,page.sessionCookieHash===null?0:1);if(sessions.length)assert.equal(sessions[0].valueSha256,page.sessionCookieHash);
 const {format,stage:capturedStage,...value}=page.snapshot;
 assert.equal(format,'IDMS_COLD_BROWSER_PAGE_CAPTURE_V2');assert.equal(capturedStage,stage);
 const snapshot={format:'IDMS_COLD_BROWSER_STORAGE_SNAPSHOT_V1',...value,cookies},bytes=Buffer.from(JSON.stringify(snapshot)+'\n');assert(bytes.length<=256*1024);
 const proof={format:'IDMS_COLD_BROWSER_PAGE_SEAL_V2',owner:ready.owner,nonce:ready.nonce,index,stage,pageFile:pageName,pageFileSha256:sha(pageBytes),pageBodySha256:page.bodySha256,cookieCapturedAt,cookiePaths,cookieMetadataSha256:sha(JSON.stringify(cookies)),cookieCount:cookies.length,cookieReadMethod:'Network.getCookies',file:finalName,snapshotSha256:sha(bytes),implementationSha256:sha(await readFile(new URL(import.meta.url))),rawCookieValuesPersisted:false,rawStorageValuesDisplayed:false};
 await writeFile(join(ready.work,'browser-storage-'+number+'.capture.json'),JSON.stringify(proof)+'\n',{flag:'wx',mode:0o600});
 await writeFile(join(ready.work,finalName),bytes,{flag:'wx',mode:0o600});
 await tab.getAXState({emit:false});
 return {file:finalName,stage,index,localKeys:snapshot.local.length,sessionKeys:snapshot.session.length,indexedDbCount:snapshot.indexedDbNames.length,cacheCount:snapshot.cacheNames.length,cookies:cookies.length,visibleRecoveryReferences:snapshot.recoveryView?.visibleReferenceIds.length??0,snapshotSha256:proof.snapshotSha256,rawValuesDisplayed:false};
}

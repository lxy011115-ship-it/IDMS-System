import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,randomBytes} from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import {chromium} from 'playwright';
import ExcelJS from 'exceljs';
import {dataOverview,dataMeasurements} from '../server/data-management.ts';
import {dataOverviewSql,dataMeasurementsSql} from '../server/data-management-sql.ts';
import {assetCsv,measurementCsv} from '../server/data-export.ts';
import {initializeDataProjection} from '../server/data-projection.ts';
import {createBatch,approveBatch,emptyImports,canonical,digest} from '../server/imports.ts';
import {seedStore} from '../server/store.ts';

const exec=promisify(execFile),namespace='exportqa-'+randomUUID(),directory=resolve('.local',namespace),dataDir=join(directory,'postgres'),bin=join(process.env.LOCALAPPDATA,'IDMS/runtime/pgsql/bin');
const uploader={tenantId:'acme',actorId:'uploader',actorType:'USER',authMode:'oidc',roles:['data-uploader'],correlationId:'export-qa'},approver={...uploader,actorId:'approver',roles:['final-approver']},auditor={...uploader,roles:['auditor']};
const data=emptyImports(),store=seedStore(),errors=[];let pool,core,browser,pgStarted=false;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise((ok,fail)=>{s.once('error',fail);s.listen(0,'127.0.0.1',ok);});const port=s.address().port;await new Promise(ok=>s.close(ok));return port;}
async function ctl(args){await new Promise((ok,fail)=>{const child=spawn(join(bin,'pg_ctl.exe'),args,{windowsHide:true,stdio:'ignore'});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error('Isolated QA PostgreSQL command failed; inspect '+join(directory,'postgres.log'))));});}
function add(type,rows){const batch=createBatch(data,store,{dataType:type,rows,original:Buffer.from(JSON.stringify(rows)),filename:'qa.json',mime:'application/json',templateVersion:'1.0.0',sourceSystem:'export-qa',sourceKind:'API_JSON'},uploader);assert.equal(batch.status,'AWAITING_APPROVAL',JSON.stringify(batch.errors));approveBatch(data,store,batch.batchId,{decision:'APPROVED',comment:'独立核验合成数据',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},approver);return batch;}
function localDigest(){return Promise.all(['.demo-data/local/imports.json','.local/postgres-business.json','.local/postgres-runtime.json'].map(async path=>{try{return [path,digest(await readFile(path))];}catch(e){if(e.code==='ENOENT')return [path,null];throw e;}}));}
const originalDigests=await localDigest();
try{
  await mkdir(directory,{recursive:true});
  const password=randomBytes(32).toString('base64url'),pw=join(directory,'password');await writeFile(pw,password,{mode:0o600});
  if(process.platform==='win32')await exec('icacls.exe',[pw,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`],{windowsHide:true});
  await exec(join(bin,'initdb.exe'),['-D',dataDir,'-U','exportqa','-A','scram-sha-256','--pwfile',pw,'--encoding=UTF8','--locale=C'],{windowsHide:true});
  const port=await freePort();await ctl(['start','-D',dataDir,'-l',join(directory,'postgres.log'),'-o',`-p ${port} -h 127.0.0.1`,'-w']);pgStarted=true;
  pool=new pg.Pool({host:'127.0.0.1',port,user:'exportqa',password,database:'postgres'});
  const assets=[{source_record_id:'pump',device_code:'PUMP-01',device_name:' =HYPERLINK("unsafe")',site_code:'FACTORY-01',line_code:'LINE-01',equipment_type:'泵组',brand:'双引号"和,逗号\n换行'},{source_record_id:'comp',device_code:'COMP-01',device_name:'空压机',site_code:'FACTORY-02',line_code:'LINE-02',equipment_type:'空压机'}];
  add('DEVICE',assets);add('POINT_DEFINITION',assets.map((a,i)=>({source_record_id:'point-'+i,device_code:a.device_code,tag_code:'pressure',tag_name:i?'压力':'@SUM(1)',unit:'MPa',min_value:-10,max_value:10})));
  const records=Array.from({length:122},(_,i)=>({source_record_id:'reading-'+i,device_code:i<120?'PUMP-01':'COMP-01',tag_code:'pressure',measured_at:new Date(Date.parse('2026-10-13T00:00:00Z')+i*60000).toISOString(),value:i%2?-1.2:1.2,unit:'MPa',quality:i%2?'BAD':'GOOD'}));
  add('MEASUREMENT',records);
  // This batch is deliberately pending and must never appear in either export.
  createBatch(data,store,{dataType:'MEASUREMENT',rows:[{...records[0],source_record_id:'pending',measured_at:'2026-10-14T00:00:00Z'}],original:Buffer.from('pending'),filename:'pending.json',mime:'application/json',templateVersion:'1.0.0',sourceSystem:'export-qa',sourceKind:'API_JSON'},uploader);
  const client=await pool.connect();try{await client.query('BEGIN');await initializeDataProjection(client,data,'acme');await client.query('COMMIT');}finally{client.release();}
  const scopes=[auditor,...[{sites:['FACTORY-01'],lines:[],devices:[]},{sites:[],lines:['LINE-01'],devices:[]},{sites:[],lines:[],devices:['PUMP-01']},{sites:['FACTORY-01'],lines:['LINE-01'],devices:['PUMP-01']},{sites:['UNKNOWN'],lines:[],devices:[]}].map(scope=>({...auditor,roles:['equipment-admin'],scope:{provided:true,...scope}})),{...auditor,roles:['equipment-admin'],scope:{provided:false,sites:[],lines:[],devices:[]}},{...auditor,tenantId:'sandbox'}];
  for(const ctx of scopes){
    for(const filter of [{},{q:'泵'},{equipmentType:'空压机'},{q:"%' OR 1=1 --"},{siteCode:'FACTORY-01'}]){
      const p=new URLSearchParams(filter);assert.deepEqual(await dataOverviewSql(pool,ctx,p),dataOverview(data,ctx,p));assert.equal(assetCsv(await dataOverviewSql(pool,ctx,p,true)),assetCsv(dataOverview(data,ctx,p,true)));
    }
    for(const filter of [{},{deviceCode:'PUMP-01',quality:'BAD'},{tagCode:'pressure',from:'2026-10-13T08:30:00+08:00',to:'2026-10-13T09:30:00+08:00'},{deviceCode:'COMP-01'},{quality:'UNCERTAIN'}]){
      const p=new URLSearchParams(filter);assert.deepEqual(await dataMeasurementsSql(pool,ctx,p),dataMeasurements(data,ctx,p));assert.equal(measurementCsv(await dataMeasurementsSql(pool,ctx,p,true)),measurementCsv(dataMeasurements(data,ctx,p,true)));
    }
  }
  await assert.rejects(dataOverviewSql(pool,{...auditor,roles:[]},new URLSearchParams(),true),/权限/);
  // Force a count over the bound without materializing rows: prove the guard fires before fetching.
  let queryCount=0;const cappedPool={async connect(){return {async query(sql){queryCount++;if(sql.includes('SELECT count(*) FROM current_measurements'))return {rows:[{count:'10001'}]};return {rows:[]};},release(){}};}};
  await assert.rejects(dataMeasurementsSql(cappedPool,auditor,new URLSearchParams(),true),/超过10000行/);assert.equal(queryCount,3);
  const snapshotDir=resolve('.demo-data',namespace);await mkdir(snapshotDir,{recursive:true});const {audits,idempotency,...business}=store;
  await writeFile(join(snapshotDir,'imports.json'),JSON.stringify({version:2,imports:data,business,audits,idempotency:[...idempotency]}));
  const webPort=await freePort(),base='http://127.0.0.1:'+webPort;
  let log='';core=spawn(process.execPath,['server/index.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(webPort),IDMS_STORAGE:'file',IDMS_AUTH_MODE:'demo',IDMS_DEMO_NAMESPACE:namespace,IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:''}});for(const stream of [core.stdout,core.stderr])stream.on('data',b=>log=(log+b).slice(-4000));
  let ready=false;for(let i=0;i<100;i++){if(core.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok){ready=true;break;}}catch{}await pause(100);}assert.ok(ready,'QA HTTP startup');
  const headers={'X-Tenant-Id':'acme','X-Actor-Id':'demo.auditor','X-Actor-Type':'USER'};
  const response=await fetch(base+'/api/v1/data-management/measurements/export?deviceCode=PUMP-01&quality=BAD',{headers});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/csv/);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-disposition'),/attachment; filename="idms-measurements.csv"/);assert.equal(await response.text(),measurementCsv(dataMeasurements(data,auditor,new URLSearchParams({deviceCode:'PUMP-01',quality:'BAD'}),true)).slice(1));
  for(const filter of ['page=1','tenant_id=sandbox','quality=INVALID','deviceCode=A&deviceCode=B','from=2026-02-30T00%3A00%3A00Z'])assert.equal((await fetch(base+'/api/v1/data-management/measurements/export?'+filter,{headers})).status,400);
  assert.equal((await fetch(base+'/api/v1/data-management/assets/export')).status,401);
  const other=await fetch(base+'/api/v1/data-management/assets/export',{headers:{...headers,'X-Tenant-Id':'sandbox'}});assert.equal((await other.text()).split('\r\n').length,2);
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/?view=data-center');await page.getByRole('heading',{name:'设备档案',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await page.locator('#actor-select').selectOption('demo.auditor');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  const form=page.locator('#data-measurement-filter');await form.locator('[name=deviceCode]').fill('PUMP-01');await form.locator('[name=quality]').selectOption('BAD');await form.locator('[data-action=data-measurement-filter]').click();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  // Unsaved edits must not silently change the export filter.
  await page.locator('#data-measurement-filter [name=quality]').selectOption('GOOD');
  const downloaded=page.waitForEvent('download');await page.locator('[data-action=data-measurement-export]').click();const download=await downloaded;assert.equal(download.suggestedFilename(),'idms-measurements.csv');const bytes=await readFile(await download.path());assert.equal(bytes.toString('utf8'),measurementCsv(dataMeasurements(data,auditor,new URLSearchParams({deviceCode:'PUMP-01',quality:'BAD'}),true)));
  const book=new ExcelJS.Workbook();await book.csv.read(await download.createReadStream());assert.equal(book.worksheets[0].rowCount,61);assert.equal(book.worksheets[0].getRow(2).getCell(5).value,-1.2);assert.equal(book.worksheets[0].getRow(2).getCell(3).value,"'@SUM(1)");
  await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  // An invalid applied query keeps exports tied to the last successful query.
  await page.locator('#data-measurement-filter [name=from]').fill('invalid');await page.locator('[data-action=data-measurement-filter]').click();await page.locator('[role=alert]').waitFor();const retryDownload=page.waitForEvent('download');await page.locator('[data-action=data-measurement-export]').click();assert.deepEqual(await readFile(await (await retryDownload).path()),bytes);
  await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  const assetDownload=page.waitForEvent('download');await page.locator('[data-action=data-asset-export]').click();const assetBytes=await readFile(await (await assetDownload).path());assert.equal(assetBytes.toString('utf8'),assetCsv(dataOverview(data,auditor,new URLSearchParams(),true)));
  const assetBook=new ExcelJS.Workbook();await assetBook.csv.read(await (await assetDownload).createReadStream());assert.equal(assetBook.worksheets[0].rowCount,3);assert.equal(assetBook.worksheets[0].getRow(2).getCell(2).value,"'=HYPERLINK(\"unsafe\")");assert.equal(assetBook.worksheets[0].getRow(2).getCell(6).value,'双引号"和,逗号\n换行');
  await page.waitForFunction(()=>!document.querySelector('.busy-line'));await page.locator('#data-measurement-filter [name=from]').fill('');await page.locator('[data-action=data-measurement-filter]').click();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await mkdir('outputs/demo-preview',{recursive:true});await page.screenshot({path:'outputs/demo-preview/39-data-export-desktop.png',fullPage:false});
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}await page.screenshot({path:'outputs/demo-preview/40-data-export-mobile.png',fullPage:false});assert.deepEqual(errors,[]);
  assert.deepEqual(await localDigest(),originalDigests);
  const evidence={verifiedAt:new Date().toISOString(),namespace,syntheticDataOnly:true,isolatedPostgres:true,sqlFileContractAndCsvMatch:true,siteLineDeviceAndEmptyScope:true,scopedSummaryTypesSitesAndDefinitions:true,sqlCountCapBeforeFetch:true,httpHeadersAndInvalidQueries:true,crossTenantAndUnauthenticatedExport:true,pendingRecordsExcluded:true,csvExcelRoundTripAndFormulaText:true,fullFilteredDownloadNotCurrentPage:true,unsavedAndFailedFiltersKeepSuccessfulExport:true,browserDesktopAndMobile320390:true,originalLocalSnapshotAndRuntimeConfigsUnchanged:true,realKeycloakEndToEnd:false,productionAcceptance:false,pageErrors:errors};await writeFile('outputs/data-export-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{
  await browser?.close();if(core&&core.exitCode===null){const ended=new Promise(ok=>core.once('exit',ok));core.kill();await ended;}await pool?.end();if(pgStarted)await ctl(['stop','-D',dataDir,'-m','fast','-w']);
  // Cleanup is restricted to this run's UUID directories; never touch local/customer data.
  for(const root of ['.local','.demo-data']){const parent=resolve(root),target=resolve(root,namespace);assert.ok(namespace.startsWith('exportqa-')&&target.startsWith(parent+sep)&&target===join(parent,namespace));await rm(target,{recursive:true,force:true});}
}

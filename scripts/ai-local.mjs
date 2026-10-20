import {readFile,mkdir,access,stat,rename,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {writePrivate} from './keycloak-local.mjs';
export const modelOrigin='http://127.0.0.1:11435';
export const modelName='qwen3:4b';
export const expectedModelDigest='sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7';
export const ollamaExe=join(process.env.LOCALAPPDATA,'IDMS/runtime/ollama-0.40.4/ollama.exe');
async function fileHash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
async function download(url,target){await new Promise((resolve,reject)=>{const p=spawn('curl.exe',['--fail','--location','--continue-at','-','--retry','3','--retry-delay','2','--max-time','1800','--output',target,url],{windowsHide:true,stdio:['ignore','ignore','pipe']});let last='';p.stderr.on('data',b=>{last=(last+b).slice(-1500);});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('Official registry download failed (curl '+code+'); partial file preserved. '+last.replace(/https?:\/\/\S+/g,'[registry URL]'))));});}
async function provisionRegistryModel(){
  const modelRoot=join(process.env.LOCALAPPDATA,'IDMS/models'),cache=join(process.env.LOCALAPPDATA,'IDMS/runtime/model-downloads');await mkdir(cache,{recursive:true});await mkdir(join(modelRoot,'blobs'),{recursive:true});
  const manifestFile=join(cache,'qwen3-4b-manifest.json');
  // Explicit official HTTPS download avoids changing Ollama's SSRF protections when a local proxy uses fake-IP DNS.
  try{await access(manifestFile);}catch{await download('https://registry.ollama.ai/v2/library/qwen3/manifests/4b',manifestFile);}
  const manifestBytes=await readFile(manifestFile),manifest=JSON.parse(manifestBytes.toString('utf8'));
  if('sha256:'+createHash('sha256').update(manifestBytes).digest('hex')!==expectedModelDigest)throw Error('Official model tag differs from the reviewed manifest pin; explicit model upgrade required');
  if(manifest.schemaVersion!==2||!Array.isArray(manifest.layers)||manifest.layers.length>10)throw Error('Invalid official model manifest');
  for(const part of [manifest.config,...manifest.layers].sort((a,b)=>a.size-b.size)){
    if(!/^sha256:[a-f0-9]{64}$/.test(part.digest)||!Number.isInteger(part.size)||part.size<1||part.size>6000000000)throw Error('Invalid model layer descriptor');
    const target=join(modelRoot,'blobs',part.digest.replace(':','-'));let existing=false;
    try{existing=(await stat(target)).size===part.size&&await fileHash(target)===part.digest.slice(7);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(existing)continue;
    const partial=target+'.download';console.log(JSON.stringify({downloadingLayer:part.digest,bytes:part.size,source:'official Ollama registry'}));
    await download('https://registry.ollama.ai/v2/library/qwen3/blobs/'+part.digest,partial);
    if((await stat(partial)).size!==part.size||await fileHash(partial)!==part.digest.slice(7))throw Error('Model layer SHA256/size mismatch; not installed');
    await rename(partial,target);console.log(JSON.stringify({layerVerified:part.digest}));
  }
  const directory=join(modelRoot,'manifests/registry.ollama.ai/library/qwen3');await mkdir(directory,{recursive:true});const dest=join(directory,'4b');
  try{const old=await readFile(dest);if(!old.equals(manifestBytes))throw Error('Existing model manifest differs; explicit upgrade required');}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(dest,manifestBytes,{flag:'wx'});}
  console.log(JSON.stringify({officialManifestDigest:'sha256:'+createHash('sha256').update(manifestBytes).digest('hex'),allLayerHashesVerified:true}));
}
export function launchOllama(){return spawn(ollamaExe,['serve'],{env:{...process.env,OLLAMA_HOST:'127.0.0.1:11435',OLLAMA_MODELS:join(process.env.LOCALAPPDATA,'IDMS/models'),OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_CONTEXT_LENGTH:'8192'},windowsHide:true,stdio:['ignore','pipe','pipe']});}
export async function stopOllama(child){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));if(process.platform==='win32')await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();await done;}
export async function ollamaReady(){try{const r=await fetch(modelOrigin+'/api/version',{redirect:'error',signal:AbortSignal.timeout(1500)});return r.ok&&(await r.json()).version==='0.40.4';}catch{return false;}}
export async function setupAi(){
  const database=JSON.parse(await readFile('.local/postgres-runtime.json','utf8'));
  const tags=await(await fetch(modelOrigin+'/api/tags',{redirect:'error',signal:AbortSignal.timeout(3000)})).json();
  const model=tags.models?.find(m=>m.name===modelName);if(!model?.digest)throw Error('Pinned local model missing; run node scripts/ai-local.mjs --install-model');
  const digest='sha256:'+model.digest.replace(/^sha256:/,'');
  if(digest!==expectedModelDigest)throw Error('Local model manifest differs from the reviewed pin');
  const file=resolve('.local/ai/runtime.json'),clientFile=resolve('.local/ai/client.json');await mkdir('.local/ai',{recursive:true});let prior;
  if(process.platform==='win32')await promisify(execFile)('icacls.exe',[resolve('.local/ai'),'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)(F)`],{windowsHide:true});
  try{prior=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(prior&&prior.model.digest!==digest)throw Error('Installed model changed: explicit review and model-version migration required');
  const tenants=Object.fromEntries(Object.keys(database.tenants).map(id=>[id,{serviceToken:prior?.tenants[id]?.serviceToken||randomBytes(32).toString('base64url')}]));
  const config={modelUrl:modelOrigin,model:{name:modelName,digest},dataDirectory:resolve('.local/ai/receipts'),tenants};
  const client={baseUrl:'http://127.0.0.1:4018',model:config.model,tenants};await writePrivate(file,JSON.stringify(config));await writePrivate(clientFile,JSON.stringify(client));
  return {file,clientFile,config,client};
}
export function launchAi(file,port=4018){return spawn(process.execPath,['services/ai-gateway/index.ts'],{env:{...process.env,IDMS_AI_GATEWAY_CONFIG:file,IDMS_AI_GATEWAY_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});}
export async function aiReady(client){try{for(const [tenantId,account] of Object.entries(client.tenants)){const r=await fetch(client.baseUrl+'/v1/status',{headers:{Authorization:'Bearer '+account.serviceToken,'X-IDMS-Tenant':tenantId},redirect:'error',signal:AbortSignal.timeout(3000)});if(!r.ok)return false;const status=await r.json();if(status.service!=='IDMS_AI_GATEWAY'||!status.modelReady||status.mode!=='SHADOW'||status.model.digest!==client.model.digest)return false;}return true;}catch{return false;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  await access(ollamaExe);if(process.argv.includes('--registry-download'))await provisionRegistryModel();let child;
  if(!await ollamaReady()){child=launchOllama();child.stderr.on('data',b=>process.stderr.write(b));child.stdout.on('data',b=>process.stderr.write(b));for(let i=0;i<100&&!await ollamaReady();i++){if(child.exitCode!==null)throw Error('Local model runtime stopped');await new Promise(r=>setTimeout(r,200));}if(!await ollamaReady())throw Error('Local model runtime not ready');}
  try{
    if(process.argv.includes('--install-model')){
      console.log('Downloading qwen3:4b from the official Ollama registry; no enterprise data is uploaded.');
      const pull=await fetch(modelOrigin+'/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:modelName,stream:true}),signal:AbortSignal.timeout(1800000)});if(!pull.ok)throw Error('Model pull refused');
      let pending='',last=0;
      for await(const chunk of pull.body){pending+=Buffer.from(chunk).toString('utf8');let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;const value=JSON.parse(line);if(value.error)throw Error('Model download failed: '+String(value.error).replace(/https?:\/\/\S+/g,'[registry URL]'));if(Date.now()-last>10000||value.status==='success'){console.log(JSON.stringify({status:value.status,total:value.total,completed:value.completed}));last=Date.now();}}}
    }
    const show=await(await fetch(modelOrigin+'/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:modelName}),signal:AbortSignal.timeout(10000)})).json();
    if(typeof show.license!=='string'||!/Apache License[\s\S]{0,80}Version 2\.0/.test(show.license))throw Error('Expected model license not confirmed; do not enable model');
    const runtime=await setupAi();
    await writePrivate(resolve('.local/ai/model-manifest.json'),JSON.stringify({name:modelName,digest:runtime.config.model.digest,license:'Apache-2.0',licenseText:show.license,licenseDigest:createHash('sha256').update(show.license).digest('hex'),source:'https://ollama.com/library/qwen3:4b',recordedAt:new Date().toISOString(),runtimeVersion:'0.40.4'}));
    console.log(JSON.stringify({installed:true,model:runtime.config.model,license:'Apache-2.0',localOnly:true,cloudEgress:false,credentialsLogged:false}));
  }finally{await stopOllama(child);}
}

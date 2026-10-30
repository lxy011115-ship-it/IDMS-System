import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,stat,symlink,realpath,readdir} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {writePrivate} from './keycloak-local.mjs';
const root=process.cwd(),work=resolve('work/canonical-v2-core-20261019'),source=join(work,'source'),hash=b=>createHash('sha256').update(b).digest('hex'),read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));
await assert.rejects(stat(join(work,'prepared.json')),e=>e.code==='ENOENT');
let partial=false;try{await stat(work);partial=true;assert.deepEqual(await readdir(work),['source']);}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(work,{recursive:false});}
await mkdir(source,{recursive:true});
async function put(target,bytes){try{assert.deepEqual(await readFile(target),bytes,'Partial QA copy differs');}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}}
const manifest=await read('outputs/field-channel-release-revision-2-verification.json');assert.equal(manifest.fileCount,909);
for(const row of manifest.files){const input=join(root,'outputs',manifest.snapshot,row.path),bytes=await readFile(input);assert.equal(hash(bytes),row.sha256);assert.equal(bytes.length,row.bytes);await put(join(source,row.path),bytes);}
const additions=['server/canonical-stream-v2.ts','scripts/canonical-stream-v2-loader.mjs','scripts/fixtures/canonical-v2-runtime-witness.mjs'];const pins=[];
for(const name of additions){const bytes=await readFile(name);await put(join(source,name),bytes);pins.push({path:name,bytes:bytes.length,sha256:hash(bytes)});}
const expected=new Set([...manifest.files.map(r=>r.path),...additions]);async function check(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const n=prefix+e.name;if(e.isDirectory())await check(join(dir,e.name),n+'/');else assert.ok(e.isFile()&&expected.has(n),'Unknown partial QA file');}}await check(source);
await mkdir(join(source,'.local'),{recursive:true});await mkdir(join(source,'outputs'),{recursive:true});await assert.rejects(stat(join(source,'node_modules')),e=>e.code==='ENOENT');await symlink(resolve('node_modules'),join(source,'node_modules'),'junction');assert.equal(await realpath(join(source,'node_modules')),await realpath(resolve('node_modules')));
const privatePins=[];for(const name of ['postgres-runtime.json','keycloak-runtime.json']){const bytes=await readFile(join('.local',name));await writePrivate(join(source,'.local',name),bytes);privatePins.push({name,sha256:hash(bytes)});}
const proof={format:'idms-canonical-v2-core-qa-prepared-v1',preparedAt:new Date().toISOString(),sourceRoot:source,baselineManifest:'outputs/field-channel-release-revision-2-verification.json',baselineManifestSha256:hash(await readFile('outputs/field-channel-release-revision-2-verification.json')),baseFiles:909,additions:pins,privateDependencyPins:privatePins,nodeModulesSharedLocalDependency:true,sourceFiles:912,verifiedPartialCopyContinued:partial,originalBusinessRuntimeAndAuthKeysNotCopied:true,originalRuntimeNotChanged:true,productionAcceptance:false};await writeFile(join(work,'prepared.json'),JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({prepared:true,baseFiles:909,sourceFiles:912,originalRuntimeNotChanged:true}));

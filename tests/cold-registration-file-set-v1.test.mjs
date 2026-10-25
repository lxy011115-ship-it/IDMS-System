import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,link,symlink,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createColdRegistrationFileSetV1,assertColdRegistrationFileSetV1} from '../scripts/cold-registration-file-set-v1.mjs';

const digest=v=>createHash('sha256').update(v).digest('hex');
async function fixture(t){
 const root=resolve('work/cold-registration-file-set-v1-tests',randomUUID()),material=join(root,'materials');await mkdir(material,{recursive:true});
 const secret=randomBytes(32),file=join(material,'credential.private.bin');await writeFile(file,secret,{flag:'wx'});
 const binding={controlId:randomUUID(),sourceHash:digest('source'),sourceInventorySha256:digest('complete-source-inventory'),recoveryId:randomUUID(),intentSha256:digest('original-intent')};
 const config={binding,roots:[root],forbiddenRoots:[join(root,'source-pgdata'),join(root,'target-pgdata')],files:[{id:'auth-key',purpose:'PRIVATE_BINARY',path:file,maximumBytes:64}]},owned=[];
 const create=(c=config)=>{const cap=createColdRegistrationFileSetV1(c);owned.push(cap);return cap;};t.after(async()=>{await Promise.allSettled(owned.map(c=>c.close()));secret.fill(0);});return{root,material,file,secret,binding,config,create};
}

test('real bytes are privately committed without passwords, raw paths, unkeyed digests or runtime permission',async t=>{
 const f=await fixture(t),cap=f.create(),before=await readFile(f.file),first=await cap.capture(),replayed=await cap.revalidate();assert.deepEqual(replayed,first);assert.equal(first.totalBytes,32);assert.equal(first.fileCount,1);assert.deepEqual(await readFile(f.file),before);
 const text=JSON.stringify(first);for(const privateValue of[f.root,f.file,f.secret.toString('hex'),digest(f.secret)])assert(!text.includes(privateValue));
 for(const key of['completeDeploymentMaterialsVerified','currentIdentityVerified','independentApprovalGranted','businessWritesEnabled','formalFieldActivationGranted','fullGoalComplete'])assert.equal(first[key],false);
 assert.deepEqual(assertColdRegistrationFileSetV1(cap,f.binding),first);first.files[0].bytes=1;first.binding.sourceHash=digest('changed');assert.equal((await cap.revalidate()).files[0].bytes,32);assert.equal(assertColdRegistrationFileSetV1(cap,f.binding).binding.sourceHash,f.binding.sourceHash);
});

test('serialized evidence, copied APIs, foreign bindings and new owner keys do not recreate an owner',async t=>{
 const f=await fixture(t),a=f.create(),b=f.create();const one=await a.capture(),two=await b.capture();assert.notEqual(one.materialMac,two.materialMac);assert.throws(()=>assertColdRegistrationFileSetV1(one,f.binding),/FILES_OWNER/);assert.throws(()=>assertColdRegistrationFileSetV1({...a},f.binding),/FILES_OWNER/);assert.throws(()=>assertColdRegistrationFileSetV1(a,{...f.binding,recoveryId:randomUUID()}),/FILES_OWNER/);
});

test('same length credential drift invalidates the original owner without refreshing its evidence',async t=>{
 const f=await fixture(t),cap=f.create(),first=await cap.capture();await writeFile(f.file,randomBytes(32));await assert.rejects(cap.revalidate(),/FILES_DRIFT/);assert.throws(()=>assertColdRegistrationFileSetV1(cap,f.binding),/FILES_CLOSED/);assert.equal(first.files[0].bytes,32);await cap.close();await cap.close();
});

test('replacing a file with equal bytes still invalidates its captured filesystem identity',async t=>{
 const f=await fixture(t),cap=f.create();await cap.capture();const replacement=join(f.material,'replacement.private.bin');await writeFile(replacement,f.secret,{flag:'wx'});await rename(f.file,join(f.material,'old.private.bin'));await rename(replacement,f.file);await assert.rejects(cap.revalidate(),/FILES_DRIFT/);
});

test('actual hard links and direct symbolic links are rejected',async t=>{
 for(const kind of['HARD','SYMBOLIC']){const f=await fixture(t),alias=join(f.material,kind.toLowerCase()+'.private.bin');if(kind==='HARD')await link(f.file,alias);else await symlink(f.file,alias,'file');const c=f.create({...f.config,files:[{...f.config.files[0],path:alias}]});await assert.rejects(c.capture(),/FILES_REGULAR/);}
});

test('a linked parent directory cannot redirect a declared material path',async t=>{
 const f=await fixture(t),alias=join(f.root,'alias');await symlink(f.material,alias,process.platform==='win32'?'junction':'dir');const cap=f.create({...f.config,files:[{...f.config.files[0],path:join(alias,'credential.private.bin')}]});await assert.rejects(cap.capture(),/FILES_PARENT/);
});

test('source and target PGDATA, foreign roots, aliases and duplicate material slots reject before reading',async t=>{
 const f=await fixture(t),item=f.config.files[0];for(const c of[
  {...f.config,files:[{...item,path:join(f.config.forbiddenRoots[0],'key.private.bin')}]},
  {...f.config,files:[{...item,path:join(f.config.forbiddenRoots[1],'key.private.bin')}]},
  {...f.config,files:[{...item,path:resolve(f.root,'..','foreign.private.bin')}]},
  {...f.config,files:[item,{...item,id:'duplicate-path'}]},
  {...f.config,files:[item,{...item,path:join(f.material,'other.private.bin')}]},
  {...f.config,roots:[f.config.forbiddenRoots[0]]},
 ])assert.throws(()=>f.create(c),/FILES_(PATH|DESCRIPTOR|ROOT_OVERLAP)/);
 if(process.platform==='win32')assert.throws(()=>f.create({...f.config,files:[item,{...item,id:'case-alias',path:item.path.toUpperCase()}]}),/FILES_PATH/);
});

test('empty, missing, oversized and nonregular actual files fail without modifying them',async t=>{
 for(const kind of['EMPTY','MISSING','OVERSIZED','DIRECTORY']){const f=await fixture(t),path=join(f.material,'invalid.private.bin');if(kind==='EMPTY')await writeFile(path,'',{flag:'wx'});if(kind==='OVERSIZED')await writeFile(path,randomBytes(65),{flag:'wx'});if(kind==='DIRECTORY')await mkdir(path);const cap=f.create({...f.config,files:[{...f.config.files[0],path}]});await assert.rejects(cap.capture());assert.deepEqual(await readFile(f.file),f.secret);}
});

test('caller callbacks, unbounded sizes and extra authority flags are not accepted',async t=>{
 const f=await fixture(t);for(const extra of[{assertAuthorized:()=>true},{approved:true},{key:randomBytes(32)},{lifetimeMs:600000}])assert.throws(()=>f.create({...f.config,...extra}),/FILES_CONFIG/);
 assert.throws(()=>f.create({...f.config,binding:{...f.binding,approved:true}}),/FILES_BINDING/);
 assert.throws(()=>f.create({...f.config,files:[{...f.config.files[0],maximumBytes:257*1024**2}]}),/FILES_SIZE/);
 assert.throws(()=>f.create({...f.config,files:Array.from({length:257},(_,i)=>({...f.config.files[0],id:'slot-'+i,path:join(f.material,'file-'+i)}))}),/FILES_COUNT/);
});

test('close cancels an actual pending capture and makes serialized historical evidence unusable',async t=>{
 const f=await fixture(t),cap=f.create(),pending=cap.capture();assert.throws(()=>cap.capture(),/FILES_BUSY/);const closed=cap.close();await assert.rejects(pending,/FILES_CLOSED/);await closed;assert.throws(()=>cap.capture(),/FILES_CLOSED/);assert.throws(()=>assertColdRegistrationFileSetV1(cap,f.binding),/FILES_CLOSED/);
});

test('wall clock rollback cannot extend a thirty second file inspection window',async t=>{
 const f=await fixture(t),cap=f.create(),realNow=Date.now;try{Date.now=()=>realNow()-60000;assert.throws(()=>cap.capture(),/FILES_EXPIRED/);}finally{Date.now=realNow;}
});

test('the whole declared mixed file set is observed and a single missing member refuses the set',async t=>{
 const f=await fixture(t),json=join(f.material,'runtime.private.json'),program=join(f.material,'program.jar');await writeFile(json,JSON.stringify({password:randomBytes(32).toString('hex')}),{flag:'wx'});await writeFile(program,randomBytes(131073),{flag:'wx'});
 const files=[...f.config.files,{id:'runtime',purpose:'PRIVATE_JSON',path:json,maximumBytes:1024},{id:'workflow-jar',purpose:'PUBLIC_PROGRAM',path:program,maximumBytes:200000}],cap=f.create({...f.config,files}),proof=await cap.capture();assert.equal(proof.fileCount,3);assert.deepEqual(proof.files.map(f=>f.id),['auth-key','runtime','workflow-jar']);assert.deepEqual(await cap.revalidate(),proof);
 const missing=f.create({...f.config,files:[...files,{id:'missing',purpose:'PRIVATE_BINARY',path:join(f.material,'missing.private.bin'),maximumBytes:32}]});await assert.rejects(missing.capture());assert.throws(()=>assertColdRegistrationFileSetV1(missing,f.binding),/FILES_CLOSED/);
});

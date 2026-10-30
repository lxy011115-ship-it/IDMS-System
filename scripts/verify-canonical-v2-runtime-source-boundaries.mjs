import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink,rm,link,symlink,rmdir,stat} from 'node:fs/promises';
import {resolve,join,dirname,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {verifyCoreRuntimeSource} from './core-managed-entry.mjs';
const work=resolve('work/canonical-v2-core-upgrade-20261019'),proofFile=join(work,'runtime-source-boundary-verification.json');await assert.rejects(stat(proofFile),e=>e.code==='ENOENT');const read=async p=>JSON.parse(await readFile(p,'utf8')),manifest=await read('outputs/core-canonical-v2-source-revision-2-verification.json'),source=resolve('outputs',manifest.snapshot),base=resolve('.local'),owned=join(base,'core-source-negative-'+randomUUID().replaceAll('-','').slice(0,12)),root=join(owned,manifest.snapshot),manifestFile=join(owned,'manifest.json'),sha=b=>createHash('sha256').update(b).digest('hex');assert.ok(owned.startsWith(base+sep));await mkdir(root,{recursive:true});const cases=[];let legacyUndeclared=false,legacyHardlink=false;
const writeManifest=async value=>{const bytes=JSON.stringify(value);await writeFile(manifestFile,bytes);return sha(bytes);};let digest;
async function verify(extra={}){return verifyCoreRuntimeSource({root,manifestFile,expectedManifestSha256:digest,...extra});}
async function refuse(name,run){await assert.rejects(run);cases.push(name);}
try{
 for(const row of manifest.files){const target=join(root,row.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(join(source,row.path)),{flag:'wx'});}digest=await writeManifest(manifest);assert.equal((await verify()).sourceFiles,913);
 const old=await import(pathToFileURL(resolve('outputs/core-canonical-v2-20261019/scripts/core-managed-entry.mjs')).href);
 await refuse('wrong-manifest-sha',()=>verify({expectedManifestSha256:'0'.repeat(64)}));
 for(const [name,change]of [['duplicate-path',x=>x.files[1].path=x.files[0].path],['path-traversal',x=>x.files[1].path='../outside'],['windows-alternate-stream-path',x=>x.files[1].path='public/manual.js:extra']]){const changed=structuredClone(manifest);change(changed);digest=await writeManifest(changed);await refuse(name,()=>verify());}digest=await writeManifest(manifest);
 const selected=join(root,'public/manual.js'),bytes=await readFile(selected),changed=Buffer.from(bytes);changed[0]^=1;await writeFile(selected,changed);await refuse('same-length-code-tamper',()=>verify());await writeFile(selected,bytes);
 const extra=join(root,'public/untracked-private.js');await writeFile(extra,'export default 1;');legacyUndeclared=(await old.verifyCoreRuntimeSource({root,manifestFile,expectedManifestSha256:digest})).sourceFiles===913;await refuse('undeclared-runtime-file',()=>verify());await unlink(extra);
 await mkdir(join(root,'node_modules'));await refuse('undeclared-local-dependency-directory',()=>verify());await rmdir(join(root,'node_modules'));
 const outside=join(owned,'hardlink-target.js');await writeFile(outside,bytes);await unlink(selected);await link(outside,selected);legacyHardlink=(await old.verifyCoreRuntimeSource({root,manifestFile,expectedManifestSha256:digest})).sourceFiles===913;await refuse('declared-file-hardlink',()=>verify());await unlink(selected);await unlink(outside);await writeFile(selected,bytes);
 const parent=join(owned,'linked-parent');await mkdir(parent);const alias=join(parent,manifest.snapshot);await symlink(root,alias,'junction');await refuse('root-junction',()=>verify({root:alias}));await rmdir(alias);assert.equal((await verify()).sourceFiles,913);
}finally{assert.ok(resolve(owned).startsWith(base+sep)&&owned!==base);await rm(owned,{recursive:true});}
const proof={verifiedAt:new Date().toISOString(),caseCount:cases.length,cases,initialVerifierActuallyAcceptedUndeclaredFile:legacyUndeclared,initialVerifierActuallyAcceptedDeclaredHardlink:legacyHardlink,currentRevisionRefusesAllActualCases:true,unmodifiedDeepCopyAcceptedBeforeAndAfter:true,allOwnedFilesAndJunctionRemoved:true,originalFrozenRuntimeFilesUnchanged:true,productionAcceptance:false};await writeFile(proofFile,JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify(proof));

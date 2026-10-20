import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,readFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {fieldCertificateFixture,fieldProfileFixture} from '../scripts/fixtures/field-certificate-fixture.mjs';
import {loadFieldProfile,readFieldMaterial,readBoundedFieldFile} from '../services/field/profile.ts';
import {loadFieldMaterials} from '../services/field/certificates.ts';
const workspace=resolve('work/field-channel-20261017');
async function owned(work:(root:string)=>Promise<void>){await mkdir(workspace,{recursive:true});const root=await mkdtemp(resolve(workspace,'materials-'));try{await work(root);}finally{const rel=relative(workspace,resolve(root));assert.ok(/^materials-[^/\\]+$/.test(rel));await rm(root,{recursive:true,force:true});}}
test('private field profile and pinned material files load with bounded exact bytes and no password trimming',async()=>owned(async root=>{
 const server=await fieldCertificateFixture(),client=await fieldCertificateFixture({applicationUri:'urn:idms:field-qa-client'}),profile=fieldProfileFixture(server,client);await writeFile(resolve(root,'profile.json'),JSON.stringify(profile),{mode:0o600});await writeFile(resolve(root,'server.der'),server.der);await writeFile(resolve(root,'client.der'),client.der);await writeFile(resolve(root,'client-key.pem'),client.privateKey,{mode:0o600});const loaded=await loadFieldProfile(resolve(root,'profile.json')),material=await loadFieldMaterials(root,loaded);assert.deepEqual(material.privateKeyPem,client.privateKey);const account={...profile,userIdentity:{type:'UserName',userName:'qa-read-only',passwordFile:'password.txt'}};await writeFile(resolve(root,'password.txt'),'qa-only-password',{mode:0o600});assert.equal((await loadFieldMaterials(root,account)).password,'qa-only-password');await writeFile(resolve(root,'password.txt'),'qa-only-password\n',{mode:0o600});await assert.rejects(loadFieldMaterials(root,account),(e:any)=>e.code==='FIELD_USER_IDENTITY_INVALID'&&!e.message.includes('qa-only-password'));await writeFile(resolve(root,'client-key.pem'),'changed after snapshot',{mode:0o600});assert.deepEqual(material.privateKeyPem,client.privateKey);await assert.rejects(loadFieldMaterials(root,loaded));
}));
test('bounded field reads reject directories, over-limit files and malformed UTF8 profiles with fixed errors',async()=>owned(async root=>{
 await writeFile(resolve(root,'large.bin'),Buffer.alloc(1025));await assert.rejects(readBoundedFieldFile(resolve(root,'large.bin'),1024),(e:any)=>e.code==='FIELD_MATERIAL_INVALID');await assert.rejects(readBoundedFieldFile(root,1024),(e:any)=>e.code==='FIELD_MATERIAL_INVALID');await writeFile(resolve(root,'profile.json'),Buffer.from([0xff]));await assert.rejects(loadFieldProfile(resolve(root,'profile.json')),(e:any)=>e.code==='FIELD_PROFILE_INVALID');await assert.rejects(readFieldMaterial(root,'../PRIVATE-CONFIG'),(e:any)=>!e.message.includes('PRIVATE'));
}));
test('a private bundle cannot follow a parent junction outside its resolved root',async()=>owned(async parent=>{
 const root=resolve(parent,'bundle'),outside=resolve(parent,'outside');await mkdir(root);await mkdir(outside);await writeFile(resolve(outside,'private.txt'),'owned-qa-only');await symlink(outside,resolve(root,'escape'),process.platform==='win32'?'junction':'dir');await assert.rejects(readFieldMaterial(root,'escape/private.txt'),(e:any)=>e.code==='FIELD_MATERIAL_UNAVAILABLE');assert.equal(await readFile(resolve(outside,'private.txt'),'utf8'),'owned-qa-only');
}));

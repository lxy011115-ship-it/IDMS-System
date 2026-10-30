import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,unlink,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {sealBackup,openBackup,generateKey,readKey,flags,restoreTenantBackup} from '../scripts/backup-support.mjs';

function fixture(){
  const key={keyId:randomUUID(),bytes:randomBytes(32)},dump=Buffer.from('PGDMP-synthetic-format-unit-test-only');
  const manifest={format:1,tenantId:'acme',schemaVersion:2,scope:'TENANT_BUSINESS_DATABASE',recoveryMode:'ISOLATED_BUSINESS_ONLY',facts:[],dumpSha256:createHash('sha256').update(dump).digest('hex')};
  return {key,dump,manifest,archive:sealBackup(manifest,dump,key)};
}
test('encrypted backup authenticates metadata and dump without exposing plaintext',()=>{
  const f=fixture(),opened=openBackup(f.archive,f.key,'acme');
  assert.deepEqual(opened.manifest,f.manifest);assert.deepEqual(opened.dump,f.dump);
  assert.equal(f.archive.includes(Buffer.from('acme')),false);assert.equal(f.archive.includes(Buffer.from('PGDMP')),false);
  assert.notDeepEqual(sealBackup(f.manifest,f.dump,f.key),f.archive,'Every backup must use a fresh nonce');
});
test('wrong key, tenant, tampering and truncation fail authentication or binding',()=>{
  const f=fixture();
  assert.throws(()=>openBackup(f.archive,{...f.key,bytes:randomBytes(32)},'acme'),/authentication/);
  assert.throws(()=>openBackup(f.archive,{...f.key,keyId:randomUUID()},'acme'),/key/);
  assert.throws(()=>openBackup(f.archive,f.key,'sandbox'),/tenant/);
  for(const position of [0,8,24,36,f.archive.length-1]){const changed=Buffer.from(f.archive);changed[position]^=1;assert.throws(()=>openBackup(changed,f.key,'acme'));}
  assert.throws(()=>openBackup(f.archive.subarray(0,-1),f.key,'acme'));
  assert.throws(()=>openBackup(Buffer.concat([f.archive,Buffer.from('extra')]),f.key,'acme'));
  assert.throws(()=>openBackup(sealBackup({...f.manifest,dumpSha256:'0'.repeat(64)},f.dump,f.key),f.key,'acme'),/dump/);
});
test('backup keys are exclusive files and invalid CLI/restore targets are refused',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'idms-backup-unit-')),file=join(directory,'key.json');
  try{
    const generated=await generateKey(file),before=await readFile(file);assert.equal((await readKey(file)).keyId,generated.keyId);
    await assert.rejects(generateKey(file),/EEXIST/);assert.deepEqual(await readFile(file),before);
    assert.throws(()=>flags(['--tenant','acme','--tenant','sandbox'],['--tenant']),/duplicate/);
    assert.throws(()=>flags(['--unknown','x'],['--tenant']),/Invalid/);
    await assert.rejects(restoreTenantBackup({tenantId:'acme',targetDatabase:'idms_acme'}),/isolated/);
  }finally{try{await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}await rmdir(directory);}
});

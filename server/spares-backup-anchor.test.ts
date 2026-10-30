import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {validateSparesBackupAnchor} from '../scripts/spares-backup-anchor.mjs';
import {sealBackup,openBackup} from '../scripts/backup-support.mjs';

const empty={available:true,revision:'0',events:'0',entities:'0',receipts:'0',firstSequence:'0',lastSequence:'0',firstPreviousHash:'GENESIS',firstHash:'GENESIS',lastHash:'GENESIS'};
const populated={...empty,revision:'20001',events:'20001',entities:'10001',receipts:'7',firstSequence:'1',lastSequence:'20001',firstHash:'a'.repeat(64),lastHash:'b'.repeat(64)};
test('spares anchor is strict, bigint-safe and distinguishes absent schema from an empty complete chain',()=>{
 for(const value of [empty,populated,{available:false}])assert.deepEqual(validateSparesBackupAnchor(value),value);
 for(const value of [{},null,{available:false,revision:'0'},{...empty,events:'1'},{...populated,entities:-1},{...populated,revision:'9223372036854775808'},{...populated,lastSequence:'20000'},{...populated,firstSequence:'2'},{...populated,firstHash:'GENESIS'},{...populated,firstPreviousHash:'not-genesis'},{...populated,extra:true}])assert.throws(()=>validateSparesBackupAnchor(value));
});
test('new manifests authenticate mandatory spares anchors while reading old format remains supported',()=>{
 const key={keyId:randomUUID(),bytes:randomBytes(32)},dump=Buffer.from('PGDMP-synthetic-archive-unit-only'),base={tenantId:'acme',schemaVersion:2,scope:'TENANT_BUSINESS_DATABASE',recoveryMode:'ISOLATED_BUSINESS_ONLY',facts:[],dumpSha256:createHash('sha256').update(dump).digest('hex')};
 const legacy=openBackup(sealBackup({...base,format:1},dump,key),key,'acme');assert.equal(legacy.manifest.format,1);assert.equal(legacy.manifest.spares,undefined);
 const current={...base,format:2,backupId:randomUUID(),createdAt:new Date().toISOString(),sourceDatabase:'synthetic_test',pgVersion:'160000',excluded:[],checks:{batches:0,records:0,auditEvents:0,workOrders:0,importsDigest:'a'.repeat(64),businessDigest:'b'.repeat(64)},spares:populated};
 const next=openBackup(sealBackup(current,dump,key),key,'acme');assert.deepEqual(next.manifest.spares,populated);
 for(const spares of [undefined,{...populated,lastHash:'invalid'},false])assert.throws(()=>openBackup(sealBackup({...current,spares},dump,key),key,'acme'),/anchor|manifest/);
 for(const patch of [{checks:undefined},{backupId:'invalid'},{pgVersion:'170000'},{facts:[{table:'x',columns:[],rows:-1,sha256:'a'.repeat(64)}]}])assert.throws(()=>openBackup(sealBackup({...current,...patch},dump,key),key,'acme'),/manifest/);
});

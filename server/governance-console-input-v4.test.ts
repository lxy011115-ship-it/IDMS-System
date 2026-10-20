import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDigest} from './canonical-state.ts';
import {normalizeGovernanceConsoleInputV4} from './governance-console-input-v4.ts';
import {normalizeGovernanceJobInputV4} from './governance-job-input-v4.ts';
test('mapped file provenance follows the original MANUAL_FILE gate and retains the prior canonical request hash',async()=>{const raw={action:'IMPORT_CREATE',input:{file:{filename:'台账.csv',base64:Buffer.from('编号,编码\r\nx,D\r\n').toString('base64')},mappingRef:{templateId:'mapping',version:'1.0.0',contentDigest:'a'.repeat(64)}}},prior=await normalizeGovernanceJobInputV4(raw),next=await normalizeGovernanceConsoleInputV4(raw);assert.equal(prior.input.sourceKind,'CSV');assert.equal(next.command.input.sourceKind,'MANUAL_FILE');assert.equal(next.command.input.originalBase64,prior.input.originalBase64);assert.deepEqual(next.command.input.sourceHeaders,['编号','编码']);assert.equal(next.legacyRequestHash,canonicalDigest(prior));assert.notEqual(canonicalDigest(next.command),next.legacyRequestHash);});

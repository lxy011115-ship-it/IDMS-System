import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {appendAudit} from './audit.ts';
async function checker(){const source=await readFile(new URL('../public/unified-audit-ui-v4.fragment.js',import.meta.url),'utf8'),context=vm.createContext({TextEncoder,digest:async(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),on(){}});new vm.Script(source).runInContext(context);return vm.runInContext('auditEventHash',context) as (event:unknown)=>Promise<void>;}
const event=()=>appendAudit({audits:[]} as any,{tenantId:'sandbox',objectType:'DATA_IMPORT',objectId:'qa',action:'AUDIT_CLIENT_QA',actorType:'SYSTEM',actorId:'qa',correlationId:'qa',metadata:{'10':'十','2':'二',nested:{'20':['😀',1,true,null],'3':'<img src=x onerror=bad()>'}}});
test('actual browser fragment validates original audit canonical ordering including numeric keys and Unicode',async()=>{const verify=await checker();await verify(JSON.parse(JSON.stringify(event())));});
test('actual browser fragment refuses changed nested evidence, fields and missing digest',async()=>{const verify=await checker(),original=event(),changed=structuredClone(original);(changed.metadata.nested as any)['3']='changed';await assert.rejects(()=>verify(changed),/摘要不匹配/);await assert.rejects(()=>verify({...original,correlationId:'another'}),/摘要不匹配/);await assert.rejects(()=>verify({...original,hash:null}),/不完整/);});

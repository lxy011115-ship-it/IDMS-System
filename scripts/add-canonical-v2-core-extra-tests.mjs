import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const work=resolve('work/canonical-v2-core-20261019'),prepared=JSON.parse(await readFile(join(work,'prepared.json'),'utf8')),files=[];
await assert.rejects(stat(join(work,'extra-test-source.json')),e=>e.code==='ENOENT');
for(const name of ['server/legacy-edge-flow.test.ts','services/edge/business-ack-flow.ts']){const target=join(prepared.sourceRoot,name),bytes=await readFile(name);await assert.rejects(stat(target),e=>e.code==='ENOENT');await writeFile(target,bytes,{flag:'wx'});files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
await writeFile(join(work,'extra-test-source.json'),JSON.stringify({preparedAt:new Date().toISOString(),files,onlySupplementalUnitSourcesAdded:true,base909AndV2InputsUnchanged:true},null,2),{flag:'wx'});console.log('Added current nine edge-flow unit cases as two supplemental QA sources; base and running core sources unchanged.');

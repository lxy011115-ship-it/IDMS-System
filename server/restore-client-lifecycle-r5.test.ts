import test from 'node:test';
import assert from 'node:assert/strict';
import {withRestoreClientR5} from '../scripts/restore-client-lifecycle-r5.mjs';

test('restore lifecycle closes its client once after cleanup and before removing credentials',async()=>{
 const steps:string[]=[];const value=await withRestoreClientR5({async end(){steps.push('end');}},async()=>{steps.push('body');return 42;},{cleanup:async()=>{steps.push('cleanup');},afterClose:async()=>{steps.push('credential');}});
 assert.equal(value,42);assert.deepEqual(steps,['body','cleanup','end','credential']);
});
test('original operation failure survives successful disposal and close',async()=>{
 const original=Error('operation');const steps:string[]=[];
 await assert.rejects(withRestoreClientR5({async end(){steps.push('end');}},async()=>{throw original;},{cleanup:async()=>{steps.push('cleanup');},afterClose:async()=>{steps.push('credential');}}),e=>e===original);
 assert.deepEqual(steps,['cleanup','end','credential']);
});
test('cleanup rejection always closes the administrator and retains credentials',async()=>{
 const original=Error('unknown principal');let ends=0,removed=false;
 await assert.rejects(withRestoreClientR5({async end(){ends++;}},async()=>1,{cleanup:async()=>{throw original;},afterClose:async()=>{removed=true;}}),e=>e===original);
 assert.equal(ends,1);assert.equal(removed,false);
});
test('operation cleanup and close failures remain ordered and do not run credential removal',async()=>{
 const errors=[Error('body'),Error('cleanup'),Error('end')];let removed=false;
 await assert.rejects(withRestoreClientR5({async end(){throw errors[2];}},async()=>{throw errors[0];},{cleanup:async()=>{throw errors[1];},afterClose:async()=>{removed=true;}}),e=>e instanceof AggregateError&&e.errors.every((v,i)=>v===errors[i])&&e.errors.length===3);
 assert.equal(removed,false);
});
test('a failed connect inside the operation still receives end and preserves even a falsy thrown value',async()=>{
 let ends=0;const client={async connect(){throw null;},async end(){ends++;}};let caught=false;
 try{await withRestoreClientR5(client,()=>client.connect());}catch(e){caught=true;assert.equal(e,null);}
 assert.equal(caught,true);assert.equal(ends,1);
});
test('credential disposal failure remains visible only after successful cleanup and close',async()=>{
 const failure=Error('unlink denied');let closed=false;
 await assert.rejects(withRestoreClientR5({async end(){closed=true;}},async()=>{}, {afterClose:async()=>{assert.equal(closed,true);throw failure;}}),e=>e===failure);
});

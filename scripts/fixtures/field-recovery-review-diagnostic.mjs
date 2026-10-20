import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {FieldRecoveryControlOperation} from '../field-recovery-control.mjs';
assert.equal(process.env.NODE_ENV,'test');assert.match(process.env.IDMS_DEMO_NAMESPACE||'',/^fieldarchiveqa-[a-f0-9]{10}$/);const args=process.argv.slice(2),action=args[args.indexOf('--action')+1];assert.ok(['submit-review','approve-review','review-status'].includes(action));const original=FieldRecoveryControlOperation.prototype.review;
FieldRecoveryControlOperation.prototype.review=async function(...a){try{return await original.apply(this,a);}catch(e){await writeFile(resolve('work/field-channel-20261017/review-command-error-private.json'),JSON.stringify({name:e.name,code:e.code??null,blockers:e.blockers??null,frames:String(e.stack||'').split('\n').slice(1,14)},null,2),{mode:0o600});throw e;}};await import('../field-recovery.mjs');

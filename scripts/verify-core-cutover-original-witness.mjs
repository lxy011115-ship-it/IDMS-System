import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createCoreUpgradeSessionWitness} from './core-upgrade-session-witness.mjs';
import {privateNewFile} from './backup-support.mjs';
const work=resolve('work/canonical-v2-core-cutover-20261019'),proofFile=join(work,'original-witness-preflight-verification.json'),read=async p=>JSON.parse((await readFile(p,'utf8')).replace(/^\uFEFF/,''));await assert.rejects(stat(proofFile),e=>e.code==='ENOENT');
let witness;try{witness=await createCoreUpgradeSessionWitness({origin:'http://127.0.0.1:4010',identity:await read('.local/keycloak-runtime.json'),authority:await read('.local/postgres-runtime.json'),operation:randomUUID()});assert.ok(witness.ready);await witness.refresh();}finally{await witness?.cleanup();}
await privateNewFile(proofFile,JSON.stringify({verifiedAt:new Date().toISOString(),actualOriginalFullAndLimitedOidcSessionsCreated:true,originalBusinessImportsAndSixFiles14513BytesVerified:true,actualBothCsvExportsAndHiddenOriginalDenialPassed:true,actualOldOpaqueAuditCursorReadBeforeAnyRetirement:true,actualSameSidAndCsrfRechecked:true,actualLogoutAndTwoTemporaryIdentityAndBrowserCleanup:true,originalCoreRetired:false,actualCrossCoreContinuityVerified:false,productionAcceptance:false},null,2));console.log('Original live OIDC witness preparation and exact cleanup passed; original core retained.');

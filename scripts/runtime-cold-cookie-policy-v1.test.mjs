import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runtimeColdCookiePolicyV1 as policy} from './runtime-cold-cookie-policy-v1.mjs';
import {coldRuntimeHashV1 as hash} from './runtime-cold-facts-v1.mjs';
const source={capturedSessionHashes:[hash('prior-session')],capturedLoginHashes:[hash('prior-attempt')]};
test('captured sessions including encoding and duplicates cannot authorize an API',()=>{for(const cookie of['idms_session=prior-session','idms_session=%70rior-session','idms_session=fresh; idms_session=prior-session'])assert.equal(policy('GET','/api/v4/site/context',cookie,source).deny,true);});
test('fresh login discards a captured session while keeping the PKCE cookie channel',()=>{const r=policy('GET','/api/v1/auth/login','idms_session=prior-session; idms_login=new-attempt',source);assert.equal(r.deny,false);assert.equal(r.clearSession,true);assert.equal(r.cookie,'idms_login=new-attempt');});
test('old captured callback is rejected, a newly requested callback and static login page are allowed',()=>{assert.equal(policy('GET','/api/v1/auth/callback?state=prior-attempt','',source).deny,true);const r=policy('GET','/api/v1/auth/callback?state=new-attempt','idms_session=prior-session; idms_login=new-attempt',source);assert.equal(r.deny,false);assert.equal(r.cookie,'idms_login=new-attempt');assert.equal(policy('GET','/','idms_session=prior-session',source).deny,false);assert.equal(policy('GET','/api/v4/site/context','idms_session=new-session',source).deny,false);});

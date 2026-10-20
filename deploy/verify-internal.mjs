import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {verifyDatabaseSecurity,connectionFor,validateRuntimeConfig} from '../server/postgres-security.ts';
import {createRuntimeAuthStore} from '../server/auth-store.ts';
const origin='http://127.0.0.1:4011',issuer='http://127.0.0.1:8084/realms/idms';
const checks=[];
const business=validateRuntimeConfig(JSON.parse(await readFile('.local/postgres-business.json','utf8')));
for(const [tenant,account] of Object.entries(business.tenants)){
 const c=new pg.Client(connectionFor(business,account));await c.connect();
 try{await verifyDatabaseSecurity(c,account,tenant);checks.push(`Tenant ${tenant}: runtime role, schema and immutable audit permissions verified`);}finally{await c.end();}
}
const auth=await createRuntimeAuthStore({mode:'oidc',origin,issuer,clientId:'idms-web',audience:'idms-api'},'postgres-tenant-databases');
try{assert.equal(auth.mode,'POSTGRES_ENCRYPTED');}finally{await auth.close();}checks.push('Independent encrypted shared-session database and key witness verified');
const request=path=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(10000)});
const health=await request('/api/v1/health');assert.equal(health.status,200);
const h=await health.json();assert.equal(h.status,'UP');assert.equal(h.authentication,'oidc');assert.equal(h.storage,'postgres-tenant-databases');assert.match(h.sessionStorage,/postgres/i);checks.push('Live health: PostgreSQL, OIDC and shared sessions enabled');
const session=await request('/api/v1/auth/session');assert.equal(session.status,200);const s=await session.json();assert.equal(s.mode,'oidc');assert.equal(s.authenticated,false);
assert.equal((await request('/api/v1/equipment-profiles')).status,401);checks.push('Anonymous session remains unauthenticated and protected API rejects access');
const index=await request('/');assert.equal(index.status,200);assert.match(await index.text(),/IDMS/);assert.equal((await request('/styles.css')).status,200);checks.push('Website HTML and stylesheet served');
const login=await request('/api/v1/auth/login?returnTo=/');assert.equal(login.status,303);
const location=new URL(login.headers.get('location'));assert.equal(location.origin,'http://127.0.0.1:8084');assert.equal(location.pathname,'/realms/idms/protocol/openid-connect/auth');assert.equal(location.searchParams.get('code_challenge_method'),'S256');assert.equal(location.searchParams.get('redirect_uri'),origin+'/api/v1/auth/callback');assert.match(login.headers.get('set-cookie'),/HttpOnly/);checks.push('Login redirects to the isolated identity service with PKCE S256 and a strict callback');
const discovery=await fetch(issuer+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)});assert.equal(discovery.status,200);assert.equal((await discovery.json()).issuer,issuer);checks.push('Live identity discovery matches the configured issuer');
const report={status:'INTERNAL_PILOT_VERIFIED',verifiedAt:new Date().toISOString(),checks,publicExposure:false,icpStatus:'PENDING',usersProvisioned:0,interactiveLoginTested:false,productionAcceptance:false};
await writeFile('.local/internal-verification.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(report,null,2));

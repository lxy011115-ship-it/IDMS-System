import {readFile,writeFile,access} from 'node:fs/promises';
import {rolePermissions} from '../server/access.ts';
const base='http://127.0.0.1:8084',realm='idms',origin='http://127.0.0.1:4011';
try{await access('.local/identity-ready.json');throw Error('Identity setup already complete; inspect instead of resetting');}catch(e){if(e.code!=='ENOENT')throw e;}
const admin=JSON.parse(await readFile('/srv/idms/private/keycloak-admin.json','utf8'));
const reply=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({client_id:'admin-cli',grant_type:'password',username:admin.username,password:admin.password}),signal:AbortSignal.timeout(10000)});
if(!reply.ok)throw Error('Identity bootstrap login failed');
const {access_token:token}=await reply.json();
async function api(path,method='GET',body){const r=await fetch(base+'/admin/realms/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(`Identity configuration rejected ${method} ${path} ${r.status}`);return r.status===204||r.headers.get('content-length')==='0'?undefined:r.json();}
const realms=await api('');
if(!realms.some(r=>r.realm===realm))await api('','POST',{realm,enabled:true,registrationAllowed:false,resetPasswordAllowed:false,editUsernameAllowed:false,bruteForceProtected:true,accessTokenLifespan:120,sslRequired:'external'});
const profile=await api(realm+'/users/profile');profile.unmanagedAttributePolicy='ADMIN_EDIT';
profile.attributes=(profile.attributes||[]).filter(a=>!['tenant_id','idms_sites','idms_lines','idms_devices'].includes(a.name));
for(const name of ['tenant_id','idms_sites','idms_lines','idms_devices'])profile.attributes.push({name,displayName:name,multivalued:name!=='tenant_id',permissions:{view:['admin'],edit:['admin']}});
await api(realm+'/users/profile','PUT',profile);
const roles=await api(realm+'/roles');for(const name of Object.keys(rolePermissions))if(!roles.some(r=>r.name===name))await api(realm+'/roles','POST',{name});
const clients=await api(realm+'/clients?clientId=idms-web');
const web={clientId:'idms-web',enabled:true,publicClient:true,fullScopeAllowed:false,standardFlowEnabled:true,directAccessGrantsEnabled:false,implicitFlowEnabled:false,serviceAccountsEnabled:false,protocol:'openid-connect',redirectUris:[origin+'/api/v1/auth/callback'],webOrigins:[],attributes:{'pkce.code.challenge.method':'S256','post.logout.redirect.uris':origin+'/'}};
if(!clients.length)await api(realm+'/clients','POST',web);else await api(realm+'/clients/'+clients[0].id,'PUT',{...clients[0],...web});
const id=(await api(realm+'/clients?clientId=idms-web'))[0].id;
await api(`${realm}/clients/${id}/scope-mappings/realm`,'POST',(await api(realm+'/roles')).filter(r=>Object.hasOwn(rolePermissions,r.name)));
const desired=[{name:'idms-tenant',protocol:'openid-connect',protocolMapper:'oidc-usermodel-attribute-mapper',config:{'user.attribute':'tenant_id','claim.name':'tenant_id','jsonType.label':'String','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false',multivalued:'false'}},...['sites','lines','devices'].map(n=>({name:'idms-'+n,protocol:'openid-connect',protocolMapper:'oidc-usermodel-attribute-mapper',config:{'user.attribute':'idms_'+n,'claim.name':'idms_'+n,'jsonType.label':'String','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false',multivalued:'true'}})),{name:'idms-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.custom.audience':'idms-api','access.token.claim':'true','id.token.claim':'false'}}];
const prior=await api(`${realm}/clients/${id}/protocol-mappers/models`);
for(const mapper of desired){const old=prior.find(m=>m.name===mapper.name);await api(`${realm}/clients/${id}/protocol-mappers/models${old?'/'+old.id:''}`,old?'PUT':'POST',old?{...mapper,id:old.id}:mapper);}
// Interactive user credentials will be provisioned with the owner during activation.
await writeFile('.local/identity-ready.json',JSON.stringify({status:'OIDC_REALM_READY',usersProvisioned:0,publicExposure:false,createdAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'OIDC_REALM_READY',client:'idms-web',pkce:'S256',usersProvisioned:0,publicExposure:false}));


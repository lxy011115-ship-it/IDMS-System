import {localConfig,ensureKeycloakProcess} from './keycloak-runtime.mjs';
export {localConfig} from './keycloak-runtime.mjs';
import {ensureSeedAccount} from './keycloak-seed-account.mjs';
import {rolePermissions} from '../server/access.ts';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
const exec = promisify(execFile);
const configFile = resolve('.local/keycloak-runtime.json');
export async function writePrivate(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  if (process.platform === 'win32') await exec('icacls.exe', [path, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], { windowsHide: true });
}
export async function adminToken(config) {
  const response = await fetch(config.origin + '/realms/master/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: config.admin.username, password: config.admin.password }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('Local Keycloak administrator authentication failed; credentials were not logged');
  return (await response.json()).access_token;
}
export async function adminApi(config, token, path, method = 'GET', body) {
  const response = await fetch(config.origin + '/admin/realms/' + path, { method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`Keycloak provisioning failed: ${method} ${path.split('?')[0]} (${response.status}); response omitted to protect account data`);
  return response.status === 204 || response.status === 201 ? undefined : response.json();
}
export async function setupKeycloak() {
  await mkdir('.local', { recursive: true });
  let config;
  try { config = await localConfig(); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    config = { version: '26.8.1', origin: 'http://127.0.0.1:8081', realm: 'idms', admin: { username: 'idms-local-bootstrap', password: randomBytes(32).toString('base64url') }, database: { user: 'idms_identity_app', database: 'idms_identity', password: randomBytes(32).toString('base64url') }, accounts: [] };
    await writePrivate(configFile, JSON.stringify(config));
  }
  if (config.version !== '26.8.1' || config.origin !== 'http://127.0.0.1:8081' || !/^[a-z_]+$/.test(config.database.user) || !/^[a-z_]+$/.test(config.database.database) || !/^[\w-]{32,}$/.test(config.database.password)) throw Error('Invalid local identity runtime configuration');
  const database = JSON.parse(await readFile('.local/postgres-runtime.json', 'utf8'));
  const client = new pg.Client({ host: database.host, port: database.port, database: 'postgres', user: 'idms_bootstrap', password: database.bootstrapPassword });
  await client.connect();
  try {
    const account = config.database;
    if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [account.user])).rowCount) await client.query(`CREATE ROLE "${account.user}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    if (!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [account.database])).rowCount) await client.query(`CREATE DATABASE "${account.database}" OWNER "${account.user}"`);
    await client.query(`REVOKE CONNECT ON DATABASE "${account.database}" FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE "${account.database}" TO "${account.user}"`);
  } finally { await client.end(); }
  await ensureKeycloakProcess(config,database,{bootstrap:true});
  let token = await adminToken(config);
  const realms = await adminApi(config, token, '');
  if (!realms.some(r => r.realm === config.realm)) await adminApi(config, token, '', 'POST', { realm: config.realm, enabled: true, registrationAllowed: false, resetPasswordAllowed: false, editUsernameAllowed: false, loginWithEmailAllowed: false, bruteForceProtected: true, sslRequired: 'external', accessTokenLifespan: 120, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 28800, passwordPolicy: 'length(12) and digits(1) and lowerCase(1) and upperCase(1)', internationalizationEnabled: true, supportedLocales: ['en', 'zh-CN'], defaultLocale: 'zh-CN' });
  const realm = config.realm;
  const profile = await adminApi(config, token, `${realm}/users/profile`);
  profile.unmanagedAttributePolicy = 'ADMIN_EDIT';
  profile.attributes = (profile.attributes || []).filter(a => !['tenant_id','idms_sites','idms_lines','idms_devices'].includes(a.name));
  profile.attributes.push({ name: 'tenant_id', displayName: 'Tenant ID', multivalued: false, permissions: { view: ['admin'], edit: ['admin'] } });
  for (const name of ['idms_sites','idms_lines','idms_devices']) profile.attributes.push({ name, displayName: name+'（管理员分配的数据范围）', multivalued: true, permissions: { view: ['admin'], edit: ['admin'] } });
  await adminApi(config, token, `${realm}/users/profile`, 'PUT', profile);
  for (const name of Object.keys(rolePermissions)) {
    const roles = await adminApi(config, token, `${realm}/roles`);
    if (!roles.some(r => r.name === name)) await adminApi(config, token, `${realm}/roles`, 'POST', { name });
  }
  const clients = await adminApi(config, token, `${realm}/clients?clientId=idms-web`);
  const web = { clientId: 'idms-web', enabled: true, publicClient: true, fullScopeAllowed: false, standardFlowEnabled: true, directAccessGrantsEnabled: false, implicitFlowEnabled: false, serviceAccountsEnabled: false, protocol: 'openid-connect', redirectUris: ['http://127.0.0.1:4010/api/v1/auth/callback'], webOrigins: [], attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': 'http://127.0.0.1:4010/' } };
  if (!clients.length) await adminApi(config, token, `${realm}/clients`, 'POST', web);
  else await adminApi(config, token, `${realm}/clients/${clients[0].id}`, 'PUT', { ...clients[0], ...web });
  const webId = (await adminApi(config, token, `${realm}/clients?clientId=idms-web`))[0].id;
  const platformRoles = (await adminApi(config, token, `${realm}/roles`)).filter(r => Object.hasOwn(rolePermissions,r.name));
  await adminApi(config, token, `${realm}/clients/${webId}/scope-mappings/realm`, 'POST', platformRoles);
  const desiredMappers = [
    { name: 'idms-tenant', protocol: 'openid-connect', protocolMapper: 'oidc-usermodel-attribute-mapper', config: { 'user.attribute': 'tenant_id', 'claim.name': 'tenant_id', 'jsonType.label': 'String', 'access.token.claim': 'true', 'id.token.claim': 'false', 'userinfo.token.claim': 'false', multivalued: 'false' } },
    ...['sites','lines','devices'].map(name => ({ name:'idms-'+name, protocol:'openid-connect', protocolMapper:'oidc-usermodel-attribute-mapper', config:{'user.attribute':'idms_'+name,'claim.name':'idms_'+name,'jsonType.label':'String','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false',multivalued:'true'} })),
    { name: 'idms-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper', config: { 'included.custom.audience': 'idms-api', 'access.token.claim': 'true', 'id.token.claim': 'false' } }
  ];
  const mappers = await adminApi(config, token, `${realm}/clients/${webId}/protocol-mappers/models`);
  for (const mapper of desiredMappers) {
    const prior = mappers.find(m => m.name === mapper.name);
    await adminApi(config, token, `${realm}/clients/${webId}/protocol-mappers/models${prior ? '/' + prior.id : ''}`, prior ? 'PUT' : 'POST', prior ? { ...mapper, id: prior.id } : mapper);
  }
  for (const [username, role, name, tenant] of [['uploader', 'data-uploader', '数据上传专员', 'acme'], ['approver', 'final-approver', '业务终审员', 'acme'], ['technician', 'maintenance-engineer', '维修工程师', 'acme'], ['auditor', 'auditor', '审计员', 'acme'], ['tenantadmin', 'tenant-admin', '企业管理员', 'acme'], ['sandbox.auditor', 'auditor', '沙箱审计员', 'sandbox'], ['sandbox.uploader', 'data-uploader', '沙箱分析员', 'sandbox'], ['sandbox.approver', 'final-approver', '沙箱终审员', 'sandbox'], ['sandbox.technician', 'maintenance-engineer', '沙箱维修工程师', 'sandbox']]) {
    await ensureSeedAccount({api:(path,method='GET',body)=>adminApi(config,token,path,method,body),save:()=>writePrivate(configFile,JSON.stringify(config)),accounts:config.accounts,username,role,name,tenant});
  }
  const guide = ['IDMS 本机开发账户（敏感文件，不得分享或打包）', '网站 http://127.0.0.1:4010/?view=predictive', '首次登录必须设置自己的新密码。下列临时密码在修改后失效；重跑安装不会重置密码。', '企业管理员不能代替业务终审；不同人员使用不同账户。', '', ...config.accounts.map(a => `${a.username} | ${a.role} | 企业 ${a.tenant}\n临时密码：${a.temporaryPassword}\n`)].join('\r\n');
  await writePrivate(resolve('.local/本机登录账户.txt'), guide);
  console.log('Keycloak ' + config.version + ' is ready on loopback :8081 with its own PostgreSQL database. Browser PKCE, trusted tenant claim and realm roles provisioned. Private account file: .local/本机登录账户.txt. This is a development instance, not production acceptance.');
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await setupKeycloak();

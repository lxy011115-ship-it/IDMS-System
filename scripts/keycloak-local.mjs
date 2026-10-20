import {rolePermissions} from '../server/access.ts';
import { readFile, writeFile, mkdir, open, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
const exec = promisify(execFile), runtime = join(process.env.LOCALAPPDATA, 'IDMS/runtime');
const configFile = resolve('.local/keycloak-runtime.json');
export async function writePrivate(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  if (process.platform === 'win32') await exec('icacls.exe', [path, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], { windowsHide: true });
}
export async function localConfig() { return JSON.parse(await readFile(configFile, 'utf8')); }
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
  const kcRoot = join(runtime, 'keycloak-' + config.version), java = join(runtime, 'jdk-21/bin/java.exe');
  await access(java); await access(join(kcRoot, 'lib/quarkus-run.jar'));
  const ready = async () => { try { const r = await fetch(config.origin + '/realms/master/.well-known/openid-configuration', { signal: AbortSignal.timeout(2000) }); return r.ok && (await r.json()).issuer === config.origin + '/realms/master'; } catch { return false; } };
  if (!(await ready())) {
    // Do not start a duplicate on an occupied port. A foreign listener is a real conflict.
    const net = await import('node:net');
    const occupied = await new Promise(resolve => { const socket = net.connect(8081, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (occupied) throw Error('Port 8081 is already occupied but is not a ready local Keycloak instance');
    const args = ['-Xms64m', '-Xmx512m', '-Dfile.encoding=UTF-8', '-Duser.language=en', '-Duser.country=US', '-Djava.util.logging.manager=org.jboss.logmanager.LogManager', '-Djava.util.concurrent.ForkJoinPool.common.threadFactory=io.quarkus.bootstrap.forkjoin.QuarkusForkJoinWorkerThreadFactory', '--add-opens=java.base/java.lang=ALL-UNNAMED', '--add-opens=java.base/java.util=ALL-UNNAMED', `-Dkc.home.dir=${kcRoot}`, `-Djboss.server.config.dir=${join(kcRoot, 'conf')}`, '-cp', join(kcRoot, 'lib/quarkus-run.jar'), 'io.quarkus.bootstrap.runner.QuarkusEntryPoint', 'start-dev'];
    const env = { ...process.env, JAVA_HOME: join(runtime, 'jdk-21'), KC_DB: 'postgres', KC_DB_URL: `jdbc:postgresql://${database.host}:${database.port}/${config.database.database}`, KC_DB_USERNAME: config.database.user, KC_DB_PASSWORD: config.database.password, KC_HTTP_HOST: '127.0.0.1', KC_HTTP_PORT: '8081', KC_HTTP_MANAGEMENT_HOST: '127.0.0.1', KC_HOSTNAME: config.origin, KC_BOOTSTRAP_ADMIN_USERNAME: config.admin.username, KC_BOOTSTRAP_ADMIN_PASSWORD: config.admin.password, KC_LOG_LEVEL: 'info' };
    let failed = false, live;
    async function launch(rebuilt = false) {
      const log = await open('.local/keycloak.log', 'a');
      live = spawn(java, rebuilt ? ['-Dkc.config.built=true', ...args] : args, { cwd: kcRoot, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
      await log.close();
      live.once('error', () => { failed = true; });
      live.once('exit', code => { if (code === 10 && !rebuilt) launch(true).catch(() => { failed = true; }); else failed = true; });
      live.unref();
      await writeFile('.local/keycloak-process.json', JSON.stringify({ pid: live.pid, executable: java, port: 8081 }));
    }
    await launch();
    let online = false;
    for (let i = 0; i < 180; i++) { if (failed) break; if (await ready()) { online = true; break; } await new Promise(r => setTimeout(r, 1000)); }
    if (!online) throw Error('Keycloak did not become ready; inspect the existing process and .local/keycloak.log before retrying (never restart solely on timeout)');
  }
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
    const users = await adminApi(config, token, `${realm}/users?username=${encodeURIComponent(username)}&exact=true`);
    if (!users.length) {
      const temporaryPassword = 'Idms9-' + randomBytes(20).toString('base64url');
      await adminApi(config, token, `${realm}/users`, 'POST', { username, enabled: true, firstName: name, lastName: 'IDMS', email: username + '@idms.invalid', emailVerified: true, attributes: { tenant_id: [tenant] }, credentials: [{ type: 'password', value: temporaryPassword, temporary: true }], requiredActions: ['UPDATE_PASSWORD'] });
      config.accounts.push({ username, role, tenant, temporaryPassword });
      await writePrivate(configFile, JSON.stringify(config));
    }
    // Repair only our own seeded accounts on interrupted setup, without resetting passwords or touching other users.
    const owned = config.accounts.find(a => a.username === username && a.tenant === tenant && a.role === role);
    if (owned) {
      const user = (await adminApi(config, token, `${realm}/users?username=${encodeURIComponent(username)}&exact=true`))[0];
      if (user.attributes?.tenant_id?.[0] !== tenant) throw Error('Seeded account tenant changed; refusing to overwrite');
      const realmRole = await adminApi(config, token, `${realm}/roles/${role}`);
      await adminApi(config, token, `${realm}/users/${user.id}`, 'PUT', {...user,attributes:{...(user.attributes||{}),tenant_id:[tenant],idms_sites:user.attributes?.idms_sites||['*'],idms_lines:user.attributes?.idms_lines||['*'],idms_devices:user.attributes?.idms_devices||['*']}});
      await adminApi(config, token, `${realm}/users/${user.id}/role-mappings/realm`, 'POST', [realmRole]);
    }
  }
  const guide = ['IDMS 本机开发账户（敏感文件，不得分享或打包）', '网站 http://127.0.0.1:4010/?view=predictive', '首次登录必须设置自己的新密码。下列临时密码在修改后失效；重跑安装不会重置密码。', '企业管理员不能代替业务终审；不同人员使用不同账户。', '', ...config.accounts.map(a => `${a.username} | ${a.role} | 企业 ${a.tenant}\n临时密码：${a.temporaryPassword}\n`)].join('\r\n');
  await writePrivate(resolve('.local/本机登录账户.txt'), guide);
  console.log('Keycloak ' + config.version + ' is ready on loopback :8081 with its own PostgreSQL database. Browser PKCE, trusted tenant claim and realm roles provisioned. Private account file: .local/本机登录账户.txt. This is a development instance, not production acceptance.');
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await setupKeycloak();

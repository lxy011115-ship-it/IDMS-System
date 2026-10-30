import {runLocalWorkflowMavenV2,inspectLocalWorkflowExecutableV1} from './local-workflow-maven-v2.mjs';
import { readFile, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writePrivate } from './keycloak-local.mjs';

const exec = promisify(execFile);
export const workflowJar = resolve('services/workflow/target/idms-workflow-0.1.0.jar');
export const workflowJava = join(process.env.LOCALAPPDATA, 'IDMS/runtime/jdk-21/bin/java.exe');
export async function setupWorkflow() {
  const database = JSON.parse(await readFile('.local/postgres-runtime.json', 'utf8'));
  await mkdir('.local/workflow', { recursive: true });
  const file = resolve('.local/workflow/runtime.json'), clientFile = resolve('.local/workflow/client.json');
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; config = { tenants: {} }; }
  for (const tenantId of Object.keys(database.tenants)) {
    const account = database.workflowTenants?.[tenantId];
    if (!account) throw Error('Dedicated workflow database missing; run postgres:setup');
    const serviceToken = config.tenants[tenantId]?.serviceToken || randomBytes(32).toString('base64url');
    config.tenants[tenantId] = { jdbcUrl: `jdbc:postgresql://${database.host}:${database.port}/${account.database}`, user: account.user, password: account.password, serviceToken };
  }
  const client = { baseUrl: 'http://127.0.0.1:4016', tenants: Object.fromEntries(Object.entries(config.tenants).map(([id, c]) => [id, { serviceToken: c.serviceToken }])) };
  await writePrivate(file, JSON.stringify(config));
  await writePrivate(clientFile, JSON.stringify(client));
  return { file, clientFile, config, client };
}
export async function buildWorkflow() {
  await runLocalWorkflowMavenV2();
  await inspectLocalWorkflowExecutableV1(workflowJar);
}

export function launchWorkflow(file, port = 4016, options = {}) {
  return spawn(workflowJava, ['-Xms64m', '-Xmx384m', '-Dfile.encoding=UTF-8', '-jar', workflowJar, '--server.address=127.0.0.1', '--server.port=' + port], { env: { ...process.env, IDMS_WORKFLOW_CONFIG: file }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
export async function workflowReady(client) {
  try {
    for (const [tenantId, account] of Object.entries(client.tenants)) {
      const r = await fetch(client.baseUrl + '/v1/status', { headers: { Authorization: 'Bearer ' + account.serviceToken, 'X-IDMS-Tenant': tenantId }, redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (!r.ok) return false;
      const status = await r.json();
      if (status.engine !== 'Flowable' || status.version !== '7.2.0' || !status.definitionId) return false;
    }
    return true;
  } catch { return false; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = await setupWorkflow();
  await buildWorkflow();
  console.log(JSON.stringify({ built: true, version: '7.2.0', databaseIsolation: 'one per tenant', configFile: config.file, clientFile: config.clientFile, credentialsLogged: false }));
}

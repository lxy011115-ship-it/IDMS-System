import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
assert.equal(process.platform,'win32');assert.equal(process.argv.length,2);
const runtime=join(process.env.LOCALAPPDATA,'IDMS/runtime');
process.argv.push(join(runtime,'pgsql/bin'),join(runtime,'jdk-21'),join(runtime,'apache-maven-3.9.11'),join(runtime,'keycloak-26.8.1'),resolve('work/runtime-cold-source-bundles-20261022/public-source.json'),'02664eb55e17d44a381e6a94f12cd4c2eabdd81993ab41423652e09e06278c50',join(process.env.USERPROFILE,'.m2/repository'));
await import('./verify-runtime-application-suite-v6.mjs');

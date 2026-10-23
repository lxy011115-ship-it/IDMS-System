import {fork} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {canonical} from '../../server/imports.ts';
import {privateNewFile} from '../backup-support.mjs';
import {applicationHashV1 as hash} from '../runtime-application-config-v1.mjs';
import {createApplicationRegistryV1,appendApplicationRegistryV1} from '../runtime-application-registry-v1.mjs';
import {observeOwnedForkTerminalV1} from '../owned-fork-terminal-v1.mjs';

assert(process.argv.length===3&&process.connected);const file=resolve(process.argv[2]),base=dirname(file),binding={controlId:randomUUID(),sourceHash:'1'.repeat(64),authorityHash:'2'.repeat(64)},tenantIds=['acme'],components=['GOVERNANCE','MAINTENANCE','PREDICTIVE','RECONCILIATION','SITE'].map(kind=>({id:kind.toLowerCase(),kind,tenantId:kind==='SITE'?null:'acme',runtimeFile:join(base,kind+'.private.json')}));
const manifest={format:1,purpose:'RUNTIME_APPLICATION_SUITE_V1',registryDirectory:join(base,'application-generation-a'),trustFile:join(base,'trust.json'),authorityRuntimeFile:join(base,'authority.json'),binding,tenantIds,components};await privateNewFile(file,canonical(manifest));
const trust=await createApplicationRegistryV1(manifest.registryDirectory,manifest,[{path:file,sha256:hash(canonical(manifest))}]),component=components[0],bytes=Buffer.from('{invalid-runtime-json');await privateNewFile(component.runtimeFile,bytes);const challenge=randomBytes(32).toString('hex'),resultFile=join(manifest.registryDirectory,component.id+'-result.private.json'),envelopeFile=join(manifest.registryDirectory,component.id+'-launch.private.json'),envelope={format:'RUNTIME_APPLICATION_CHILD_V1',ownerId:trust.ownerId,parentPid:process.pid,component,runtimeFile:component.runtimeFile,configSha256:hash(bytes),manifestSha256:hash(canonical(manifest)),challenge,binding,expectedTenantIds:['acme'],pins:[{path:component.runtimeFile,sha256:hash(bytes)}],resultFile};await privateNewFile(envelopeFile,canonical(envelope));
await appendApplicationRegistryV1(trust,'LAUNCH_INTENT',{componentId:component.id,kind:component.kind,configSha256:envelope.configSha256});
const child=fork(resolve('scripts/runtime-application-child-v2.mjs'),[envelopeFile],{execArgv:[],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']}),terminal=observeOwnedForkTerminalV1(child);child.stdout.resume();child.stderr.resume();const exit=await terminal;assert.deepEqual(exit,{code:1,signal:null});await appendApplicationRegistryV1(trust,'EXIT',{componentId:component.id,pid:child.pid,...exit});await appendApplicationRegistryV1(trust,'GROUP_STOPPING',{requestId:randomUUID()});await appendApplicationRegistryV1(trust,'FAILED',{errorCode:'APPLICATION_CHILD_EXIT_BEFORE_READY'});
process.send({event:'EXPECTED_STARTUP_FAILURE',childPid:child.pid,childActualExit:exit,resultFile,envelopeFile});process.disconnect();process.exitCode=1;

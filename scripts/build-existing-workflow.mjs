// Explicit build command, never imported by the ordinary startup graph.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runLocalWorkflowMavenV2,inspectLocalWorkflowExecutableV1} from './local-workflow-maven-v2.mjs';
import {filePin,workflowSourceDigest,sha} from './existing-platform-binding.mjs';
import {privateDirectory} from './backup-support.mjs';
const before=await workflowSourceDigest();
await runLocalWorkflowMavenV2({offline:true});
await inspectLocalWorkflowExecutableV1('services/workflow/target/idms-workflow-0.1.0.jar');
if(before!==await workflowSourceDigest())throw Error('WORKFLOW_SOURCE_CHANGED_DURING_BUILD');
const jar=await filePin('services/workflow/target/idms-workflow-0.1.0.jar');
await privateDirectory(resolve('.local/workflow'));
await writeFile('.local/workflow/runtime-build.json',JSON.stringify({format:1,contract:'IDMS_EXISTING_WORKFLOW_V1',sourceDigest:before,jarSha256:jar.sha256,builtAt:new Date().toISOString()})+'\n',{mode:0o600});
console.log(JSON.stringify({built:true,contract:'IDMS_EXISTING_WORKFLOW_V1',jarSha256:jar.sha256,sourceDigest:before,databaseConnections:0}));

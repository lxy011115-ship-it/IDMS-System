import {inspectCiSourcePolicyV2} from './ci-source-policy-v2.mjs';

if(process.argv.length!==2)throw Error('CI_SOURCE_PREFLIGHT_NO_ARGUMENTS');
// This digest binds the initial offline preflight; workflow integration will bind new CI bytes explicitly.
const result=await inspectCiSourcePolicyV2('36d63806dd1f7f374631545fba9431e1342d48aeb307ff40c88fb727ae6eeb94');
console.log(JSON.stringify({sourcePolicyVerified:true,parentCommit:result.parentCommit,policySha256:result.policySha256,parentSourceBlobs:result.parentSourceBlobs,nonCiParentFilesUnchanged:result.nonCiParentFilesUnchanged,ciFilesBound:result.ciFilesBound,ciFilesChangedSinceParent:result.ciFilesChangedSinceParent,profiles:result.profiles,runtimeChanges:result.runtimeChanges,historicalSnapshotsRewritten:result.historicalSnapshotsRewritten,servicesStarted:result.servicesStarted,databasesContacted:result.databasesContacted,nativeLifecycleExecuted:false,fullGoalComplete:false}));

import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectRuntime,collectExistingInputs,bindingFile,StartupError,need} from './existing-platform-binding.mjs';
import {privateNewFile} from './backup-support.mjs';

export async function adoptMain(args){
 const flags={};for(let i=0;i<args.length;i++){const flag=args[i];need(['--runtime-root','--readiness','--write'].includes(flag)&&!Object.hasOwn(flags,flag),'ARGUMENT_INVALID');flags[flag]=flag==='--write'?true:args[++i];need(flags[flag],'ARGUMENT_INVALID');}
 need(flags['--readiness'],'READINESS_SELECTION_REQUIRED');
 const candidates=flags['--runtime-root']?[resolve(flags['--runtime-root'])]:[join(process.env.LOCALAPPDATA,'IDMS/runtime'),join(process.env.LOCALAPPDATA,'Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/IDMS/runtime')];
 const chosen=await selectRuntime(candidates),binding=await collectExistingInputs({runtimeRoot:chosen.runtime,readinessFile:resolve(flags['--readiness'])});
 if(flags['--write'])await privateNewFile(bindingFile,JSON.stringify(binding,null,2)+'\n');
 return {status:flags['--write']?'EXISTING_PLATFORM_REGISTERED':'READ_ONLY_PROPOSAL',verifiedInputs:Object.keys(binding.files).length,existingDatabase:true,provisioning:false,credentialChanges:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)try{console.log(JSON.stringify(await adoptMain(process.argv.slice(2))));}catch(error){console.error(JSON.stringify({status:'REGISTRATION_REFUSED',code:error instanceof StartupError?error.code:'INPUT_OR_REGISTRATION_FAILED',servicesStarted:0}));process.exitCode=1;}

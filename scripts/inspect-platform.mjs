import {lstat,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
import {InspectionError,privateJson,validateProfile,sourceMetadata,checkedPath} from './runtime-inspection-input.mjs';
import {inspectionTasks} from './runtime-inspection-tasks.mjs';
import {runInspection,reportText,safeFailure} from './runtime-inspection-report.mjs';

export function argumentsFor(args){const o={};for(let i=0;i<args.length;i++){const k=args[i];if(!['--profile','--output','--verify-backups','--json','--help'].includes(k)||Object.hasOwn(o,k))throw new InspectionError('CONFIG_INVALID');if(['--profile','--output'].includes(k)){if(!args[i+1]||args[i+1].startsWith('--'))throw new InspectionError('CONFIG_INVALID');o[k]=args[++i];}else o[k]=true;}if(o['--help']&&args.length!==1)throw new InspectionError('CONFIG_INVALID');return o;}
export async function inspectMain(args,{root=resolve(import.meta.dirname,'..'),stdout=s=>process.stdout.write(s),signal}={}){
 const options=argumentsFor(args);if(options['--help']){stdout('用法：npm run platform:inspect -- [--profile 配置文件] [--verify-backups] [--json] [--output 新报告目录]\n默认读取.local/runtime-inspection.json，否则使用infra/runtime-inspection.example.json。\n所有配置相对路径基于项目根目录；仅发GET、最小只读SQL和本机TCP连接，不恢复或重启。\n');return 0;}
 const output=options['--output']?resolve(root,options['--output']):join(root,'.local/inspection-reports',randomUUID());
 try{await lstat(output);throw new InspectionError('REPORT_TARGET_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 const parent=dirname(output);for(let p=parent;;p=dirname(p)){try{if((await lstat(p)).isSymbolicLink())throw new InspectionError('LINKED_INPUT_REFUSED');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===dirname(p))break;}
 let profilePath=options['--profile']?resolve(root,options['--profile']):join(root,'.local/runtime-inspection.json');if(!options['--profile'])try{await lstat(profilePath);}catch(e){if(e.code!=='ENOENT')throw e;profilePath=join(root,'infra/runtime-inspection.example.json');}
 const {value,sha256}=await privateJson(profilePath),profile=validateProfile(value),metadata=await sourceMetadata(root),pkg=(await privateJson(join(root,'package.json'))).value;
 if(typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new InspectionError('CONFIG_INVALID');
 const report=await runInspection(inspectionTasks(root,profile,{verifyBackups:!!options['--verify-backups'],version:pkg.version}),profile,{signal,source:metadata,configurationSha256:sha256});
 // Reject existing targets and linked parents. Only this newly owned report
 // directory receives private ACLs; inspected config and services are untouched.
 try{await lstat(output);throw new InspectionError('REPORT_TARGET_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 await mkdir(parent,{recursive:true});await checkedPath(parent);await mkdir(output,{mode:0o700});await privateDirectory(output);
 await privateNewFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await privateNewFile(join(output,'report.txt'),reportText(report));
 stdout(options['--json']?JSON.stringify(report,null,2)+'\n':reportText(report)+'报告已保存为所选新目录中的report.json和report.txt。\n');return report.overall==='PASS'?0:report.overall==='FAIL'?1:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
 try{process.exitCode=await inspectMain(process.argv.slice(2),{signal:controller.signal});}catch(e){const failure=safeFailure(e);process.stderr.write('巡检未完成：['+failure.code+'] '+decorateFailure(failure.code)+'\n底层错误和私密路径已省略；请核对公开使用指南。\n');process.exitCode=3;}finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}

function decorateFailure(code){return code==='REPORT_TARGET_EXISTS'?'报告目录已存在，请选择新目录。':code==='LINKED_INPUT_REFUSED'?'输入或报告路径含链接，请使用已核对实际路径。':'参数、配置、输入边界或报告目录未通过核对。';}

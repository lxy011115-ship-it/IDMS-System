import {createWriteStream} from 'node:fs';
import {mkdir,writeFile,readFile,mkdtemp,readdir,lstat,realpath,rm,unlink,rename} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import archiver from 'archiver';
import {collectPackageFiles} from './package-policy.mjs';
import {knownLocalSecrets,snapshotPackageFile,hashPackageFile} from './package-guard.mjs';
import {verifyDemoPackage} from './package-verify.mjs';
import {buildDemoFixtures} from './build-demo-fixtures.mjs';

const root=resolve('.'),args=process.argv.slice(2);if(args.some(a=>a!=='--plan')||args.length>1)throw Error('Package command accepts only --plan');
const plan=await collectPackageFiles(root);for(const required of ['server/index.ts','public/index.html','public/manual.js','scripts/start-demo.ps1','scripts/demo-runtime.mjs','package.json','package-lock.json'])if(!plan.files.some(f=>f.name===required))throw Error('Required package source missing: '+required);
if(args.includes('--plan')){console.log(JSON.stringify({sourceAndRuntimeFiles:plan.files.length,expandedBytes:plan.bytes,runtimePackages:plan.packages.length,excluded:plan.excluded,credentialsScanned:false,archiveCreated:false}));process.exit(0);}
const work=join(root,'work'),output=join(root,'outputs');await mkdir(work,{recursive:true});await mkdir(output,{recursive:true});const stage=await mkdtemp(join(work,'package-demo-')),snapshot=join(stage,'snapshot'),generated=join(stage,'generated'),id=randomUUID(),label=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-',''),target=join(output,'IDMS本地演示候选_'+label+'_'+id.slice(0,8)+'.zip'),partial=target+'.partial-'+id;let published=false;
try{
 const secrets=await knownLocalSecrets(root),files=[];console.log('Snapshotting and scanning '+plan.files.length+' source/runtime files.');
 for(const entry of plan.files){files.push(await snapshotPackageFile(entry,snapshot,secrets));if(files.length%2000===0)console.log('Scanned snapshot files: '+files.length);}
 await buildDemoFixtures(join(generated,'outputs/demo-data'));
 for(const name of (await readdir(join(generated,'outputs/demo-data'))).sort()){if(!/^[a-z][a-z0-9_-]*\.(?:csv|xlsx)$/.test(name))throw Error('Unexpected generated sample');const path=join(generated,'outputs/demo-data',name),s=await lstat(path);files.push(await snapshotPackageFile({name:'outputs/demo-data/'+name,path,bytes:s.size,mtimeMs:s.mtimeMs,ino:s.ino,mode:0o644},snapshot,secrets));}
 const guide=`# IDMS 本地文件演示候选包

本包用于离线手动上传演示，不是正式生产部署包，也不是现有企业库、身份服务或完整现场平台的备份。

安装Node.js 24后，运行“启动演示.cmd”，或执行 node scripts/demo-runtime.mjs。默认只监听127.0.0.1:4010；如端口已被现有系统占用，使用 --port 4030。脚本不停止或覆盖现有服务。

演示使用单独的packaged-demo文件命名空间和模拟身份，不连接现有OIDC、PostgreSQL、设备、工作流或AI服务。保留NODE_ENV生产门禁；不要用于公网访问或真实企业资料。

运行依赖按package-lock.json纳入，未附带Playwright、TypeScript等开发工具；修改/运行开发检查前需在独立副本中npm ci。outputs/demo-data的CSV/XLSX由本包模板重新生成，production-error.csv是故意无效的教学样本。

不附带.local、密码、令牌、数据库、备份、历史截图或构建目录。仓库文档引用的本机历史图片和视频不属于本包。完整企业平台需要独立提供运行时、企业数据库、身份及审批配置。

package-manifest.json列出每个文件的SHA-256与依赖锁版本。执行 node scripts/package-check.mjs 本包.zip 可核验文件完整性；这不是外部签名、企业验收或正式Git发布版本。
`;
 const guidePath=join(generated,'PACKAGED-DEMO.md');await writeFile(guidePath,guide);const gs=await lstat(guidePath);files.push(await snapshotPackageFile({name:'PACKAGED-DEMO.md',path:guidePath,bytes:gs.size,mtimeMs:gs.mtimeMs,ino:gs.ino,mode:0o644},snapshot,secrets));
 const pkg=JSON.parse(await readFile(join(snapshot,'package.json'),'utf8')),manifest={format:1,purpose:'OFFLINE_MANUAL_DEMO',status:'CANDIDATE_NOT_PRODUCTION_RELEASE',buildId:id,builtAt:new Date().toISOString(),sourcePackageVersion:pkg.version,requiresNode:'>=24',runtimePackages:plan.packages,excluded:plan.excluded,scan:{configuredCredentialsCompared:true,privateKeyMaterialPattern:true,credentialLiteralHeuristic:true,comprehensiveSecurityCertification:false},files:files.map(({path,...entry})=>entry)};
 console.log('Snapshot complete; building bounded offline demo archive.');
 const outputStream=createWriteStream(partial,{flags:'wx'}),archive=archiver('zip',{zlib:{level:6}}),complete=new Promise((resolve,reject)=>{outputStream.once('close',resolve);outputStream.once('error',reject);archive.once('error',reject);archive.once('warning',reject);});archive.pipe(outputStream);
 try{for(const file of files)archive.file(file.path,{name:file.name,mode:file.mode,date:new Date('2000-01-01T00:00:00Z')});archive.append(JSON.stringify(manifest,null,2),{name:'package-manifest.json',mode:0o644,date:new Date('2000-01-01T00:00:00Z')});await archive.finalize();await complete;}catch(error){archive.abort();outputStream.destroy();throw error;}
 console.log('Archive written; verifying every file against the manifest.');
 const verified=await verifyDemoPackage(partial);try{await lstat(target);throw Error('Candidate filename already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 await rename(partial,target);published=true;const digest=await hashPackageFile(target),result={file:target,...digest,files:verified.files,expandedBytes:verified.expandedBytes,runtimePackages:plan.packages.length,manifestVerified:true,purpose:manifest.purpose,productionRelease:false};await writeFile(target.replace(/\.zip$/,'.manifest.json'),JSON.stringify({result,manifest},null,2),{flag:'wx'});console.log(JSON.stringify(result));
}catch(error){if(published)await unlink(target).catch(()=>{});throw error;}finally{
 await unlink(partial).catch(error=>{if(error.code!=='ENOENT')throw error;});const parent=await realpath(work),path=await realpath(stage),rel=relative(parent,path);if(!rel.startsWith('package-demo-')||rel.includes('/')||rel.includes('\\')||isAbsolute(rel)||(await lstat(stage)).isSymbolicLink())throw Error('Unsafe package staging cleanup target');await rm(path,{recursive:true,force:true});
}

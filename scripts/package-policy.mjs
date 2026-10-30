import {readdir,lstat,readFile} from 'node:fs/promises';
import {resolve,join,posix,relative,isAbsolute} from 'node:path';

export const packageSourceRoots=['server','services','public','src','scripts','docs','integrations','infra','tests'];
export const packageRootFiles=['package.json','package-lock.json','README.md','openapi.yaml','docker-compose.yml','.env.example','.gitignore','.dockerignore','tsconfig.json','vite.config.ts','index.html','启动演示.cmd','启动IDMS.cmd','启动IDMS本地网站.cmd'];
const privateDirs=new Set(['.local','.git','.hg','.svn','work','outputs','.demo-data','.npm-cache','.cache','历史工作目录','迁移记录','__pycache__','.pytest_cache','test-results','playwright-report','coverage']);
const buildDirs=new Set(['target','dist','server-dist','build','.idea','.vscode']);
const dependencyExtras=new Set(['node_modules','.bin','test','tests','test_helpers','test_helpers_end_to_end','example','examples','benchmark','benchmarks','.github']);
const sourceExtensions=/\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|md|ya?ml|css|html|csv|xml|java|ps1|cmd|bat|py|sh|toml|sql|conf|properties|txt|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot)$/i;
export function safePackageName(name){
 if(typeof name!=='string'||!name||name.includes('\\')||/[\u0000-\u001f\u007f:*?<>|"]/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))||posix.normalize(name)!==name)throw Error('Unsafe package entry name');return name;
}
export function packageExclusion(name,{dependency=false,directory=false}={}){
 safePackageName(name);const parts=name.split('/'),base=parts.at(-1),lower=base.toLowerCase();
 if(parts.some(p=>privateDirs.has(p)))return 'private-runtime-or-generated-output';
 if(lower==='.env'||lower.startsWith('.env.')&&name!=='.env.example')return 'private-environment';
 if(/\.(?:key|p12|pfx|jks|keystore|idmsbackup|dump|sqlite|sqlite3|db|db-wal|db-shm|zip|tar|tgz|gz|7z|rar|log)(?:\..*)?$/i.test(base))return 'private-key-database-archive-or-log';
 if(/^(?:service-token|本机登录账户\.txt|postgres-(?:business|backup|migration|runtime)\.json|keycloak-runtime\.json|(?:credentials|secrets|passwords|accounts)\.(?:json|txt|ya?ml))$/i.test(base))return 'private-configuration';
 if(!dependency&&parts.some(p=>buildDirs.has(p)||p==='node_modules'))return 'build-artifact';
 if(dependency&&parts.some(p=>dependencyExtras.has(p)))return 'dependency-test-or-tooling';
 if(!directory&&!dependency&&!packageRootFiles.includes(name)&&!sourceExtensions.test(base))return 'unreviewed-source-asset';return null;
}
const within=(root,path)=>{const r=relative(root,path);if(r==='..'||r.startsWith('..\\')||r.startsWith('../')||isAbsolute(r))throw Error('Package source escaped its workspace');};
export async function collectPackageFiles(root,{dependencies=true,roots=packageSourceRoots,rootFiles=packageRootFiles}={}){
 root=resolve(root);const files=[],excluded={},packages=[],seen=new Set();const omit=reason=>excluded[reason]=(excluded[reason]||0)+1;
 async function walk(name,{dependency=false,packageRoot=name}={}){
  safePackageName(name);const path=join(root,...name.split('/'));within(root,path);let stat;try{stat=await lstat(path);}catch(error){if(error.code==='ENOENT'){omit('missing-optional-path');return;}throw error;}
  const policyName=dependency?name.slice(packageRoot.length+1):name;if(policyName){const reason=packageExclusion(policyName,{dependency,directory:stat.isDirectory()});if(reason){omit(reason);return;}}
  if(stat.isSymbolicLink())throw Error('Linked package input requires review: '+name);if(!dependency&&stat.isFile()&&stat.nlink>1)throw Error('Hard-linked source input requires review: '+name);
  if(stat.isDirectory()){for(const entry of (await readdir(path)).sort())await walk(name+'/'+entry,{dependency,packageRoot});return;}
  if(!stat.isFile())throw Error('Non-regular package input: '+name);if(stat.size>64*1024*1024)throw Error('Individual package input exceeds the review budget: '+name);const folded=name.toLowerCase();if(seen.has(folded))throw Error('Duplicate package input name');seen.add(folded);files.push({name,path,bytes:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino,mode:stat.mode&0o777});
 }
 for(const dir of roots)await walk(dir);for(const file of rootFiles)await walk(file);
 if(dependencies){
  const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));if(lock.lockfileVersion!==3||!lock.packages)throw Error('A version 3 package lock is required');
  for(const [path,entry]of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b))){
   if(!path.startsWith('node_modules/')||entry.dev===true)continue;safePackageName(path);if(entry.link)throw Error('Linked runtime dependency requires review');
   let actual;try{const dir=await lstat(join(root,path));if(dir.isSymbolicLink())throw Error('Linked runtime dependency requires review');actual=JSON.parse(await readFile(join(root,path,'package.json'),'utf8'));}catch(error){if(error.code==='ENOENT'&&entry.optional){omit('uninstalled-optional-runtime-dependency');continue;}throw error;}
   if(actual.version!==entry.version)throw Error('Installed runtime dependency differs from the package lock: '+path);packages.push({path,version:entry.version,integrity:entry.integrity||null});await walk(path,{dependency:true,packageRoot:path});
  }
 }
 files.sort((a,b)=>a.name.localeCompare(b.name));const bytes=files.reduce((n,f)=>n+f.bytes,0);if(files.length>50000||bytes>512*1024*1024)throw Error('Package input exceeds the bounded review budget');return {files,bytes,excluded,packages};
}

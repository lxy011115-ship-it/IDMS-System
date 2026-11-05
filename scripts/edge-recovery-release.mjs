import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),need=(v,code)=>{if(!v)throw Error(code);},repository='https://github.com/lxy011115-ship-it/IDMS-System',branch='release/prelaunch-20261030',base='https://api.github.com/repos/lxy011115-ship-it/IDMS-System';
export async function recoveryLocalRelease(){
 const git=async(...args)=>(await exec('git',args,{windowsHide:true,maxBuffer:65536,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}})).stdout.trim();
 need(process.version==='v24.20.0','RECOVERY_NODE_VERSION_UNQUALIFIED');need(await git('config','--get','remote.origin.url')===repository+'.git'&&await git('branch','--show-current')===branch,'RECOVERY_RELEASE_REPOSITORY_MISMATCH');need(!await git('status','--porcelain'),'RECOVERY_RELEASE_DIRTY');
 const head=await git('rev-parse','HEAD'),tree=await git('rev-parse','HEAD^{tree}');need(/^[a-f0-9]{40}$/.test(head)&&/^[a-f0-9]{40}$/.test(tree),'RECOVERY_RELEASE_INVALID');
 return {head,tree,branch,manifestSha256:createHash('sha256').update(await readFile('source-release-manifest.json')).digest('hex')};
}
async function remote(path){for(let attempt=0;attempt<3;attempt++){try{const r=await fetch(base+path,{redirect:'error',headers:{Accept:'application/vnd.github+json','User-Agent':'IDMS-explicit-edge-recovery','Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});need(r.ok,'RECOVERY_RELEASE_REMOTE_REFUSED');return await r.json();}catch(error){if(error.message==='RECOVERY_RELEASE_REMOTE_REFUSED'||attempt===2)throw Error('RECOVERY_RELEASE_REMOTE_UNCONFIRMED');await new Promise(ok=>setTimeout(ok,250));}}}
export function validateRecoveryCi(run,head){
 need(run&&run.head_sha===head&&run.head_branch===branch&&run.name==='Linux source verification'&&run.path==='.github/workflows/linux-verification.yml'&&run.status==='completed'&&run.conclusion==='success'&&Number.isSafeInteger(run.id)&&run.id>0&&run.html_url===repository+'/actions/runs/'+run.id,'RECOVERY_SAME_COMMIT_CI_REQUIRED');return {ciRunId:run.id,ciUrl:run.html_url};
}
/** Read-only release gate. CI checks source, not production activation. */
export async function recoveryRelease(expected){
 const local=await recoveryLocalRelease();if(expected)for(const key of ['head','tree','branch','manifestSha256'])need(local[key]===expected[key],'RECOVERY_QUALIFIED_RELEASE_CHANGED');
 const ref=await remote('/git/ref/heads/'+branch);need(ref.ref==='refs/heads/'+branch&&ref.object?.sha===local.head&&ref.object.type==='commit','RECOVERY_RELEASE_NOT_PUBLISHED');
 let run;if(expected){need(Number.isSafeInteger(expected.ciRunId)&&expected.ciRunId>0,'RECOVERY_CI_ID_INVALID');run=await remote('/actions/runs/'+expected.ciRunId);}else{const list=await remote('/actions/runs?head_sha='+local.head+'&per_page=10');need(Array.isArray(list.workflow_runs),'RECOVERY_CI_LIST_INVALID');run=list.workflow_runs.find(r=>r.head_sha===local.head&&r.name==='Linux source verification'&&r.status==='completed'&&r.conclusion==='success');}
 return {...local,...validateRecoveryCi(run,local.head)};
}

import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const need=(value,code)=>{if(!value)throw Error(code);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const safePath=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');
const parentCommit='2772e939e8cecfcccb773c818402d898e5716c9c';
const parentFile='docs/validation/ci-source-parent-v2.json';
const parentSha256='961e4f3a5c30fe07795d724fe20aff44d1635b2e20f95817c3fe5d5ac28f0190';
const policyFile='docs/validation/ci-source-policy-v2.json';
export const ciSourceFilesV2=Object.freeze([
  '.github/workflows/application-lifecycle-verification.yml',
  '.github/workflows/application-registry-checkpoint-verification.yml',
  '.github/workflows/platform-core-lifecycle-verification.yml',
  '.github/workflows/platform-predictor-lifecycle-verification.yml',
  '.github/workflows/postgres-lifecycle-verification.yml',
  '.github/workflows/predictor-lifecycle-verification.yml'
]);
const snapshots=Object.freeze([
  {name:'platform',path:'docs/validation/platform-predictor-parent-v1.json',count:707,sha256:'94dfa54903cb12dfae4fa983935ed7406448d78927fb2c4a23cd8c0612f2fe90'},
  {name:'predictor',path:'docs/validation/predictor-lifecycle-source-baseline-v1.json',count:695,sha256:'cd9ae7d2a3451c6415259402a7e24ac5473a99562c4023be916e879f39befaa3'},
  {name:'postgres',path:'docs/validation/postgres-lifecycle-baseline-v4.json',count:656,sha256:'6a4792428343ee5b379ea01e7c6d8be8edf023b7a3bd70ea62ac8771d48d1eef'}
]);

function sourceRows(rows,count){
  need(Array.isArray(rows)&&rows.length===count,'CI_SOURCE_BASELINE_COUNT');
  const seen=new Set();
  for(const row of rows){
    need(exact(row,['path','sha256'])&&safePath(row.path)&&digest(row.sha256),'CI_SOURCE_BASELINE_ROW');
    const key=row.path.toLowerCase();need(!seen.has(key),'CI_SOURCE_BASELINE_DUPLICATE');seen.add(key);
  }
  return new Map(rows.map(row=>[row.path,row.sha256]));
}

/** Only these six CI files can differ. Runtime/test sources retain their original hashes. */
export function ciSourcePolicyContractV2(value,parent){
  need(exact(parent,['format','parentCommit','blobs'])&&parent.format==='IDMS_CI_SOURCE_PARENT_V2'&&parent.parentCommit===parentCommit,'CI_SOURCE_PARENT_FIELDS');
  const rows=sourceRows(parent.blobs,762);
  need(exact(value,['format','parentCommit','parentManifestFile','parentManifestSha256','ciBindings','runtimeChanges'])&&value.format==='IDMS_CI_SOURCE_POLICY_V2'&&value.parentCommit===parentCommit&&value.parentManifestFile===parentFile&&value.parentManifestSha256===parentSha256,'CI_SOURCE_POLICY_FIELDS');
  need(Array.isArray(value.runtimeChanges)&&value.runtimeChanges.length===0,'CI_SOURCE_RUNTIME_CHANGE');
  need(Array.isArray(value.ciBindings)&&value.ciBindings.length===6&&value.ciBindings.every(row=>exact(row,['path','beforeSha256','afterSha256'])),'CI_SOURCE_BINDING_FIELDS');
  need(value.ciBindings.map(row=>row.path).sort().join(',')===ciSourceFilesV2.join(','),'CI_SOURCE_BINDING_SCOPE');
  for(const row of value.ciBindings)need(digest(row.beforeSha256)&&digest(row.afterSha256)&&rows.get(row.path)===row.beforeSha256,'CI_SOURCE_BINDING_DIGEST');
  return structuredClone(value);
}

async function sourceFile(root,path){
  need(safePath(path),'CI_SOURCE_PATH');const file=resolve(root,path),before=await lstat(file);
  const normalized=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=2*1024**2&&normalized(await realpath(file))===normalized(file),'CI_SOURCE_FILE');
  const bytes=await readFile(file),after=await lstat(file);
  need(after.isFile()&&!after.isSymbolicLink()&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'CI_SOURCE_FILE_CHANGED');
  return {path:file,bytes,sha256:hash(bytes)};
}

/** Read-only admission: no child processes, database connections or lifecycle actions. */
export async function inspectCiSourcePolicyV2(expectedPolicySha256){
  need(digest(expectedPolicySha256),'CI_SOURCE_POLICY_DIGEST');
  const root=fileURLToPath(new URL('../',import.meta.url));
  const parentItem=await sourceFile(root,parentFile),policyItem=await sourceFile(root,policyFile);
  need(parentItem.sha256===parentSha256&&policyItem.sha256===expectedPolicySha256,'CI_SOURCE_MANIFEST_CHANGED');
  const parent=JSON.parse(parentItem.bytes.toString('utf8')),declaration=ciSourcePolicyContractV2(JSON.parse(policyItem.bytes.toString('utf8')),parent);
  const bindings=new Map(declaration.ciBindings.map(row=>[row.path,row]));
  const inspected=new Map();
  async function verify(rows,count){
    sourceRows(rows,count);const pins=[];
    for(const row of rows){
      const expected=bindings.get(row.path)?.afterSha256??row.sha256;
      let item=inspected.get(row.path);
      if(!item){item=await sourceFile(root,row.path);inspected.set(row.path,item);}
      need(item.sha256===expected,'CI_SOURCE_BYTES_CHANGED:'+row.path);
      pins.push({path:row.path,sha256:expected});
    }
    return pins;
  }
  const currentPins=await verify(parent.blobs,762),parentRows=new Map(parent.blobs.map(row=>[row.path,row.sha256]));
  const historicalBaselines={},executionBaselines={},profiles=[];
  for(const descriptor of snapshots){
    const item=inspected.get(descriptor.path);
    need(item&&item.sha256===descriptor.sha256&&parentRows.get(descriptor.path)===descriptor.sha256,'CI_SOURCE_SNAPSHOT_CHANGED');
    const baseline=JSON.parse(item.bytes.toString('utf8'));
    const pins=await verify(baseline.blobs,descriptor.count);
    const ciRows=baseline.blobs.filter(row=>bindings.has(row.path)),changed=ciRows.filter(row=>row.sha256!==bindings.get(row.path).afterSha256);
    historicalBaselines[descriptor.name]=baseline;
    executionBaselines[descriptor.name]={format:'IDMS_CI_SOURCE_EXECUTION_BASELINE_V2',historicalSnapshot:descriptor.path,historicalSnapshotSha256:descriptor.sha256,currentParentCommit:parentCommit,blobs:pins};
    profiles.push({name:descriptor.name,snapshotFile:descriptor.path,snapshotSha256:descriptor.sha256,sourceBlobs:descriptor.count,nonCiFilesUnchanged:descriptor.count-ciRows.length,ciFilesBound:ciRows.length,ciFilesChangedSinceSnapshot:changed.length});
  }
  return {
    parentCommit,policySha256:policyItem.sha256,
    policyPin:{path:policyItem.path,sha256:policyItem.sha256},parentPin:{path:parentItem.path,sha256:parentItem.sha256},
    executionBaseline:{format:'IDMS_CI_SOURCE_EXECUTION_BASELINE_V2',parentCommit,blobs:currentPins},
    historicalBaselines,executionBaselines,profiles,
    parentSourceBlobs:762,nonCiParentFilesUnchanged:756,ciFilesBound:6,
    ciFilesChangedSinceParent:declaration.ciBindings.filter(row=>row.beforeSha256!==row.afterSha256).length,
    ciBindings:declaration.ciBindings,runtimeChanges:0,historicalSnapshotsRewritten:false,
    servicesStarted:0,databasesContacted:0
  };
}

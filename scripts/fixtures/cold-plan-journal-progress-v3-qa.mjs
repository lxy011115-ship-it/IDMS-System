import {readdir,stat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
/** Counts and sizes only. Never reads a credential, SQL row or business value. */
export async function coldOwnedReviewProgressQaV1(root,nonce){
 if(typeof nonce!=='string'||!/^[a-f0-9]{12}$/.test(nonce))throw Error('COLD_REVIEW_PROGRESS_NONCE');
 const work=resolve(root,'work/cold-plan-journal-native-v3-20261025',nonce),review=join(work,'review-private');
 if(relative(resolve(root),work).startsWith('..'))throw Error('COLD_REVIEW_PROGRESS_ROOT');
 const result={targetEvidenceFiles:0,targetEvidenceBytes:0,latestTargetEvidenceBytes:0,latestTargetEvidenceModifiedAt:null,originalSessionPeerEvidenceFiles:0};
 let files;try{files=await readdir(review,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return result;throw e;}
 let latest=-1;
 for(const entry of files){
  if(entry.isFile()&&/^target-map-[a-z0-9_-]+-[a-f0-9-]{36}\.jsonl$/.test(entry.name)){
   const s=await stat(join(review,entry.name));result.targetEvidenceFiles++;result.targetEvidenceBytes+=s.size;
   if(s.mtimeMs>latest){latest=s.mtimeMs;result.latestTargetEvidenceBytes=s.size;result.latestTargetEvidenceModifiedAt=s.mtime.toISOString();}
  }else if(entry.isDirectory()&&/^owned-session-[a-f0-9-]{36}$/.test(entry.name)){
   const names=await readdir(join(review,entry.name));result.originalSessionPeerEvidenceFiles+=names.filter(n=>/^peers-[a-f0-9-]{36}\.private\.json$/.test(n)).length;
  }
 }
 return result;
}

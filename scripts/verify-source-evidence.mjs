import {readFile,stat} from 'node:fs/promises';
import {verifySourceEvidenceV1} from '../server/source-governance-evidence-v1.ts';
const file=process.argv[2];
if(!file||process.argv.length!==3){console.error('Usage: node scripts/verify-source-evidence.mjs <idms-source-governance.json>');process.exitCode=2;}
else try{if((await stat(file)).size>256*1024*1024)throw Error('Source evidence exceeds the 256 MiB verifier input cap');const p=verifySourceEvidenceV1(JSON.parse(await readFile(file,'utf8')));console.log(JSON.stringify({consistent:true,format:p.format,tenantId:p.result.tenantId,edgeId:p.result.edgeId,records:p.result.total,counts:p.result.counts,inputDigest:p.inputDigest,resultDigest:p.resultDigest,verificationScope:p.result.verificationScope,fieldCommissioned:false,notice:p.result.notice},null,2));}catch(error){console.error('Source evidence verification failed: '+error.message);process.exitCode=1;}

import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {verifyQualityEvaluationPackage} from '../server/quality-policy-evaluation.ts';
import {verifyQualityEvaluationPackageV2} from '../server/quality-policy-evaluation-v2.ts';
const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--file')throw Error('Use --file <quality evaluation JSON>');
const file=await open(resolve(args[1]),'r');try{const before=await file.stat();if(!before.isFile()||before.size>128*1024*1024)throw Error('Evaluation package exceeds 128 MiB');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const r=await file.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)throw Error('Truncated evaluation package');offset+=r.bytesRead;}const extra=Buffer.alloc(1);if((await file.read(extra,0,1,offset)).bytesRead)throw Error('Evaluation package changed while reading');const raw=JSON.parse(bytes.toString('utf8'));console.log(JSON.stringify((raw?.format==='idms-quality-policy-evaluation-v2'?verifyQualityEvaluationPackageV2:verifyQualityEvaluationPackage)(raw),null,2));}finally{await file.close();}

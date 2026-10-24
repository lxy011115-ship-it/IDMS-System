import {readApplicationFileV1} from './runtime-application-config-v1.mjs';
import {FieldMapColdReviewControlV1} from './field-map-cold-review-control-v1.mjs';
import {createHash} from 'node:crypto';
const fail=message=>{throw Error(message);};
try{
 if(process.argv.length!==5||!['CLAIM','STATUS'].includes(process.argv[2]))fail('FIELD_COLD_REVIEW_COMMAND');
 const file=await readApplicationFileV1(process.argv[3]),config=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(file.bytes).replace(/^\uFEFF/,'')),control=new FieldMapColdReviewControlV1(config);
 let problem;try{const result=await control[process.argv[2]==='CLAIM'?'claim':'status']({recoveryId:process.argv[4]});console.log(JSON.stringify(result));}catch(e){problem=e;throw e;}finally{try{await control.close();}catch(e){if(problem)problem.resourceCleanupUnproven=true;else throw e;}}
}catch(e){console.log(JSON.stringify({format:'FIELD_MAP_COLD_REVIEW_SAFE_FAILURE_V1',code:/^(FIELD_|AUTHORITY_)[A-Z0-9_]{1,128}$/.test(e.code??e.message??'')?(e.code??e.message):'FIELD_COLD_REVIEW_UNVERIFIABLE',messageSha256:createHash('sha256').update(e.message??'').digest('hex'),formalFieldActivationGranted:false}));process.exitCode=1;}

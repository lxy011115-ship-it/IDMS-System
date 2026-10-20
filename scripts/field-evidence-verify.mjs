import {readFieldEvidenceFile,parseFieldEvidenceJson,fieldEvidenceFlags} from './field-evidence-file.mjs';
import {verifyFieldEvidencePack,fieldEvidenceTrust,fieldEvidenceMaxBytes,fieldEvidenceFailure as fail} from '../server/field-evidence.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
let secret;
try{
 const args=fieldEvidenceFlags(process.argv.slice(2),['--pack','--trust-config','--event-key-file','--hmac-policy','--expected-pack-sha256']);if(!args['--pack']||!args['--trust-config']||args['--hmac-policy']&&!['optional','require'].includes(args['--hmac-policy'])||args['--expected-pack-sha256']&&!/^[a-f0-9]{64}$/.test(args['--expected-pack-sha256']))fail('FIELD_EVIDENCE_ARGUMENTS_INVALID');
 const bytes=await readFieldEvidenceFile(args['--pack'],fieldEvidenceMaxBytes),packSha256=fieldSha256(bytes);if(args['--expected-pack-sha256']&&args['--expected-pack-sha256']!==packSha256)fail('FIELD_EVIDENCE_EXPECTED_PACK_CHANGED');const pack=parseFieldEvidenceJson(bytes,{canonicalRequired:true}),trust=fieldEvidenceTrust(parseFieldEvidenceJson(await readFieldEvidenceFile(args['--trust-config'],262144))),eventKeys=new Map();
 if(args['--event-key-file']){secret=await readFieldEvidenceFile(args['--event-key-file'],32);if(secret.length!==32||secret.every(b=>b===0))fail('FIELD_EVIDENCE_EVENT_KEY_INVALID');eventKeys.set(fieldSha256(secret),secret);}
 const report=verifyFieldEvidencePack(pack,trust,{eventKeys,requireHmac:args['--hmac-policy']==='require'});console.log(JSON.stringify({...report,packSha256,expectedPackDigestMatched:!!args['--expected-pack-sha256']},null,2));
}catch(error){console.error(JSON.stringify({code:typeof error.code==='string'&&/^FIELD_EVIDENCE_[A-Z0-9_]+$/.test(error.code)?error.code:'FIELD_EVIDENCE_VERIFICATION_FAILED',inputRetained:true,productionAcceptance:false}));process.exitCode=1;}finally{secret?.fill(0);}

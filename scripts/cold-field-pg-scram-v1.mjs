import sasl from 'pg/lib/crypto/sasl.js';
import {randomBytes,createHmac,createHash,timingSafeEqual} from 'node:crypto';

const need=value=>{if(!value)throw Error('COLD_FIELD_PG_SCRAM_UNVERIFIABLE');};
/**
 * Matches a password to both keys in an actual PostgreSQL SCRAM verifier using
 * this application's pg client's real password preparation and iteration bound.
 * This opens no connection and proves neither LOGIN nor SQL privileges.
 */
export async function verifyColdFieldPgScramV1(password,verifier){
  const buffers=[];let session;
  try{
    need(typeof password==='string'&&password.length>0&&password.length<=4096&&!/[\0\r\n]/.test(password));
    const match=typeof verifier==='string'&&verifier.length<=2048&&verifier.match(/^SCRAM-SHA-256\$([1-9][0-9]{0,5}):([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/);need(match);
    const iterations=Number(match[1]);need(iterations<=sasl.DEFAULT_MAX_SCRAM_ITERATIONS);
    const decoded=value=>{const bytes=Buffer.from(value,'base64');buffers.push(bytes);need(bytes.toString('base64')===value);return bytes;};
    const salt=decoded(match[2]),storedKey=decoded(match[3]),serverKey=decoded(match[4]);need(salt.length>0&&salt.length<=1024&&storedKey.length===32&&serverKey.length===32);
    session=sasl.startSession(['SCRAM-SHA-256']);need(session.mechanism==='SCRAM-SHA-256'&&session.response==='n,,n=*,r='+session.clientNonce);
    const first=session.response.slice(3),nonce=session.clientNonce+randomBytes(18).toString('base64'),challenge='r='+nonce+',s='+match[2]+',i='+iterations,final='c=biws,r='+nonce;
    await sasl.continueSession(session,password,challenge);need(session.message==='SASLResponse'&&session.response.startsWith(final+',p='));
    const proof=decoded(session.response.slice(final.length+3)),authMessage=first+','+challenge+','+final;need(proof.length===32);
    const clientSignature=createHmac('sha256',storedKey).update(authMessage).digest(),recoveredClientKey=Buffer.alloc(32);buffers.push(clientSignature,recoveredClientKey);
    for(let index=0;index<32;index++)recoveredClientKey[index]=proof[index]^clientSignature[index];
    const recoveredStoredKey=createHash('sha256').update(recoveredClientKey).digest(),signature=createHmac('sha256',serverKey).update(authMessage).digest();buffers.push(recoveredStoredKey,signature);
    need(timingSafeEqual(recoveredStoredKey,storedKey));
    const actualServerSignature=decoded(session.serverSignature);need(actualServerSignature.length===32&&timingSafeEqual(actualServerSignature,signature));sasl.finalizeSession(session,'v='+signature.toString('base64'));
    return Object.freeze({format:'COLD_FIELD_PG_SCRAM_MATCH_V1',actualPgDriverPasswordPreparationUsed:true,bothStoredAndServerKeysMatched:true,sqlConnectionOpened:false,loginOrPrivilegesProven:false,credentialsOrVerifierDigestsPublished:false});
  }catch{throw Object.assign(Error('COLD_FIELD_PG_SCRAM_UNVERIFIABLE'),{code:'COLD_FIELD_PG_SCRAM_UNVERIFIABLE'});}
  finally{for(const bytes of buffers)bytes.fill(0);if(session){session.response='';session.serverSignature='';session.clientNonce='';}}
}

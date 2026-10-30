import pg from 'pg';
const need=(v,code)=>{if(!v)throw Object.assign(Error(code),{code});},hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.getOwnPropertySymbols(v).length===0&&Object.keys(v).sort().join(',')===[...k].sort().join(',');
const identifier=v=>'"'+v.replaceAll('"','""')+'"',text=v=>"E'"+v.replaceAll('\\','\\\\').replaceAll("'","''")+"'",bytes=v=>"E'\\\\x"+v+"'::bytea";
/** Fixed three original statements in one simple-protocol message. No SQL/entry/callback is accepted. */
export async function readColdDomainProofTripletV1(client,raw){
 need(client instanceof pg.Client&&client.getTransactionStatus?.()==='T','COLD_DOMAIN_PROOF_ORIGINAL_TRANSACTION');
 need(exact(raw,['tenantId','writer','keyHash','rootId'])&&typeof raw.tenantId==='string'&&Buffer.byteLength(raw.tenantId)>0&&Buffer.byteLength(raw.tenantId)<=64&&!raw.tenantId.includes('\0')&&typeof raw.writer==='string'&&Buffer.byteLength(raw.writer)>0&&Buffer.byteLength(raw.writer)<=63&&!raw.writer.includes('\0')&&hex(raw.keyHash)&&(raw.rootId===null||hex(raw.rootId)),'COLD_DOMAIN_PROOF_TRIPLET_REQUEST');
 const sql='SET LOCAL SESSION AUTHORIZATION '+identifier(raw.writer)+';SELECT state_map_v1.read_proof_v1('+text(raw.tenantId)+'::text,'+bytes(raw.keyHash)+','+(raw.rootId===null?'NULL::bytea':bytes(raw.rootId))+') AS value;SET LOCAL SESSION AUTHORIZATION DEFAULT';
 const results=await client.query(sql);
 need(Array.isArray(results)&&results.length===3&&results[0]?.command==='SET'&&Array.isArray(results[0].rows)&&results[0].rows.length===0&&results[1]?.command==='SELECT'&&results[1].rowCount===1&&Array.isArray(results[1].rows)&&results[1].rows.length===1&&Object.keys(results[1].rows[0]).join(',')==='value'&&results[2]?.command==='SET'&&Array.isArray(results[2].rows)&&results[2].rows.length===0,'COLD_DOMAIN_PROOF_TRIPLET_RESULT');
 return results[1].rows[0].value;
}

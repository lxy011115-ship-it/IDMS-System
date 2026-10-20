import pg from 'pg';
export function jsonEncodedBytes(value,key=''){
 if(value!==null&&typeof value==='object'&&typeof value.toJSON==='function')value=value.toJSON(key);
 if(typeof value==='string'){
  let bytes=2;for(let start=0;start<value.length;){let end=Math.min(start+8192,value.length);if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff&&value.charCodeAt(end)>=0xdc00&&value.charCodeAt(end)<=0xdfff)end--;bytes+=Buffer.byteLength(JSON.stringify(value.slice(start,end)))-2;start=end;}return bytes;
 }
 if(Array.isArray(value)){let bytes=2;for(let i=0;i<value.length;i++)bytes+=(i?1:0)+(jsonEncodedBytes(value[i],String(i))??4);return bytes;}
 if(value!==null&&typeof value==='object'){let bytes=2,n=0;for(const name of Object.keys(value)){const amount=jsonEncodedBytes(value[name],name);if(amount!==undefined)bytes+=(n++?1:0)+Buffer.byteLength(JSON.stringify(name))+1+amount;}return bytes;}
 const text=JSON.stringify(value);return text===undefined?undefined:Buffer.byteLength(text);
}
// Test-process observation only; counters contain no query values or row bodies.
export function instrumentSql(current,onSample=()=>{}){
 const prior=pg.Client.prototype.query;
 pg.Client.prototype.query=function(...args){
  const config=args[0],sql=typeof config==='string'?config:config?.text||'';
  const completed=(bytes,maximum=0)=>{const m=current();m.queries++;m.sqlRowJsonBytes!==undefined?m.sqlRowJsonBytes+=bytes:m.rowJsonBytes+=bytes;if(/v\.payload FROM business_state|IDMS_ENTITY_ROWS/.test(sql))m.fullWorkspaceQueries++;if(sql.includes('IDMS_VERIFIED_READ_FINGERPRINT'))m.fingerprintQueries++;if(sql.includes('IDMS_COLD_CANONICAL_ROWS')||sql.includes('IDMS_COLD_IMPORT_STATE'))m.coldProofQueries=(m.coldProofQueries||0)+1;if(m.streamQueries!==undefined&&sql.includes('IDMS_ENTITY_ROWS')){m.streamQueries++;m.maxDriverRows=Math.max(m.maxDriverRows,maximum);}onSample();};
  if(config&&typeof config.submit==='function'){
   let bytes=2,rows=0,maximum=0;
   config.on('row',(row,result)=>{
    bytes+=jsonEncodedBytes(row)+(rows++?1:0);
    if(result&&rows===1){const add=result.addRow;result.addRow=function(value){add.call(this,value);maximum=Math.max(maximum,this.rows.length);};}
    if(rows%256===0)onSample();
   });config.once('end',()=>completed(bytes,maximum));return prior.apply(this,args);
  }
  const result=prior.apply(this,args);if(!result?.then)return result;
  return result.then(r=>{completed(jsonEncodedBytes(r.rows||[]));return r;});
 };
}

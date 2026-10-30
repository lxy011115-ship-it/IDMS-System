import assert from 'node:assert/strict';
/** Exact original Java wire: compact insertion-order JSON plus one LF. This is
 * framing only; the separate consumer must still bind identity, lease, source,
 * original helper exit and actual SQL/workflow evidence. */
export function parseOriginalReaderPeerJsonLineQaV1(bytes){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=8*1024**2);
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),value=JSON.parse(text);
 assert(value&&Object.getPrototypeOf(value)===Object.prototype);assert.equal(Object.keys(value).join(','),'binding,payload');
 for(const key of ['binding','payload'])assert(value[key]&&Object.getPrototypeOf(value[key])===Object.prototype);
 assert.equal(text,JSON.stringify(value)+'\n');
 return value;
}

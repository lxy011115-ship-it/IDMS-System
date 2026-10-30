export const terminal=new Set(['COMMITTED','FAILED','CANCELLED','NOT_ENQUEUED','CLOSED']);
export const actions=new Set(['claim','start','submit','approval','workflow/retry']);
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
export function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export async function commandDigest(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value)));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
const states=new Set(['UNKNOWN','ACCEPTED','RUNNING','WAITING_AUTH','RETRY',...terminal]);
/** Whitelist persisted fields. In particular, never carry a command body, session or result. */
export function safeRecords(value){if(!Array.isArray(value))return [];const seen=new Set();return value.filter(v=>v&&uuid(v.commandId)&&!seen.has(v.commandId)&&seen.add(v.commandId)&&(!v.jobId||uuid(v.jobId))&&(!v.requestHash||typeof v.requestHash==='string'&&/^[a-f0-9]{64}$/.test(v.requestHash))&&(!v.action||actions.has(v.action))).slice(0,30).map(v=>({commandId:v.commandId,...(v.jobId?{jobId:v.jobId}:{}),...(v.requestHash?{requestHash:v.requestHash}:{}),...(v.action?{action:v.action}:{}),status:states.has(v.status)?v.status:'UNKNOWN'}));}
export function unresolved(record){return !terminal.has(record.status)&&!record.jobId;}

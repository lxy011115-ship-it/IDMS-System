import {coldRuntimeHashV1 as hash} from './runtime-cold-facts-v1.mjs';
/** A captured cookie cannot authorize APIs, but must not prevent an explicit fresh login. */
export function runtimeColdCookiePolicyV1(method,path,header,deadlines){
 const url=new URL(path,'http://127.0.0.1'),parts=String(header??'').split(';').map(s=>s.trim()),sessions=parts.filter(s=>s.startsWith('idms_session=')).map(s=>s.slice(13));let invalid=sessions.length>1;const decoded=[];for(const value of sessions)try{decoded.push(decodeURIComponent(value));}catch{invalid=true;}
 const captured=decoded.some(v=>deadlines.capturedSessionHashes.includes(hash(v))),callback=method==='GET'&&url.pathname==='/api/v1/auth/callback',login=method==='GET'&&url.pathname==='/api/v1/auth/login',closedAttempt=callback&&(deadlines.capturedLoginHashes??[]).includes(hash(url.searchParams.get('state')??'')),discard=invalid||captured;
 return{deny:closedAttempt||discard&&!login&&!callback&&url.pathname.startsWith('/api/'),clearSession:discard||closedAttempt,cookie:discard?parts.filter(s=>!s.startsWith('idms_session=')).join('; '):String(header??'')};
}

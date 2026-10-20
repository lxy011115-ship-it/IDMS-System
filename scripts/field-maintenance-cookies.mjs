export function maintenanceCookies(capability){
 const prefix='idms_recovery_'+capability.sessionId.replaceAll('-','')+'_',names=new Map([[prefix+'session','idms_session'],[prefix+'login','idms_login']]);
 return {
  request(req){const cookies=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(Boolean).flatMap(part=>{const at=part.indexOf('='),name=at<0?'':part.slice(0,at);return names.has(name)?[names.get(name)+part.slice(at)]:[];});const adapted=Object.create(req);adapted.headers={...req.headers,cookie:cookies.join('; ')};return adapted;},
  response(res){const native=res.setHeader;res.setHeader=function(name,value){if(name.toLowerCase()==='set-cookie'){const map=s=>s.replace(/^(idms_session|idms_login)=/,(_,key)=>prefix+key.slice(5)+'=').replace(/Max-Age=(\d+)/,(_,raw)=>'Max-Age='+Math.min(Number(raw),Math.max(0,Math.floor((Date.parse(capability.expiresAt)-Date.now())/1000))));value=Array.isArray(value)?value.map(map):map(String(value));}return native.call(this,name,value);};return ()=>{res.setHeader=native;};},
  prefix
 };
}

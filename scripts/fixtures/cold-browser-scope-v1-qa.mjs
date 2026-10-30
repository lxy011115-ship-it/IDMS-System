import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const coldBrowserScopeCasesV1={
 site:{role:'quality-engineer',sites:['V4-SITE'],lines:['*'],devices:['*']},
 line:{role:'maintenance-engineer',sites:['*'],lines:['HIDDEN-LINE'],devices:['*']},
 device:{role:'quality-engineer',sites:['*'],lines:['*'],devices:['READ-008']},
 empty:{role:'quality-engineer',sites:['V4-SITE'],lines:['HIDDEN-LINE'],devices:['*']}
};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const location=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{0,160}$/.test(v);
export function summarizeColdBrowserDevicePageV1(value){
 assert(value&&Array.isArray(value.items)&&value.items.length<=100,'BROWSER_SCOPE_DEVICE_PAGE');
 assert(value.nextCursor===null||value.nextCursor===undefined||typeof value.nextCursor==='string'&&value.nextCursor.length>0,'BROWSER_SCOPE_CURSOR');
 return {items:value.items.map(d=>{assert(id(d.deviceCode)&&location(d.site)&&location(d.line),'BROWSER_SCOPE_DEVICE_FIELDS');return {deviceCode:d.deviceCode,site:d.site,line:d.line};}),nextCursorPresent:typeof value.nextCursor==='string'};
}
export function expectedColdBrowserScopeCodesV1(devices,name){
 const c=coldBrowserScopeCasesV1[name];assert(c,'BROWSER_SCOPE_CASE');
 assert(Array.isArray(devices)&&devices.length>0&&devices.every(d=>id(d.deviceCode)&&location(d.site)&&location(d.line)),'BROWSER_SCOPE_ORACLE');
 assert(new Set(devices.map(d=>d.deviceCode)).size===devices.length,'BROWSER_SCOPE_ORACLE_DUPLICATE');
 return devices.filter(d=>(c.sites.includes('*')||c.sites.includes(d.site))&&(c.lines.includes('*')||c.lines.includes(d.line))&&(c.devices.includes('*')||c.devices.includes(d.deviceCode))).map(d=>d.deviceCode).sort();
}
/** Explicit backend oracle facts are not themselves real-browser scope evidence. */
export function verifyColdBrowserScopePagesV1(rows,{name,actorId,oracle}){
 const c=coldBrowserScopeCasesV1[name];assert(c,'BROWSER_SCOPE_CASE');
 const session=rows.findLast(r=>r.path==='/api/v1/auth/session'&&r.session?.authenticated&&r.session.actorId===actorId);assert(session,'BROWSER_SCOPE_SESSION');
 const callback=rows.find(r=>r.sequence<session.sequence&&r.path==='/api/v1/auth/callback'&&r.status===303&&r.callback?.sessionCookieHash===session.sessionCookieHash&&r.callback.httpOnly&&r.callback.sameSiteLax);assert(callback,'BROWSER_SCOPE_REAL_CALLBACK');
 const auth=rows.findLast(r=>r.sequence<callback.sequence&&r.path==='/api/v1/auth/login'&&r.status===303);assert(auth?.authorization?.codeChallengeMethod==='S256'&&auth.authorization.challengePresent&&auth.authorization.statePresent,'BROWSER_SCOPE_REAL_PKCE');
 assert(session.session.roles.includes(c.role)&&!session.session.roles.some(r=>['tenant-admin','system-admin','platform-certifier','auditor','final-approver'].includes(r)),'BROWSER_SCOPE_BROAD_ROLE');
 assert.deepEqual(session.session.scope,{sites:c.sites,lines:c.lines,devices:c.devices,provided:true},'BROWSER_SCOPE_CLAIMS');
 const allPages=rows.filter(r=>r.sessionCookieHash===session.sessionCookieHash&&r.method==='GET'&&r.path==='/api/v4/predictive/devices'&&r.status===200&&r.devicePage),expected=expectedColdBrowserScopeCodesV1(oracle,name),expectedSet=new Set(expected),expectedByCode=new Map(oracle.map(d=>[d.deviceCode,d]));
 for(const d of allPages.flatMap(r=>r.devicePage.items)){assert(expectedSet.has(d.deviceCode),'BROWSER_SCOPE_EARLIER_LEAK');assert.deepEqual(d,expectedByCode.get(d.deviceCode),'BROWSER_SCOPE_FACT_CHANGED');}
 const pages=allPages.filter(r=>r.page==='/predictive/'),start=pages.findLastIndex(r=>r.deviceQueryCursorPresent===false);assert(start>=0,'BROWSER_SCOPE_FIRST_PAGE');
 const selected=pages.slice(start);assert(selected.length>0&&selected.at(-1).devicePage.nextCursorPresent===false,'BROWSER_SCOPE_PAGINATION_INCOMPLETE');
 for(let i=0;i<selected.length;i++){assert.equal(selected[i].deviceQueryCursorPresent,i>0);assert.equal(selected[i].devicePage.nextCursorPresent,i<selected.length-1);}
 const actual=selected.flatMap(r=>r.devicePage.items.map(d=>d.deviceCode));assert.equal(new Set(actual).size,actual.length,'BROWSER_SCOPE_DUPLICATE_DEVICE');assert.deepEqual([...actual].sort(),expected,'BROWSER_SCOPE_MEMBERSHIP');
 return {name,actorId,role:c.role,scope:{sites:c.sites,lines:c.lines,devices:c.devices},realPkce:true,pages:selected.length,devices:expected.length,deviceCodesSha256:createHash('sha256').update(JSON.stringify(expected)).digest('hex'),backendOracleExplicit:true,backendOracleSubstitutedForGui:false};
}

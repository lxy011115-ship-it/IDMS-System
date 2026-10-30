import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import * as old from '../server/canonical-state.ts';
import * as next from '../server/canonical-stream-v2.ts';
const text=(api,value)=>{let out='',largest=0;api.emitCanonical(value,piece=>{out+=piece;largest=Math.max(largest,piece.length);});return{out,largest};};let cases=0;
const check=value=>{const a=text(old,value),b=text(next,value);assert.equal(b.out,a.out);assert.equal(b.out,canonical(value));assert.equal(next.canonicalDigest(value),old.canonicalDigest(value));assert.equal(next.canonicalDigest(value),createHash('sha256').update(b.out).digest('hex'));assert.ok(b.largest<=49154);cases++;};
for(const value of [null,true,false,0,-0,NaN,Infinity,1e-8,'',[],{},[undefined,,()=>{},Symbol('x')],{undefined,fn:()=>{},symbol:Symbol('x')},new Date(),Buffer.from('bytes')])check(value);
const shared={n:1};check([shared,shared]);let seed=0x12345678;const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
const str=n=>Array.from({length:n},()=>String.fromCharCode(rand()%65536)).join('');
for(const size of [127,128,129,8191,8192,8193,16383,32768])for(const body of ['a'.repeat(size),'\u0000'.repeat(size),str(size),'a'.repeat(size-1)+'\ud83d\ude00']){check(body);check({[body]:body});}
for(let i=0;i<1500;i++){const value={};for(let n=0;n<5;n++)Object.defineProperty(value,str(rand()%20),{value:[str(rand()%50),rand(),n%2===0,null],enumerable:true,configurable:true,writable:true});check(value);}
const unusual=Object.create(null);for(let i=0;i<300;i++)unusual[i===0?'__proto__':'key'+i]=str(8);check(unusual);
for(const root of [undefined,()=>{},Symbol('x'),1n]){assert.throws(()=>old.canonicalDigest(root));assert.throws(()=>next.canonicalDigest(root));}
const cycle={};cycle.self=cycle;assert.throws(()=>next.canonicalDigest(cycle),/Cyclic/);assert.throws(()=>old.canonicalDigest(cycle),/Cyclic/);
assert.equal(next.canonicalEqual,old.canonicalEqual);assert.equal(next.jsonWireClone,old.jsonWireClone);
const history=Array.from({length:45000},(_,i)=>({eventId:'event-'+i,tenantId:'sandbox',previousHash:'a'.repeat(64),hash:'b'.repeat(64),businessTime:'2026-10-19T03:00:00.000Z',action:'TELEMETRY_STORED',metadata:{inputDigest:'c'.repeat(64),deviceCode:'SIM-CNC-01',mapVersion:'v1',pointId:'point-'+i,origin:'SIMULATOR'}}));
const value={audits:history,business:{tenants:[{id:'sandbox'}]},imports:{batches:[],records:[],requests:[]},idempotency:[]};assert.equal(next.canonicalDigest(value),old.canonicalDigest(value));
const observations=[];for(let round=0;round<5;round++){for(const name of round%2?['next','old']:['old','next']){const api=name==='old'?old:next,cpu=process.cpuUsage(),started=performance.now(),digest=api.canonicalDigest(value),ms=performance.now()-started,used=process.cpuUsage(cpu);observations.push({round,encoder:name,ms,cpuMs:(used.user+used.system)/1000,digest});}}
const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)],oldMs=median(observations.filter(x=>x.encoder==='old').map(x=>x.ms)),nextMs=median(observations.filter(x=>x.encoder==='next').map(x=>x.ms));assert.ok(observations.every(x=>x.digest===observations[0].digest));
const proof={format:'idms-canonical-stream-v2-verification-v1',verifiedAt:new Date().toISOString(),equivalenceCases:cases,exactOriginalCanonicalTextAndSha256AcrossUnicodeUndefinedSparseAndKeyBoundaries:true,cycleAndUnsupportedRootRefusals:true,sameOriginalEqualityAndJsonWireFunctions:true,localKeyCacheMaximumEntries:128,localKeyCacheMaximumKeyCharacters:128,largeStringsRemainChunked:true,syntheticHistoryRows:45000,alternatingOrderObservations:observations,medianOriginalMs:oldMs,medianV2Ms:nextMs,observedMedianReductionPercent:100*(oldMs-nextMs)/oldMs,persistedDigestFormatChanged:false,originalCanonicalModuleChanged:false,actualReceiverWithV2Verified:false,deployedToOriginalCore:false,productionCapacityOrSlaAcceptance:false,productionAcceptance:false};
await writeFile('work/telemetry-cpu-profile-20261019/canonical-v2-verification.json',JSON.stringify(proof,null,2),{flag:'wx'});console.log(JSON.stringify({equivalenceCases:cases,medianOriginalMs:oldMs,medianV2Ms:nextMs,reductionPercent:proof.observedMedianReductionPercent,actualReceiverWithV2Verified:false}));

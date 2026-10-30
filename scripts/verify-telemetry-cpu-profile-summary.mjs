import assert from 'node:assert/strict';
import {summarizeCpuProfile} from './telemetry-cpu-profile-summary.mjs';
const node=(id,name,children=[])=>({id,callFrame:{functionName:name,url:'file:///C:/qa/same.mjs',lineNumber:0},children}),profile={nodes:[node(1,'root',[2]),node(2,'recursive',[3]),node(3,'recursive')],samples:[2,3],timeDeltas:[1000,2000],startTime:0,endTime:3000};
const r=summarizeCpuProfile(profile,'C:/qa');assert.equal(r.sampledTimeMs,3);assert.equal(r.files.length,1);assert.equal(r.files[0].selfMs,3);assert.equal(r.files[0].inclusiveMs,3);assert.equal(r.functions.find(x=>x.function==='recursive').inclusiveMs,3);assert.equal(r.functions.find(x=>x.function==='recursive').selfMs,3);
assert.throws(()=>summarizeCpuProfile({...profile,timeDeltas:[1]}));assert.throws(()=>summarizeCpuProfile({...profile,samples:[9],timeDeltas:[1]}));assert.throws(()=>summarizeCpuProfile({...profile,timeDeltas:[-1,2]}));assert.throws(()=>summarizeCpuProfile({...profile,nodes:[node(1,'root',[2,3]),node(2,'two',[3]),node(3,'three')]}));
console.log('Verified CPU sample weights, recursive frame/file inclusive deduplication, self-time conservation and malformed profile refusal.');

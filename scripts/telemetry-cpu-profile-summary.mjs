import assert from 'node:assert/strict';
import {relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function summarizeCpuProfile(profile,root=process.cwd()){
 assert.ok(Array.isArray(profile.nodes)&&Array.isArray(profile.samples)&&Array.isArray(profile.timeDeltas));assert.equal(profile.samples.length,profile.timeDeltas.length);
 const nodes=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map();for(const node of nodes.values())for(const child of node.children??[]){assert.ok(!parents.has(child),'CPU profile is not a tree');parents.set(child,node.id);}
 const functions=new Map(),files=new Map();let totalUs=0,idleUs=0,gcUs=0;
 const frame=id=>{const n=nodes.get(id);assert.ok(n,'Missing CPU sample node');const c=n.callFrame;let file=c.url||'(native)';if(file.startsWith('file:'))file=relative(resolve(root),fileURLToPath(file)).replaceAll('\\','/');const line=c.lineNumber+1,key=JSON.stringify([file,c.functionName,line]);return{key,file,function:c.functionName||'(anonymous)',line};};
 const add=(map,key,fields,kind,value)=>{let row=map.get(key);if(!row){row={...fields,selfUs:0,inclusiveUs:0};map.set(key,row);}row[kind]+=value;};
 for(let i=0;i<profile.samples.length;i++){
  const us=profile.timeDeltas[i],id=profile.samples[i],self=frame(id);assert.ok(Number.isFinite(us)&&us>=0);totalUs+=us;if(self.function==='(idle)')idleUs+=us;if(self.function==='(garbage collector)')gcUs+=us;
  add(functions,self.key,self,'selfUs',us);add(files,self.file,{file:self.file},'selfUs',us);
  let cursor=id;const seen=new Set(),seenFunctions=new Set(),seenFiles=new Set();while(cursor!==undefined){assert.ok(!seen.has(cursor),'CPU profile parent cycle');seen.add(cursor);const f=frame(cursor);if(!seenFunctions.has(f.key)){add(functions,f.key,f,'inclusiveUs',us);seenFunctions.add(f.key);}if(!seenFiles.has(f.file)){add(files,f.file,{file:f.file},'inclusiveUs',us);seenFiles.add(f.file);}cursor=parents.get(cursor);}
 }
 const rows=map=>[...map.values()].map(({key,...r})=>({...r,selfMs:r.selfUs/1000,inclusiveMs:r.inclusiveUs/1000,selfPercent:totalUs?r.selfUs*100/totalUs:0})).sort((a,b)=>b.selfUs-a.selfUs);
 return {format:'idms-cpu-profile-summary-v1',sampleCount:profile.samples.length,profileDurationMs:(profile.endTime-profile.startTime)/1000,sampledTimeMs:totalUs/1000,idleMs:idleUs/1000,gcMs:gcUs/1000,functions:rows(functions),files:rows(files),inclusiveTimesOverlap:true,timeDeltasAreSamplingWeightsNotExactFunctionStopwatches:true};
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {stateKey,stateValueText,stateValueHash,parseStateValueText,stateEmptyHashes,stateLeaf,stateBranch,stateRoot,stateCommonPrefix,stateBit,verifyStateProof,rebuildStateRoot,stateRequestDigest,stateReceiptHash,stateMapFormat,type StateNode} from './state-map-v1.ts';
const digest=(...parts:Buffer[])=>{const h=createHash('sha256');parts.forEach(p=>h.update(p));return h.digest('hex');};
test('compressed root equals independently expanded 256 level sparse tree',()=>{
 const entries=Array.from({length:57},(_,i)=>[stateKey('acme','asset','中文😀'+i),stateValueHash(stateValueText({i,n:[true,null]}))] as [string,string]);
 const empty=Buffer.from(digest(Buffer.from([2])),'hex');
 const merge=(a:{h:Buffer,n:bigint},b:{h:Buffer,n:bigint})=>{const x=Buffer.alloc(8),y=Buffer.alloc(8);x.writeBigInt64BE(a.n);y.writeBigInt64BE(b.n);return {h:Buffer.from(digest(Buffer.from([1]),x,a.h,y,b.h),'hex'),n:a.n+b.n};};
 const es=[{h:empty,n:0n}];for(let i=0;i<256;i++)es.push(merge(es[i],es[i]));
 const full=(rows:[string,string][],d:number):{h:Buffer,n:bigint}=>{if(!rows.length)return es[256-d];if(d===256)return {h:Buffer.from(digest(Buffer.from([0]),Buffer.from(rows[0][0],'hex'),Buffer.from(rows[0][1],'hex')),'hex'),n:1n};return merge(full(rows.filter(r=>stateBit(r[0],d)===0),d+1),full(rows.filter(r=>stateBit(r[0],d)===1),d+1));};
 const actual=rebuildStateRoot(entries);assert.equal(actual.rootHash,full(entries,0).h.toString('hex'));assert.equal(actual.count,'57');assert.deepEqual(actual,rebuildStateRoot(entries.toReversed()));assert.equal(rebuildStateRoot([]).rootHash,stateEmptyHashes[0]);assert.ok(Object.isFrozen(stateEmptyHashes));
});
test('member and absent proofs reject altered value, sibling, root, count and unused nodes',()=>{
 const keys=['a','b','c'].map(k=>stateKey('acme','asset',k)).sort(),values=keys.map((_,i)=>stateValueText({i})),leaves=keys.map((k,i)=>stateLeaf(k,stateValueHash(values[i]))),all=new Map<string,StateNode>(leaves.map(n=>[n.id,n]));
 const build=(nodes:StateNode[]):StateNode=>{if(nodes.length===1)return nodes[0];const d=stateCommonPrefix(nodes[0].prefix,nodes.at(-1)!.prefix),b=stateBranch(d,build(nodes.filter(n=>stateBit(n.prefix,d)===0)),build(nodes.filter(n=>stateBit(n.prefix,d)===1)));all.set(b.id,b);return b;};const root=stateRoot(build(leaves));
 const proof=(key:string,valueText:string|null)=>{const used=new Map<string,StateNode>();let n=all.get(root.rootId!)!;used.set(n.id,n);while(n.kind===1){for(const id of [n.left!,n.right!])used.set(id,all.get(id)!);n=all.get(stateBit(key,n.depth)?n.right!:n.left!)!;}return {format:stateMapFormat,keyHash:key,root,nodes:[...used.values()],valueText};};
 const p=proof(keys[0],values[0]);assert.equal(verifyStateProof(p,root,keys[0]).present,true);const missing=stateKey('acme','asset','missing'),abs=proof(missing,null); // prune unused descendants after prefix divergence
 const used=new Set<string>();let n=all.get(root.rootId!)!;used.add(n.id);while(n.kind===1&&n.prefix===(awaitPrefix(missing,n.depth))){used.add(n.left!);used.add(n.right!);n=all.get(stateBit(missing,n.depth)?n.right!:n.left!)!;}abs.nodes=abs.nodes.filter(n=>used.has(n.id));assert.equal(verifyStateProof(abs,root,missing).present,false);
 for(const mutate of [(q:any)=>q.valueText='{}',(q:any)=>q.root={...q.root,count:'999'},(q:any)=>q.nodes[0].hash='0'.repeat(64),(q:any)=>q.nodes.push(structuredClone(q.nodes[0]))]){const q=structuredClone(p);mutate(q);assert.throws(()=>verifyStateProof(q,root,keys[0]));}
 function awaitPrefix(key:string,d:number){const b=Buffer.from(key,'hex');for(let i=0;i<32;i++){const bits=d-i*8;if(bits<=0)b[i]=0;else if(bits<8)b[i]&=255<<(8-bits);}return b.toString('hex');}
});
test('JSON exact bytes, duplicate decoded keys, Unicode, bounds and non data objects',()=>{
 assert.deepEqual(parseStateValueText(' { "b": [1,true,null], "a": "😀" } '),{b:[1,true,null],a:'😀'});assert.notEqual(stateValueHash('1'),stateValueHash('1.0'));assert.equal(stateValueText({z:1,a:'中'}),'{"a":"中","z":1}');
 for(const t of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','[1,]','01','1e999','"\\ud800"','"\\u0000"','[] false','['.repeat(130)+'0'+']'.repeat(130)])assert.throws(()=>parseStateValueText(t),t);
 const cyclic:any={};cyclic.x=cyclic;for(const v of [cyclic,NaN,new Date(),{get x(){throw Error('accessed');}},[undefined],Array(2),{x:undefined},'\ud800'])assert.throws(()=>stateValueText(v));assert.throws(()=>stateKey('acme','asset','\ud800'));assert.throws(()=>stateValueText('x'.repeat(1024*1024)));
});
test('request and receipt bind tenant, revision, exact operations and before receipt',()=>{
 const id=randomUUID(),r=stateEmptyHashes[0],ops=[{namespace:'asset',key:'x',expected:null,valueText:'null'}],h=stateRequestDigest('acme',id,'0',r,ops);assert.notEqual(h,stateRequestDigest('acme',id,'1',r,ops));assert.notEqual(h,stateRequestDigest('other',id,'0',r,ops));assert.notEqual(h,stateRequestDigest('acme',id,'0',r,[{...ops[0],valueText:null}]));assert.throws(()=>stateRequestDigest('acme',id,'0',r,[...ops,...ops]));
 const receipt={tenantId:'acme',commandId:id,requestHash:h,beforeRevision:'0',beforeRoot:r,beforeReceiptHash:'0'.repeat(64),revision:'1',rootId:null,rootHash:r,count:'0'};assert.notEqual(stateReceiptHash(receipt),stateReceiptHash({...receipt,beforeReceiptHash:'1'.repeat(64)}));assert.throws(()=>stateReceiptHash({...receipt,commandId:'bad'}));
});

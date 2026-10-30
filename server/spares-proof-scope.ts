import type pg from 'pg';
import {holdValue} from './capacity.ts';
const scopes=new WeakMap<pg.PoolClient,Map<string,{publish:()=>void;release:()=>void}>>();
export function beginSpareProofScope(c:pg.PoolClient){discardSpareProofScope(c);scopes.set(c,new Map());}
export const hasSpareProofScope=(c:pg.PoolClient)=>scopes.has(c);
/** Bounded pending data; never retains an event body or publishes before commit. */
export function stageSpareProof(c:pg.PoolClient,key:string,value:unknown,publish:()=>void){
 const pending=scopes.get(c);if(!pending)return false;
 pending.get(key)?.release();pending.delete(key);
 while(pending.size>=1024){const first=pending.keys().next().value!;pending.get(first)!.release();pending.delete(first);}
 pending.set(key,{publish,release:holdValue({key,value})});return true;
}
export function discardSpareProofScope(c:pg.PoolClient){const pending=scopes.get(c);if(!pending)return;scopes.delete(c);for(const p of pending.values())p.release();pending.clear();}
export function commitSpareProofScope(c:pg.PoolClient){const pending=scopes.get(c);if(!pending)return;scopes.delete(c);try{for(const p of pending.values()){try{p.publish();}catch{/* Optional reuse cannot change a confirmed business result. */}}}finally{for(const p of pending.values())p.release();pending.clear();}}

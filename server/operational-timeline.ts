import {spanMilliseconds,unionSpans,type Span} from './operational-numbers.ts';

export interface Cell extends Span {kind:string;reason?:string}
// Partitioned timelines admit O(log n) duration queries, rather than scanning all
// state rows for every production row. Gaps and overlaps are explicit cells.
export function timelineIndex(cells:readonly Cell[],from:number,to:number){
 const kinds=[...new Set(cells.map(c=>c.kind))].sort(),prefix=new Map(kinds.map(k=>[k,[0n]]));
 for(const cell of cells)for(const k of kinds){const p=prefix.get(k)!;p.push(p.at(-1)!+(cell.kind===k?BigInt(cell.to-cell.from):0n));}
 const at=(k:string,x:number)=>{const p=prefix.get(k);if(!p||x<=from)return 0n;if(x>=to)return p.at(-1)!;let lo=0,hi=cells.length;while(lo<hi){const m=(lo+hi)>>>1;if(cells[m].to<=x)lo=m+1;else hi=m;}return p[lo]+(lo<cells.length&&cells[lo].kind===k?BigInt(Math.max(0,x-cells[lo].from)):0n);};
 return {cells,kinds,duration:(k:string,a=from,b=to)=>at(k,Math.min(to,b))-at(k,Math.max(from,a))};
}
export function stateTimeline(rows:readonly {from:number;to:number;kind:string;reason?:string}[],from:number,to:number){
 const events:{at:number;id:number;add:boolean}[]=[];for(const [id,r]of rows.entries()){const a=Math.max(from,r.from),b=Math.min(to,r.to);if(b>a)events.push({at:a,id,add:true},{at:b,id,add:false});}events.sort((a,b)=>a.at-b.at||Number(a.add)-Number(b.add)||a.id-b.id);
 const cells:Cell[]=[],active=new Set<number>();let last=from,i=0;const push=(end:number)=>{if(end<=last)return;const row=active.size===1?rows[active.values().next().value!]:null,kind=active.size===0?'GAP':active.size>1?'OVERLAP':row!.kind,reason=row?.reason;const prior=cells.at(-1);if(prior&&prior.kind===kind&&prior.reason===reason&&prior.to===last)prior.to=end;else cells.push({from:last,to:end,kind,...(reason?{reason}:{})});last=end;};
 while(i<events.length){const at=events[i].at;push(at);while(i<events.length&&events[i].at===at){const e=events[i++];if(e.add)active.add(e.id);else active.delete(e.id);}}push(to);return timelineIndex(cells,from,to);
}
export function overlapIds(rows:readonly Span[]){const ids=new Set<number>(),ordered=rows.map((r,id)=>({...r,id})).sort((a,b)=>a.from-b.from||a.to-b.to||a.id-b.id);let max=-Infinity,owner=-1;for(const r of ordered){if(r.from<max){ids.add(r.id);ids.add(owner);}if(r.to>max){max=r.to;owner=r.id;}}return ids;}
export function intersectionDuration(spans:readonly Span[],index:ReturnType<typeof timelineIndex>,kind:string){return spans.reduce((n,s)=>n+index.duration(kind,s.from,s.to),0n);}
export const unionDuration=(spans:readonly Span[])=>spanMilliseconds(unionSpans(spans));
export function plannedRunningTimeline(left:ReturnType<typeof timelineIndex>,right:ReturnType<typeof timelineIndex>,from:number,to:number){let i=0,j=0;const cells:Cell[]=[];while(i<left.cells.length&&j<right.cells.length){const a=left.cells[i],b=right.cells[j],start=Math.max(a.from,b.from),end=Math.min(a.to,b.to);if(end>start)cells.push({from:start,to:end,kind:a.kind==='RUNNING'&&b.kind==='RUN'?'RUNNING_PLANNED':'OTHER'});if(a.to<=b.to)i++;else j++;}return timelineIndex(cells,from,to);}

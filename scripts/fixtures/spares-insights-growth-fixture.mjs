import {spareCommand} from '../../server/spares.ts';
import {spareEventHash} from '../../server/spares-audit-chain.ts';
/** Legacy domain-valid history is a QA seed, not application-role activity. */
export async function seedInsightsGrowth(owner,ctx,refs){
 const parts=[];let sequence=0,previous='GENESIS',batch=[];
 await owner.query('BEGIN');try{
  const flush=async()=>{if(!batch.length)return;await owner.query("INSERT INTO idms_spares.events SELECT 'qa',(r->>'sequence')::bigint,'F1',r->'body',r->>'hash' FROM jsonb_array_elements($1::jsonb) r",[JSON.stringify(batch)]);batch=[];};
  const event=async(action,before,after)=>{const body={tenantId:'qa',actor:ctx.actorId,action,at:new Date().toISOString(),correlationId:'domain-generated-owned-insights-growth',previousHash:previous,before:[before],after:[structuredClone(after)]};previous=spareEventHash(body);batch.push({sequence:++sequence,body,hash:previous});if(batch.length===128)await flush();};
  for(let i=1;i<=10001;i++){const part=spareCommand({entities:[]},'part.create',{siteCode:'F1',code:'INSIGHT-GROW-'+String(i).padStart(5,'0'),name:'洞察增长合成备件 '+i,unit:'只'},ctx,refs);parts.push(part);await event('part.create',null,part);}
  for(let i=0;i<10000;i++){const before=structuredClone(parts[i]);spareCommand({entities:[parts[i]]},'part.update',{id:parts[i].id,expectedVersion:1,name:'洞察增长修订 '+i},ctx,refs);await event('part.update',before,parts[i]);}await flush();
  for(let i=0;i<parts.length;i+=128)await owner.query("INSERT INTO idms_spares.entities SELECT 'qa',(r->>'id')::uuid,'part','F1',r FROM jsonb_array_elements($1::jsonb) r",[JSON.stringify(parts.slice(i,i+128))]);
  await owner.query("UPDATE idms_spares.state SET revision=$1 WHERE tenant_id='qa'",[sequence]);await owner.query('COMMIT');return {entities:parts.length,events:sequence,method:'owned QA owner import of domain-generated legacy event history'};
 }catch(error){await owner.query('ROLLBACK');throw error;}
}

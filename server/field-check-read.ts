import type {ReadWorkspace} from './read-model.ts';
import type {AuditEvent} from './domain.ts';
import {accountValue} from './capacity.ts';
import {digest,canonical} from './imports.ts';
// Use the provider that checks its independently captured current head. A
// hash-valid prefix is insufficient: it could omit the latest revocation.
export async function readFieldCheckAudits(workspace:ReadWorkspace,tenant:string,edge:string){
 const events:AuditEvent[]=[],identity=digest(canonical({kind:'field-machine-current-check',tenant,edge}));
 try{await workspace.readAuditPage({tenantId:tenant,identity,scope:identity,pageSize:1,filters:{q:'',objectType:'',action:'',actorId:'',from:null,to:null}},event=>{accountValue(event);events.push(event);return false;});return events;}catch(e){events.length=0;throw e;}
}

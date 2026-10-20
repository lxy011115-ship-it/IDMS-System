import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceCommandAccessV4} from './maintenance-map-v4.ts';
import {MaintenanceWorkflowTransportV4,MaintenanceWorkflowProofV4} from './maintenance-workflow-transport-v4.ts';
const ctx={tenantId:'sandbox',actorId:'engineer',actorType:'USER',authMode:'oidc' as const,roles:['maintenance-engineer'],scope:{provided:true,sites:['*'],lines:['LINE-A'],devices:['*']},correlationId:'unit'};
test('maintenance requires an actual OIDC user, current assigned scope and role-derived responsibility',()=>{
 const command={id:'order-1',action:'start' as const,input:{expectedVersion:1}};maintenanceCommandAccessV4(command,ctx);
 for(const changed of [{...ctx,authMode:'demo' as const},{...ctx,actorType:'AI'},{...ctx,scope:undefined},{...ctx,roles:['auditor'],permissions:['maintenance:execute']}])assert.throws(()=>maintenanceCommandAccessV4(command,changed));
 assert.throws(()=>maintenanceCommandAccessV4({...command,action:'approval'},ctx));
});
test('maintenance request cannot inject authority, alternate workflow or unsupported fields',()=>{
 for(const input of [{expectedVersion:1,actorId:'approver'},{expectedVersion:1,workflow:{status:'SYNCED'}},{expectedVersion:0},{expectedVersion:1.5}])assert.throws(()=>maintenanceCommandAccessV4({id:'order-1',action:'start',input},ctx));
 assert.throws(()=>maintenanceCommandAccessV4({id:'order-1',action:'submit',input:{expectedVersion:1,serviceToken:'secret'}},ctx));
});
test('workflow destination is fixed trusted configuration and a JSON object cannot forge a delivery proof',()=>{
 for(const baseUrl of ['http://example.com/','http://user:pass@127.0.0.1/','http://127.0.0.1/path','http://127.0.0.1/?token=abc'])assert.throws(()=>new MaintenanceWorkflowTransportV4({baseUrl,tenantId:'sandbox',serviceToken:'x'.repeat(32)}));
 const a=new MaintenanceWorkflowTransportV4({baseUrl:'http://127.0.0.1:12345/',tenantId:'sandbox',serviceToken:'x'.repeat(32)}),b=new MaintenanceWorkflowTransportV4({baseUrl:'http://127.0.0.1:12345/',tenantId:'sandbox',serviceToken:'y'.repeat(32)});assert.notEqual(a.binding,b.binding);
 assert.throws(()=>new MaintenanceWorkflowProofV4(Symbol('fake'),{} as never,a.binding,{} as never),/CONSTRUCTOR/);
});

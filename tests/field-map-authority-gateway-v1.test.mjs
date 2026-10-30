import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createServer} from 'node:http';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {privateDirectory} from '../scripts/backup-support.mjs';
import {createFieldMapAuthorityGatewayV1,fieldMapAuthorityGatewayConfigV1,fieldMapGatewaySiteBindingV1} from '../scripts/field-map-authority-gateway-v1.mjs';

async function workspace(){const dir=resolve('work/field-map-site-gateway-20261024','unit-'+randomUUID());await mkdir(dir,{recursive:true});await privateDirectory(dir);return dir;}
async function save(root,name,value){const file=join(root,name);await writeFile(file,JSON.stringify(value));return file;}
const disabled={format:1,purpose:'FIELD_MAP_AUTHORITY_GATEWAY_V1',enabled:false};
const enabled={...disabled,enabled:true,authorityHostFile:'host.json',platformFile:'platform.json',intakeFile:'intake.json'};
function site(root){return{trustFile:join(root,'cold.json'),authorityRuntimeFile:join(root,'authority.json'),sourceDirectory:join(root,'source-pg'),targetDirectory:join(root,'target-pg'),tenants:[{tenantId:'acme',host:'127.0.0.1',port:15432,database:'qa_business',databaseOid:'20000',catalogHash:'a'.repeat(64)}]};}
function host(){return{format:1,purpose:'FIELD_MAP_AUTHORITY_HOST_V1',authorityRuntimeFile:'authority.json',coldTrustFile:'cold.json',controlAccount:{host:'127.0.0.1',port:15432,database:'postgres',user:'qa_control',password:'P'.repeat(43)},tenants:[{tenantId:'acme',account:{host:'127.0.0.1',port:15432,database:'qa_business',user:'qa_writer',password:'W'.repeat(43)},binding:{tenantId:'acme',databaseOid:'20000',roleOid:'20001',catalogHash:'a'.repeat(64)}}]};}
function absentResources(gateway){const s=gateway.state();assert.equal(s.host,null);assert.equal(s.platform,null);assert.equal(s.intake,null);assert.equal(s.activeHttp,0);}

test('explicit disabled config forbids hidden material references and enabled config requires all exact fields',()=>{assert.deepEqual(fieldMapAuthorityGatewayConfigV1(disabled),disabled);assert.throws(()=>fieldMapAuthorityGatewayConfigV1({...disabled,authorityHostFile:'host.json'}));for(const key of ['authorityHostFile','platformFile','intakeFile']){const raw={...enabled};delete raw[key];assert.throws(()=>fieldMapAuthorityGatewayConfigV1(raw));}assert.throws(()=>fieldMapAuthorityGatewayConfigV1({...enabled,permit:()=>true}));});

test('disabled gateway owns no SQL MQTT or material resources and leaves ordinary HTTP available',async()=>{
 const root=await workspace(),file=await save(root,'gateway.json',disabled);const old=pg.Client.prototype.connect;let connections=0;pg.Client.prototype.connect=function(){connections++;throw Error('DISABLED_GATEWAY_MUST_NOT_CONNECT');};let server,gateway;
 try{gateway=createFieldMapAuthorityGatewayV1(file);await gateway.ready;assert.equal(gateway.state().phase,'DISABLED');absentResources(gateway);server=createServer((req,res)=>void gateway.handleHttp(req,res).then(handled=>{if(!handled){res.writeHead(req.url==='/health'?204:404);res.end();}}));await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const origin='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(origin+'/health')).status,204);assert.equal((await fetch(origin+'/api/v1/field-channel/lease',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);assert.equal(connections,0);assert.deepEqual(await readdir(root),['gateway.json']);const proof=await gateway.close();assert(proof.normal&&proof.allOwnedResourcesRetired&&!proof.startupCancelled);absentResources(gateway);}finally{pg.Client.prototype.connect=old;await gateway?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}}
});

test('pre-start stop returns its original request proof and never reads a missing configuration',async()=>{const root=await workspace(),gateway=createFieldMapAuthorityGatewayV1(join(root,'must-not-read.json')),requestId=randomUUID(),closing=gateway.close({requestId});assert.strictEqual(gateway.close({requestId}),closing);assert.throws(()=>gateway.close({requestId:randomUUID()}),/FIELD_GATEWAY_STOP_REQUEST_CHANGED/);await assert.rejects(gateway.ready,/FIELD_GATEWAY_CANCELLED/);const proof=await closing;assert(proof.normal&&proof.startupCancelled&&proof.allOwnedResourcesRetired);absentResources(gateway);assert.deepEqual(await readdir(root),[]);});

test('an aborted startup signal drains the early-owned gateway without caller reconstruction',async()=>{const root=await workspace(),controller=new AbortController(),gateway=createFieldMapAuthorityGatewayV1(join(root,'must-not-read.json'),{startupSignal:controller.signal});controller.abort();await assert.rejects(gateway.ready,/FIELD_GATEWAY_CANCELLED/);const proof=await gateway.close();assert(proof.normal&&proof.startupCancelled&&proof.allOwnedResourcesRetired);absentResources(gateway);});

test('enabled field resources cannot start without a real SITE binding',async()=>{const root=await workspace(),file=await save(root,'gateway.json',enabled),gateway=createFieldMapAuthorityGatewayV1(file);await assert.rejects(gateway.ready,/FIELD_GATEWAY_SITE_BINDING_REQUIRED/);absentResources(gateway);const proof=await gateway.close();assert.equal(proof.normal,false);assert.equal(proof.allOwnedResourcesRetired,true);});

test('wrong SITE authority or tenant database refuses before any material or SQL startup',async()=>{
 for(const wrong of ['authority','database']){const root=await workspace(),file=await save(root,'gateway.json',enabled),raw=host(),expected=site(root);if(wrong==='authority')raw.coldTrustFile='other-cold.json';else expected.tenants[0].databaseOid='20002';await save(root,'host.json',raw);const gateway=createFieldMapAuthorityGatewayV1(file,{siteBinding:expected});await assert.rejects(gateway.ready,new RegExp(wrong==='authority'?'FIELD_GATEWAY_SITE_AUTHORITY':'FIELD_GATEWAY_SITE_DATABASE'));absentResources(gateway);assert.equal((await gateway.close()).allOwnedResourcesRetired,true);assert.deepEqual((await readdir(root)).sort(),['gateway.json','host.json']);}
});

test('public SITE binding has no credentials or role coercion and is independent of caller mutation',async()=>{const root=await workspace(),raw=site(root),copy=fieldMapGatewaySiteBindingV1(raw);raw.tenants[0].databaseOid='20002';assert.equal(copy.tenants[0].databaseOid,'20000');assert.throws(()=>fieldMapGatewaySiteBindingV1({...copy,password:'not-allowed'}));assert.throws(()=>fieldMapGatewaySiteBindingV1({...copy,tenants:[{...copy.tenants[0],roleOid:'20001'}]}));});

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {seedStore} from '../../server/store.ts';
import {emptyImports,parseCsv,createBatch,approveBatch} from '../../server/imports.ts';
import {tenantPayload} from '../../server/entity-repository.ts';
import {privateDirectory} from '../backup-support.mjs';
import {writeControlledColdSourceBundleV1} from '../controlled-cold-source-bundle-v1.mjs';

assert([3,4].includes(process.argv.length),'CONTROLLED_COLD_PUBLIC_SOURCE_ARGUMENTS');
const file=resolve(process.argv[2]);await privateDirectory(dirname(file));const store=seedStore(),data=emptyImports(),inputs=[],uploader={tenantId:'acme',actorId:'demo.uploader',actorType:'USER',correlationId:'portable-public-source'},reviewer={...uploader,actorId:'demo.approver'};
const templates=[['DEVICE','devices.csv'],['DEVICE','devices-extended.csv'],['POINT_DEFINITION','point-definitions.csv'],['MEASUREMENT','measurements.csv'],['PRODUCTION','production.csv'],['STATE_INTERVAL','state-intervals.csv'],['MAINTENANCE','maintenance.csv'],['QUALITY','quality.csv']];
for(const[dataType,name]of templates){const path='docs/upload-templates/'+name,original=await readFile(path),parsed=parseCsv(original.toString('utf8')),batch=createBatch(data,store,{dataType,templateVersion:'1.0.0',sourceSystem:'public-portable-fixture',original,filename:name,mime:'text/csv',sourceKind:'MANUAL_FILE',...parsed},uploader);assert(['AWAITING_APPROVAL','HUMAN_REVIEW'].includes(batch.status),'PUBLIC_TEMPLATE_REQUIRES_VALID_ROWS_'+name);approveBatch(data,store,batch.batchId,{decision:'APPROVED',comment:'Synthetic independent review of the public repository template',reviewResolution:'Synthetic test reviewer checked the public template rows',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},reviewer);assert.equal(batch.status,'COMMITTED');inputs.push({path,sha256:createHash('sha256').update(original).digest('hex'),bytes:original.length});}
const {audits,idempotency,...business}=store,payload=tenantPayload({version:2,business,audits,idempotency:[...idempotency],imports:data},'acme'),files=payload.imports.batches.map(b=>({sha256:b.fileSha256,bytes:Buffer.from(b.originalBase64,'base64').length})),evidence={readOnly:false,publicTemplateInputs:inputs,files,fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0)},result=await writeControlledColdSourceBundleV1(file,{profile:'PUBLIC_APPROVED_TEMPLATES_V1',payload,evidence});
if(process.argv[3]){const {appendFile}=await import('node:fs/promises');await appendFile(resolve(process.argv[3]),'file='+result.file+'\nsha256='+result.sha256+'\n',{encoding:'utf8'});}console.log(JSON.stringify(result));

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import pg from 'pg';
import {validateRuntimeConfig,verifyDatabaseSecurity,connectionFor} from '../server/postgres-security.ts';
import {readEntities} from '../server/entity-repository.ts';
import {privateDirectory} from './backup-support.mjs';
import {writeControlledColdSourceBundleV1} from './controlled-cold-source-bundle-v1.mjs';

assert.equal(process.argv.length,4,'CONTROLLED_COLD_EXPORT_ARGUMENTS');
const config=validateRuntimeConfig(JSON.parse((await readFile(resolve(process.argv[2]),'utf8')).replace(/^\uFEFF/,''))),account=config.tenants.acme,file=resolve(process.argv[3]);await privateDirectory(dirname(file));
const c=new pg.Client(connectionFor(config,account));let payload,evidence;
try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verifyDatabaseSecurity(c,account,'acme');const loaded=await readEntities(c,'acme');payload=loaded.payload;const files=payload.imports.batches.map(b=>({sha256:b.fileSha256,bytes:Buffer.from(b.originalBase64,'base64').length}));evidence={capturedAt:new Date().toISOString(),readOnly:(await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only==='on',revision:loaded.revision,files,fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.bytes,0)};await c.query('COMMIT');}finally{await c.end();}
console.log(JSON.stringify(await writeControlledColdSourceBundleV1(file,{profile:'PRIVATE_READ_ONLY_ACME_V1',payload,evidence})));

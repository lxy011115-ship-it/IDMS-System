import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {RuntimeMaintenanceControlV1} from '../runtime-maintenance-control-v1.mjs';
assert.equal(process.argv.length,4);assert(['CLOSE','CLOSE_EXIT_AFTER_FIRST'].includes(process.argv[2]));const c=JSON.parse(await readFile(process.argv[3],'utf8')),control=new RuntimeMaintenanceControlV1(c.account,c.trust,c.manifest);
const receipt=await control.close({operationId:c.operationId,afterDatabaseClosed:async({index,database})=>{if(index===0&&process.argv[2]==='CLOSE_EXIT_AFTER_FIRST'){process.stdout.write(JSON.stringify({event:'FIRST_SQL_CLOSED',database})+'\n');process.exit(77);}}});console.log(JSON.stringify({event:'MAINTENANCE_CLOSED',receipt}));

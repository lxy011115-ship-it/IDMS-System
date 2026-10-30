import {readFile} from 'node:fs/promises';
import {BusinessMaintenanceGate} from '../business-maintenance-gate.mjs';
const setup=JSON.parse(await readFile(process.argv[2],'utf8')),gate=new BusinessMaintenanceGate(setup.deployment,setup.bindings,setup.operationId);await gate.acquire();process.send?.({type:'HELD',summary:gate.summary()});
process.on('message',m=>{if(m.type==='RELEASE')void gate.release().then(()=>process.disconnect());});
process.once('disconnect',()=>void gate.release());

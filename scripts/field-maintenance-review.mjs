import {startFieldMaintenanceSupervisor} from './field-maintenance-supervisor.mjs';
let service;
try{
 const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--config'||args[2]!=='--expected-sha256'||!/^[a-f0-9]{64}$/.test(args[3]))throw Error('Invalid supervisor arguments');
 service=await startFieldMaintenanceSupervisor({configFile:args[1],expectedSha256:args[3]});
 console.log(JSON.stringify({format:'idms-field-maintenance-review-listening-v1',origin:service.origin,operationId:service.operationId,state:'RESTORING',fieldEnabled:false,businessWritesEnabled:false,activationEnabled:false,credentialsLogged:false,productionAcceptance:false}));
 const stop=()=>service.close().catch(()=>{process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);
}catch(e){console.error(JSON.stringify({code:typeof e.code==='string'&&/^FIELD_[A-Z0-9_]+$/.test(e.code)?e.code:'FIELD_MAINTENANCE_SUPERVISOR_FAILED',credentialsLogged:false,productionAcceptance:false}));process.exitCode=1;await service?.close();}

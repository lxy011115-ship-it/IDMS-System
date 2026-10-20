// This entrypoint accepts only the readonly reader bundle. It never loads an
// authority, source runtime, migration config or archive key.
let service;
try{
 const args=process.argv.slice(2);const bridgeMode=args.length===5&&args[4]==='--review-bridge';if(!(args.length===4||bridgeMode)||args[0]!=='--config'||args[2]!=='--expected-sha256'||!args[1]||!/^[a-f0-9]{64}$/.test(args[3]))throw Error('Invalid reader arguments');
 for(const key of Object.keys(process.env))if(/^IDMS_/i.test(key))delete process.env[key];
 let reviewBridge;if(bridgeMode){if(!process.send||!process.connected)throw Error('Missing owned IPC');const nonce=await new Promise((ok,no)=>{const timer=setTimeout(()=>no(Error('Bridge initialization timeout')),5000);process.once('message',m=>{clearTimeout(timer);if(m?.type!=='FIELD_MAINTENANCE_BRIDGE_INIT')no(Error('Bridge initialization invalid'));else ok(m.nonce);});process.send({type:'FIELD_MAINTENANCE_BRIDGE_READY'});});const {maintenanceBridge}=await import('./field-maintenance-bridge.mjs');reviewBridge=maintenanceBridge(nonce);}
 const {startFieldMaintenance}=await import('./field-maintenance-server.mjs');service=await startFieldMaintenance({configFile:args[1],expectedSha256:args[3],reviewBridge,onClosed:()=>{if(bridgeMode&&process.connected)process.disconnect();}});if(bridgeMode)process.once('disconnect',()=>service.close().catch(()=>{}));
 console.log(JSON.stringify({format:'idms-field-maintenance-listening-v1',origin:service.origin,operationId:service.operationId,sessionId:service.sessionId,state:'RESTORING',fieldEnabled:false,businessWritesEnabled:false,activationEnabled:false,credentialsLogged:false,productionAcceptance:false}));
 const stop=()=>service.close().catch(()=>{process.exitCode=1;});process.once('SIGINT',stop);process.once('SIGTERM',stop);
}catch(e){console.error(JSON.stringify({code:typeof e.code==='string'&&/^FIELD_[A-Z0-9_]+$/.test(e.code)?e.code:'FIELD_MAINTENANCE_FAILED',credentialsLogged:false,productionAcceptance:false}));process.exitCode=1;await service?.close();}

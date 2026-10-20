import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { OPCUAServer,DataType,Variant,DataValue,MessageSecurityMode,SecurityPolicy,StatusCodes } from 'node-opcua';
const config=JSON.parse(await readFile(process.env.IDMS_TELEMETRY_CONFIG||'.local/mqtt/telemetry-runtime.json','utf8'));
const options=config.simulator;let writeRequests=0,readRequests=0,historyStep=0;
const start=Date.now();
const server=new OPCUAServer({port:options.port,host:'127.0.0.1',hostname:'127.0.0.1',alternateHostname:['127.0.0.1'],resourcePath:'',securityModes:[MessageSecurityMode.None],securityPolicies:[SecurityPolicy.None],buildInfo:{productName:'IDMS Explicit Simulator',buildNumber:'1',buildDate:new Date()},serverInfo:{applicationUri:'urn:idms:simulator',productUri:'urn:idms:simulator',applicationName:{text:'IDMS SIMULATOR — not a field device'}}});
server.on('request',request=>{if(request.schema.name==='WriteRequest')writeRequests++;if(request.schema.name==='ReadRequest')readRequests++;});
await server.initialize();
const ns=server.engine.addressSpace!.getOwnNamespace();
const device=ns.addObject({organizedBy:server.engine.addressSpace!.rootFolder.objects,browseName:'SIM-CNC-01'});
for(const point of config.sources[0].points){
  ns.addVariable({componentOf:device,browseName:point.tagCode,nodeId:point.nodeId,dataType:'Double',accessLevel:'CurrentRead',userAccessLevel:'CurrentRead',minimumSamplingInterval:100,value:{timestamped_get(){
    const base=point.tagCode==='vibration_rms'?2.5:point.tagCode==='bearing_temperature'?48:4;
    // QA can compress a historical 5-minute window; all such samples remain explicitly synthetic.
    const timestamp=process.env.IDMS_SIMULATOR_HISTORY==='1'?new Date(start-300000+historyStep*60000):new Date();
    return new DataValue({value:new Variant({dataType:DataType.Double,value:base}),statusCode:StatusCodes.Good,sourceTimestamp:timestamp});
  }}});
}
await server.start();
const status=createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+options.statusKey){res.writeHead(403);res.end();return;}
  if(req.method==='POST'&&req.url==='/advance'&&process.env.IDMS_SIMULATOR_HISTORY==='1'){historyStep=Math.min(5,historyStep+1);res.writeHead(200);res.end();return;}
  if(req.method!=='GET'||req.url!=='/status'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({origin:'SIMULATOR',writeRequests,readRequests,endpoint:`opc.tcp://127.0.0.1:${options.port}`,uptimeMs:Date.now()-start}));
});
status.listen(options.statusPort,'127.0.0.1');
console.log(`Read-only SIMULATOR OPC UA endpoint on port ${options.port}; not a customer device.`);
for(const sig of ['SIGTERM','SIGINT'] as const)process.once(sig,()=>{status.close();server.shutdown(0).finally(()=>process.exit(0));});

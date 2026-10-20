import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authenticEvent, signEvent, signAck, sha, topicFor, validateEvent, type EdgeSource } from '../integrations/telemetry.ts';
import { EdgeSpool } from '../services/edge/spool.ts';
import { measurementSchema } from './measurement-schema.ts';

const source:EdgeSource={tenantId:'sandbox',edgeId:'qa-edge',deviceCode:'SIM-01',origin:'SIMULATOR',mapVersion:'1',signingKey:'s'.repeat(64),acknowledgementKey:'a'.repeat(64),statusKey:'h'.repeat(64),statusUrl:'http://127.0.0.1:4014/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s'}]};
const sample=()=>({tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',eventTime:new Date().toISOString(),value:2,unit:'mm/s',quality:'GOOD' as const});
function event(){return signEvent({version:1,eventId:randomUUID(),tenantId:source.tenantId,edgeId:source.edgeId,deviceCode:source.deviceCode,mapVersion:source.mapVersion,sequenceNo:1,...sample()},source.signingKey);}
test('telemetry authenticates exact source, topic, unit, time, range and schema',()=>{
  const e=event();assert.ok(authenticEvent(e,source.signingKey));validateEvent(e,source,measurementSchema);
  assert.equal(topicFor(source,'telemetry'),'idms/v1/sandbox/qa-edge/telemetry');
  assert.equal(authenticEvent({...e,value:10},source.signingKey),false);
  for(const patch of [{tenantId:'acme'},{deviceCode:'other'},{unit:'g'},{value:9999},{eventTime:new Date(Date.now()+600000).toISOString()},{unexpected:1},{quality:'GOOD',value:null}])assert.throws(()=>validateEvent({...e,...patch} as typeof e,source,measurementSchema));
  validateEvent({...e,quality:'BAD',value:null},source,measurementSchema);
});
test('edge WAL survives restart, does not clear on publish, rejects forged/wrong-digest ACK and retains rejection',()=>{
  const dir=mkdtempSync(join(tmpdir(),'idms-edge-'));let spool:EdgeSpool|undefined;
  try{
    spool=new EdgeSpool(join(dir,'spool.sqlite'),source,2);const first=spool.append(sample());spool.attempted(first.eventId);
    assert.equal(spool.stats().pending,1);spool.close();spool=new EdgeSpool(join(dir,'spool.sqlite'),source,2);
    const ack={version:1 as const,eventId:first.eventId,tenantId:source.tenantId,edgeId:source.edgeId,digest:sha(first),status:'STORED' as const};
    assert.equal(spool.acknowledge(signAck(ack,'wrong')),false);
    assert.equal(spool.acknowledge(signAck({...ack,digest:'0'.repeat(64)},source.acknowledgementKey)),false);
    assert.equal(spool.stats().pending,1);
    assert.equal(spool.acknowledge(signAck(ack,source.acknowledgementKey)),true);
    const second=spool.append(sample());assert.equal(second.sequenceNo,2);
    spool.acknowledge(signAck({...ack,eventId:second.eventId,digest:sha(second),status:'REJECTED',reason:'TEST'},source.acknowledgementKey));
    assert.equal(spool.stats().rejected,1);spool.append(sample());assert.throws(()=>spool!.append(sample()),/CAPACITY/);
    assert.equal(spool.stats().sequence,3);spool.close();spool=undefined;
    assert.throws(()=>new EdgeSpool(join(dir,'spool.sqlite'),{...source,tenantId:'acme'}),/another source/);
  }finally{spool?.close();rmSync(dir,{recursive:true,force:true});}
});

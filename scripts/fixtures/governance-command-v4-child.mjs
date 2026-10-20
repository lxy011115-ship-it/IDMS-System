import {readFile} from 'node:fs/promises';
import {GovernanceCommandServiceV4} from '../../server/governance-command-v4.ts';
const cfg=JSON.parse(await readFile(process.argv[2],'utf8'));
if(!process.connected||!/^idms_v4qa_[a-f0-9]{12}_sandbox_map$/.test(cfg.account.database)||!cfg.operationId)throw Error('GOVERNANCE_QA_CHILD');
const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){if(args.length)super(...args);else super(cfg.clock);}static now(){return cfg.clock;}};
const service=new GovernanceCommandServiceV4(cfg.account,cfg.binding,cfg.sources,{onPhase:async(phase,value)=>{process.send({type:'GOVERNANCE_PHASE',phase,index:value?.index,operationId:cfg.operationId});if(phase==='STAGED'&&value.index===1){process.send({type:'GOVERNANCE_STOPPED_AFTER_COMMITTED_STAGE',pid:process.pid,operationId:cfg.operationId});process.disconnect();process.exit(0);}}});
await service.execute(cfg.commandId,cfg.command,cfg.context);throw Error('GOVERNANCE_QA_EXPECTED_STAGE_EXIT');

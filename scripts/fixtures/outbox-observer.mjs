// Only isolated QA children use IPC. No public diagnostic endpoint is added.
import {OutboxLease} from '../../server/outbox-worker.ts';
if(!process.send||!/^(workflow-qa|ai-qa)-[a-f0-9]{10}(-peer)?$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Outbox observer requires an owned QA IPC child');
const cancel=OutboxLease.prototype.cancel;
OutboxLease.prototype.cancel=function(){const first=!this.lost;cancel.call(this);if(first)process.send?.({type:'QA_OUTBOX_LOST',jobId:this.claim.id});};

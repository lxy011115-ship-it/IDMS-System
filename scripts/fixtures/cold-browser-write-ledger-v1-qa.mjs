import assert from 'node:assert/strict';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)?value:null;
const states=new Set(['ACCEPTED','RUNNING','WAITING_AUTH','RETRY','HUMAN_REVIEW','COMMITTED','FAILED','CANCELLED','UNASSIGNED','ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL','CLOSED','SYNCED','PENDING','APPROVED','RETURNED','REJECTED','ANALYZED','WORK_ORDER_CREATED','NO_ALERT','OPEN']);
const state=value=>states.has(value)?value:null;
const action=value=>typeof value==='string'&&/^(?:[A-Z][A-Z0-9_]{1,79}|claim|start|submit|approval|workflow\/retry)$/.test(value)?value:null;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
export const captureColdBrowserWriteBodyV1=path=>/^\/api\/v4\/(?:governance|maintenance|predictive)\/(?:jobs(?:\/[a-f0-9-]+)?|commands\/[a-f0-9-]+|orders\/[A-Za-z0-9_.:-]+|alerts\/[A-Za-z0-9_.:-]+)$/.test(path);

/** Fixed response fields only. Request bodies, credentials and descriptive text are never copied. */
export function summarizeColdBrowserWriteResponseV1(path,bytes){
 if(!captureColdBrowserWriteBodyV1(path)||!bytes.length)return {};
 const value=JSON.parse(bytes.toString('utf8')),out={};
 if(value.job){const j=value.job,r=j.result;out.job={id:id(j.id),commandId:id(j.commandId),action:action(j.action),status:state(j.status),businessCommitted:j.businessCommitted===true,result:r?{id:id(r.id),alertId:id(r.alertId),orderId:id(r.order?.id),status:state(r.status),state:state(r.state),evidenceDigest:digest(r.evidenceDigest)}:null};}
 if(path.startsWith('/api/v4/maintenance/orders/')&&value.item){const o=value.item;out.order={id:id(o.id),state:state(o.state),version:Number.isSafeInteger(o.version)?o.version:null,assignee:id(o.assignee),submittedBy:id(o.resolution?.submittedBy),approver:id(o.approval?.approver),approvalDecision:state(o.approval?.decision),workflowStatus:state(o.workflow?.status)};}
 if(path.startsWith('/api/v4/predictive/alerts/')&&value.alert){const a=value.alert;out.alert={id:id(a.id),deviceCode:id(a.deviceCode),status:state(a.status),version:Number.isSafeInteger(a.version)?a.version:null};}
 return out;
}

/** The HTTP handlers themselves validate completion receipts and their business audit records. */
export function verifyColdBrowserPositiveWritesV1(rows,accounts){
 const actorHashes=new Map();
 for(const row of rows.filter(r=>r.path==='/api/v1/auth/session'&&r.session?.authenticated)){
  const callback=rows.find(r=>r.sequence<row.sequence&&r.path==='/api/v1/auth/callback'&&r.status===303&&r.callback?.sessionCookieHash===row.sessionCookieHash&&r.callback.httpOnly&&r.callback.sameSiteLax);
  if(!callback||!rows.some(r=>r.sequence<callback.sequence&&r.path==='/api/v1/auth/login'&&r.status===303&&r.authorization?.codeChallengeMethod==='S256'&&r.authorization.challengePresent&&r.authorization.statePresent))continue;
  const set=actorHashes.get(row.session.actorId)??new Set();set.add(row.sessionCookieHash);actorHashes.set(row.session.actorId,set);
 }
 const own=name=>{assert(accounts[name]?.id,'BROWSER_WRITE_ACCOUNT');const set=actorHashes.get(accounts[name].id);assert(set?.size,'BROWSER_WRITE_REAL_SESSION');return rows.filter(r=>set.has(r.sessionCookieHash));};
 const operator=own('operator'),analyst=own('analyst');assert.notEqual(accounts.operator.id,accounts.analyst.id);
 function completed(records,module,kind,match=()=>true){
  const prefix='/api/v4/'+module+'/',page='/'+module+'/';
  for(const accepted of records.filter(r=>r.method==='POST'&&r.path===prefix+'jobs'&&r.page===page&&r.status===202&&r.csrfHeaderPresent&&r.job?.action===kind)){
   const terminal=records.findLast(r=>r.sequence>accepted.sequence&&r.method==='GET'&&r.path.startsWith(prefix)&&r.status===200&&r.job?.commandId===accepted.job.commandId&&r.job.action===kind&&r.job.status==='COMMITTED'&&r.job.businessCommitted&&match(r.job));
   if(terminal)return {accepted,terminal,job:terminal.job};
  }
  assert.fail('BROWSER_GUI_COMMITTED_'+module+'_'+kind);
 }
 const governance=completed(operator,'governance','TEMPLATE_CREATE');
 const analysis=completed(analyst,'predictive','ANALYZE',j=>!!j.result?.alertId);
 const review=completed(operator,'predictive','REVIEW',j=>j.result?.alertId===analysis.job.result.alertId&&!!j.result?.orderId);
 const orderId=review.job.result.orderId,repair=[];
 for(const [kind,records]of [['claim',analyst],['start',analyst],['submit',analyst],['approval',operator]])repair.push(completed(records,'maintenance',kind,j=>j.result?.id===orderId));
 assert(review.accepted.sequence<repair[0].accepted.sequence,'BROWSER_GUI_ORDER_CREATION_SEQUENCE');
 for(let i=1;i<repair.length;i++)assert(repair[i-1].accepted.sequence<repair[i].accepted.sequence,'BROWSER_GUI_REPAIR_SEQUENCE');
 const states=['ASSIGNED','IN_PROGRESS','AWAITING_APPROVAL','CLOSED'],snapshots=[];
 for(let i=0;i<repair.length;i++){
  const next=repair[i+1]?.accepted.sequence??Infinity;
  const row=[...operator,...analyst].findLast(r=>r.sequence>repair[i].accepted.sequence&&r.sequence<next&&r.method==='GET'&&r.path==='/api/v4/maintenance/orders/'+orderId&&r.status===200&&r.order?.id===orderId&&r.order.state===states[i]&&r.order.workflowStatus==='SYNCED');
  assert(row,'BROWSER_GUI_ORDER_STATE_'+states[i]);assert.equal(row.order.assignee,accounts.analyst.id);snapshots.push(row);
 }
 for(let i=1;i<snapshots.length;i++)assert(snapshots[i].order.version>snapshots[i-1].order.version,'BROWSER_GUI_ORDER_VERSION');
 const final=snapshots.at(-1).order;assert.equal(final.submittedBy,accounts.analyst.id);assert.equal(final.approver,accounts.operator.id);assert.equal(final.approvalDecision,'APPROVED');assert.notEqual(final.submittedBy,final.approver);
 return {governanceCommandId:governance.job.commandId,analysisCommandId:analysis.job.commandId,reviewCommandId:review.job.commandId,alertId:analysis.job.result.alertId,orderId,repairCommandIds:repair.map(r=>r.job.commandId),orderStates:snapshots.map(r=>({state:r.order.state,version:r.order.version,sequence:r.sequence})),finalState:'CLOSED',workflowStatus:'SYNCED',performedBy:accounts.analyst.id,approvedBy:accounts.operator.id,realSessionCallbacksRequired:true,csrfProtectedPostsRequired:true,backendCommandsSubstitutedForGui:false,rawCredentialsRecorded:false};
}

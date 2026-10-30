import {createHash} from 'node:crypto';

const stages=new Set(['BUSINESS_CLUSTER_CREATE','IDENTITY_CLUSTER_CREATE','WORKFLOW_BUILD','IDENTITY_CREATE','SITE_FACTORY','SITE_SEAL','BACKGROUND_RECOVERY','APPLICATION_SUITE','APPLICATION_LIFECYCLE','OLD_SQL_CREDENTIAL_REJECTION','CONFIG_GENERATION','OLD_SITE_CLI_REJECTION','WORKFLOW_REATTACH','PREDICTOR_START','LOCAL_RUNTIME_LOAD','WORKER_RUNTIME_LOAD','SITE_START','EXPIRED_CREDENTIAL_NEGATIVES','REAUTHORIZED_WORKER','ROOT_CLEANUP','FIELD_CURRENT_FREEZE','FIELD_CURRENT_ARCHIVE','FIELD_CURRENT_READER_BUILD','FIELD_CURRENT_RESTORE','FIELD_CURRENT_PREPARE','FIELD_CURRENT_VERIFY','CORE_FIELD_CURRENT_VERIFY','CURRENT_DEPLOYMENT_CONTROL_PREPARE','CURRENT_DEPLOYMENT_READER_INSTALL']);
const codes=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOENT','EACCES','ERR_ASSERTION','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','28000','28P01','57P03']);
const sqlClasses=new Set(['00','01','02','03','08','09','0A','0B','0F','0L','0P','0Z','20','21','22','23','24','25','26','27','28','2B','2D','2F','34','38','39','3B','3D','3F','40','42','44','53','54','55','57','58','72','F0','HV','P0','XX']);
const sqlState=error=>typeof error?.code==='string'&&/^[A-Z0-9]{5}$/.test(error.code)&&sqlClasses.has(error.code.slice(0,2))&&['ERROR','FATAL','PANIC','WARNING'].includes(error.severity)?error.code:null;
const childCodes=new Set(['SITE_AUTHORITY_RUNTIME_FAILED','SITE_CONSOLE_RUNTIME_FAILED','WORKFLOW_FENCED_BUILD_FAILED','WORKFLOW_RUNTIME_FAILED','WORKFLOW_LIFECYCLE_START_FAILED']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const bytes=value=>Buffer.isBuffer(value)?value:typeof value==='string'?Buffer.from(value):null;

/** Error fields stay private; only fixed codes, counts and byte digests may be emitted. */
export function summarizeControlledColdFailureQaV6(error){
  const child=typeof error?.cmd==='string'?error:typeof error?.actual?.cmd==='string'?error.actual:null;
  const stdout=bytes(child?.stdout),stderr=bytes(child?.stderr),message=typeof error?.message==='string'?error.message:null;
  return {
    errorKind:['Error','AssertionError','TypeError','RangeError','AggregateError'].includes(error?.name)?error.name:'UNKNOWN',
    errorCode:codes.has(error?.code)?error.code:null,
    sqlState:sqlState(error),
    causeSqlState:sqlState(error?.cause),
    messageSha256:message?digest(message):null,
    childExecFailure:!!child,
    childExitCode:Number.isInteger(child?.code)&&child.code>=-128&&child.code<=255?child.code:null,
    childSignal:['SIGINT','SIGTERM','SIGABRT','SIGKILL','SIGSEGV','SIGBUS','SIGILL'].includes(child?.signal)?child.signal:null,
    childCommandSha256:child?digest(child.cmd):null,
    childStdoutBytes:stdout?.length??0,childStderrBytes:stderr?.length??0,
    childStdoutSha256:stdout?digest(stdout):null,childStderrSha256:stderr?digest(stderr):null,
    knownChildFailureCodes:stderr?[...new Set(stderr.toString('utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>childCodes.has(line)))].sort():[],
    rawFailureOrCredentialsPrinted:false
  };
}

export function controlledColdResourceCountsQaV6(){
  const result={};for(const type of process.getActiveResourcesInfo())result[type]=(result[type]??0)+1;return result;
}

/** Observation only: never signals, closes, adopts or restarts a child. */
export async function observeControlledColdStageQaV6(stage,operation,{report,emit=value=>console.log(JSON.stringify(value)),heartbeatMs=10000}={}){
  if(!stages.has(stage)||typeof operation!=='function'||!report||typeof report!=='object'||!Number.isInteger(heartbeatMs)||heartbeatMs<10||heartbeatMs>60000)throw Error('CONTROLLED_COLD_DIAGNOSTIC_INPUT');
  report.controlledColdStageDiagnostics??=[];const started=performance.now();let emissionFailed=false;
  const record=(phase,extra={})=>{
    const value={format:'IDMS_CONTROLLED_COLD_STAGE_DIAGNOSTIC_V6',stage,phase,elapsedMs:Math.round(performance.now()-started),resources:controlledColdResourceCountsQaV6(),...extra,rawFailureOrCredentialsPrinted:false};
    report.controlledColdCurrentStage=stage;
    if(phase!=='WAITING')report.controlledColdStageDiagnostics.push(value);
    try{emit(value);}catch{emissionFailed=true;report.controlledColdDiagnosticEmissionFailed=true;}
    return value;
  };
  record('STARTED');const timer=setInterval(()=>record('WAITING'),heartbeatMs);timer.unref();
  try{const value=await operation();record('SUCCEEDED',{emissionFailed});return value;}
  catch(error){record('FAILED',{failure:summarizeControlledColdFailureQaV6(error),emissionFailed});throw error;}
  finally{clearInterval(timer);}
}

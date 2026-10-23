import {createHash} from 'node:crypto';

const stages=new Set(['OLD_SQL_CREDENTIAL_REJECTION','CONFIG_GENERATION','OLD_SITE_CLI_REJECTION','WORKFLOW_REATTACH','PREDICTOR_START','LOCAL_RUNTIME_LOAD','WORKER_RUNTIME_LOAD','SITE_START','EXPIRED_CREDENTIAL_NEGATIVES','REAUTHORIZED_WORKER','ROOT_CLEANUP']);
const codes=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOENT','EACCES','ERR_ASSERTION','ERR_CHILD_PROCESS_STDIO_MAXBUFFER','28000','28P01','57P03']);
const childCodes=new Set(['SITE_AUTHORITY_RUNTIME_FAILED','SITE_CONSOLE_RUNTIME_FAILED','WORKFLOW_FENCED_BUILD_FAILED','WORKFLOW_RUNTIME_FAILED','WORKFLOW_LIFECYCLE_START_FAILED']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const bytes=value=>Buffer.isBuffer(value)?value:typeof value==='string'?Buffer.from(value):null;

/** Error fields stay private; only fixed codes, counts and byte digests may be emitted. */
export function summarizeControlledColdFailureQaV1(error){
  const child=typeof error?.cmd==='string'?error:typeof error?.actual?.cmd==='string'?error.actual:null;
  const stdout=bytes(child?.stdout),stderr=bytes(child?.stderr),message=typeof error?.message==='string'?error.message:null;
  return {
    errorKind:['Error','AssertionError','TypeError','RangeError','AggregateError'].includes(error?.name)?error.name:'UNKNOWN',
    errorCode:codes.has(error?.code)?error.code:null,
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

export function controlledColdResourceCountsQaV1(){
  const result={};for(const type of process.getActiveResourcesInfo())result[type]=(result[type]??0)+1;return result;
}

/** Observation only: never signals, closes, adopts or restarts a child. */
export async function observeControlledColdStageQaV1(stage,operation,{report,emit=value=>console.log(JSON.stringify(value)),heartbeatMs=10000}={}){
  if(!stages.has(stage)||typeof operation!=='function'||!report||typeof report!=='object'||!Number.isInteger(heartbeatMs)||heartbeatMs<10||heartbeatMs>60000)throw Error('CONTROLLED_COLD_DIAGNOSTIC_INPUT');
  report.controlledColdStageDiagnostics??=[];const started=performance.now();let emissionFailed=false;
  const record=(phase,extra={})=>{
    const value={format:'IDMS_CONTROLLED_COLD_STAGE_DIAGNOSTIC_V1',stage,phase,elapsedMs:Math.round(performance.now()-started),resources:controlledColdResourceCountsQaV1(),...extra,rawFailureOrCredentialsPrinted:false};
    report.controlledColdCurrentStage=stage;
    if(phase!=='WAITING')report.controlledColdStageDiagnostics.push(value);
    try{emit(value);}catch{emissionFailed=true;report.controlledColdDiagnosticEmissionFailed=true;}
    return value;
  };
  record('STARTED');const timer=setInterval(()=>record('WAITING'),heartbeatMs);timer.unref();
  try{const value=await operation();record('SUCCEEDED',{emissionFailed});return value;}
  catch(error){record('FAILED',{failure:summarizeControlledColdFailureQaV1(error),emissionFailed});throw error;}
  finally{clearInterval(timer);}
}

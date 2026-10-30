import {createHash} from 'node:crypto';
const knownMessages=new Set(['READER_PEER_OPERATION_UNCONFIRMED','READER_PEER_REPLY','READER_PEER_CONNECTIONS','READER_PEER_CONNECTION_BINDING','READER_PEER_BACKEND_CHANGED','READER_PEER_NOT_HELD','READER_PEER_POOL_HOLD_UNPROVEN','READER_PEER_RELEASE_UNPROVEN','READER_PEER_CAPTURE_BINDING','READER_PEER_PHASE','READER_PEER_HANDLE_CHANGED','READER_PEER_ALREADY_RELEASED','READER_PEER_TENANT','READER_PEER_TOOL_CHANGED','READER_PEER_TOOLS_NOT_OWNED','LIFECYCLE_RECEIPT','LIFECYCLE_HANDLE','LIFECYCLE_PROCESS_START','LIFECYCLE_PROCESS_REPLACED','LIFECYCLE_DEPLOYMENT_FILE_CHANGED','LIFECYCLE_DIRECTORY_CHANGED']);
const ioCodes=new Set(['ENOENT','EACCES','EPERM','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOSPC','EMFILE','ENFILE','ERR_ASSERTION','ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);
const sqlClasses=new Set(['00','01','02','03','08','09','0A','0B','0F','0L','0P','0Z','20','21','22','23','24','25','26','27','28','2B','2D','2F','34','38','39','3B','3D','3F','40','42','44','53','54','55','57','58','72','F0','HV','P0','XX']);
function value(object,key){try{const d=Object.getOwnPropertyDescriptor(object,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}}
function bytes(value,maximum){const length=Buffer.isBuffer(value)?value.length:typeof value==='string'?Buffer.byteLength(value):0;return{bytes:length,sha256:length&&length<=maximum?createHash('sha256').update(value).digest('hex'):null,overLimit:length>maximum};}
/** Observation only: fixed public codes and hashes; no message, stack, command or private path is copied. */
export function controlledColdFailureChainQaV1(error){
 const causes=[],seen=new Set();let current=error,cycleDetected=false,truncated=false;
 while(current&&typeof current==='object'){
  if(seen.has(current)){cycleDetected=true;break;}if(causes.length===6){truncated=true;break;}seen.add(current);
  let prototype;try{prototype=Object.getPrototypeOf(current);}catch{prototype=null;}
  const name=value(current,'name')??(prototype?value(prototype,'name'):undefined),message=value(current,'message'),code=value(current,'code'),severity=value(current,'severity'),signal=value(current,'signal'),stdout=bytes(value(current,'stdout'),32*1024**2),stderr=bytes(value(current,'stderr'),32*1024**2),command=bytes(value(current,'cmd'),1024**2),body=bytes(message,1024**2);
  causes.push({depth:causes.length,errorKind:['Error','AssertionError','TypeError','RangeError','AggregateError'].includes(name)?name:'UNKNOWN',knownMessageCode:typeof message==='string'&&knownMessages.has(message)?message:null,ioCode:ioCodes.has(code)?code:null,sqlState:typeof code==='string'&&/^[A-Z0-9]{5}$/.test(code)&&sqlClasses.has(code.slice(0,2))&&['ERROR','FATAL','PANIC','WARNING'].includes(severity)?code:null,messageBytes:body.bytes,messageSha256:body.sha256,messageOverLimit:body.overLimit,childExitCode:Number.isInteger(code)&&code>=-128&&code<=255?code:null,childSignal:['SIGINT','SIGTERM','SIGABRT','SIGKILL','SIGSEGV','SIGBUS','SIGILL'].includes(signal)?signal:null,childStdout:stdout,childStderr:stderr,childCommand:command});
  current=value(current,'cause');
 }
 return{format:'IDMS_CONTROLLED_COLD_FAILURE_CHAIN_V1',maximumDepth:6,causes,cycleDetected,truncated,rawFailureOrCredentialsPrinted:false,propertyGettersInvoked:false};
}

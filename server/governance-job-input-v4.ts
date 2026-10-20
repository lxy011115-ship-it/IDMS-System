import {DomainError} from './service.ts';
import {parseCsv,type Row} from './imports.ts';
import {legacyJsonText} from './legacy-map-v4.ts';
import {jsonWireClone} from './canonical-state.ts';
import {parseGovernanceXlsxV4} from './governance-job-xlsx-v4.ts';
import type {GovernanceCommandV4} from './governance-plan-v4.ts';
function bad(message='GOVERNANCE_INPUT_INVALID'):never{throw new DomainError(400,message);}
export async function normalizeGovernanceJobInputV4(raw:unknown):Promise<GovernanceCommandV4>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))bad();const c=jsonWireClone(raw) as GovernanceCommandV4;
 if(Object.keys(c).some(k=>!['action','id','input'].includes(k))||!['TEMPLATE_CREATE','TEMPLATE_EDIT','TEMPLATE_SUBMIT','TEMPLATE_APPROVE','IMPORT_CREATE','IMPORT_APPROVE'].includes(c.action)||!c.input||typeof c.input!=='object'||Array.isArray(c.input)||c.id!==undefined&&(typeof c.id!=='string'||!/^[-\w]{1,128}$/.test(c.id)))bad();
 if(c.action==='IMPORT_CREATE'){
  const input=c.input,allowed=['dataType','templateVersion','sourceSystem','rows','file','mappingRef','supersedesBatchId','correctionReason','equipmentProfileRef','profileDeviceCode'];if(Object.keys(input).some(k=>!allowed.includes(k)))bad('GOVERNANCE_IMPORT_PUBLIC_FIELDS');
  let rows:Row[],lineNumbers:number[],sourceHeaders:string[],original:Buffer,filename:string,mime:string,sourceKind:string;
  if(input.file!==undefined){
   if(input.rows!==undefined)bad();const f=input.file as Record<string,unknown>;if(!f||typeof f!=='object'||Array.isArray(f)||Object.keys(f).sort().join(',')!=='base64,filename'||typeof f.filename!=='string'||!/^[-\w\u4e00-\u9fff .]{1,120}\.(csv|xlsx)$/i.test(f.filename)||typeof f.base64!=='string'||f.base64.length>12*1024*1024)bad('GOVERNANCE_FILE_INVALID');original=Buffer.from(f.base64,'base64');if(original.length>8*1024*1024||original.length===0||original.toString('base64')!==f.base64)bad('GOVERNANCE_FILE_BYTES');filename=f.filename;
   if(/\.csv$/i.test(filename)){let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(original);}catch{bad('GOVERNANCE_FILE_UTF8');}({rows,lineNumbers,sourceHeaders}=parseCsv(text!,!!input.mappingRef));mime='text/csv';sourceKind='CSV';}
   else{({rows,lineNumbers,sourceHeaders}=await parseGovernanceXlsxV4(original,!!input.mappingRef));mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';sourceKind='XLSX';}
  }else{
   if(input.mappingRef!==undefined||!Array.isArray(input.rows))bad('GOVERNANCE_JSON_ROWS');rows=input.rows as Row[];if(rows.some(r=>!r||typeof r!=='object'||Array.isArray(r)||Object.values(r).some(v=>!['string','number','boolean'].includes(typeof v)&&v!==null)))bad('GOVERNANCE_JSON_ROW');original=Buffer.from(legacyJsonText(rows));filename='records.json';mime='application/json';sourceKind='API_JSON';lineNumbers=rows.map((_,i)=>i+2);sourceHeaders=rows.length?Object.keys(rows[0]):[];
  }
  if(rows.length<1||rows.length>10000||original.length>8*1024*1024)throw new DomainError(413,'GOVERNANCE_IMPORT_SIZE');const {file,rows:unused,...fields}=input;c.input={...fields,rows,originalBase64:original.toString('base64'),filename,mime,sourceKind,lineNumbers,sourceHeaders};
 }
 if(Buffer.byteLength(JSON.stringify(c))>16*1024*1024)throw new DomainError(413,'GOVERNANCE_COMMAND_SIZE');return c;
}

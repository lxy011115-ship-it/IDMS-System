import {stateMapSchemaSqlV4} from './state-map-schema-v4.mjs';
import {governanceConsoleSchemaSqlV4} from './governance-console-schema-v4.mjs';
import {maintenanceJobsSchemaSqlV4} from './maintenance-jobs-schema-v4.mjs';
import {predictiveJobsSchemaSqlV4R2} from './predictive-jobs-schema-v4-r2.mjs';
import {predictiveCancelUiSchemaSqlV1} from './predictive-cancel-ui-schema-v1.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const roles={owner:'idms_policy_owner',worker:'idms_policy_worker',reader:'idms_policy_reader',ingress:'idms_policy_ingress'};
const symbols=new Map(Object.entries(roles).map(([symbol,value])=>[value,symbol]));
const normalize=value=>value.trim().replace(/\s+/g,' ');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};

/** Only lexical statement framing; never executes SQL or interprets function bodies. */
export function splitColdProgramSqlStatementsV1(text){
  need(typeof text==='string'&&Buffer.byteLength(text)<=4*1024**2&&!text.includes('\0'),'COLD_PROGRAM_POLICY_SQL');
  const result=[];let statement='',quote=null,dollar=null,line=false,block=0;
  for(let index=0;index<text.length;index++){
    const char=text[index],next=text[index+1];
    if(line){if(char==='\n'){line=false;statement+=' ';}continue;}
    if(block){if(char==='/'&&next==='*'){block++;index++;}else if(char==='*'&&next==='/'){block--;index++;}continue;}
    if(dollar){if(text.startsWith(dollar,index)){statement+=dollar;index+=dollar.length-1;dollar=null;}else statement+=char;continue;}
    if(quote){statement+=char;if(char===quote){if(next===quote){statement+=next;index++;}else quote=null;}continue;}
    if(char==='-'&&next==='-'){line=true;statement+=' ';index++;continue;}
    if(char==='/'&&next==='*'){block=1;statement+=' ';index++;continue;}
    if(char==="'"||char==='"'){quote=char;statement+=char;continue;}
    if(char==='$'){const match=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(index));if(match){dollar=match[0];statement+=dollar;index+=dollar.length-1;continue;}}
    if(char===';'){if(statement.trim())result.push(statement.trim());statement='';}else statement+=char;
  }
  need(!quote&&!dollar&&!block,'COLD_PROGRAM_POLICY_UNCLOSED_SQL');if(statement.trim())result.push(statement.trim());return result;
}

function splitList(value){let depth=0,start=0;const result=[];for(let index=0;index<value.length;index++){const char=value[index];if(char==='(')depth++;if(char===')')need(--depth>=0,'COLD_PROGRAM_POLICY_TARGET');if(char===','&&depth===0){result.push(normalize(value.slice(start,index)));start=index+1;}}need(depth===0,'COLD_PROGRAM_POLICY_TARGET');result.push(normalize(value.slice(start)));need(result.every(Boolean),'COLD_PROGRAM_POLICY_TARGET');return result;}
function grantees(text){return splitList(text).map(value=>{const name=value.replace(/^"([a-z][a-z0-9_]*)"$/,'$1');need(name==='PUBLIC'||symbols.has(name),'COLD_PROGRAM_POLICY_ROLE');return name==='PUBLIC'?'public':symbols.get(name);});}
function functionTarget(value,schema){need(new RegExp('^'+schema+'\\.[a-z_][a-z0-9_]*\\([a-z0-9_, .\\[\\]]*\\)$').test(value),'COLD_PROGRAM_POLICY_FUNCTION_TARGET');return value.replace(/\s*,\s*/g,',').replace(/\(\s*/g,'(').replace(/\s*\)/g,')');}

/** Description of the exact trusted installer text. It is data, never a runtime permission. */
export function compileColdProgramPrivilegePolicyV1({schema,sql}){
  need(typeof schema==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(schema),'COLD_PROGRAM_POLICY_SCHEMA');
  const functions=new Map(),tables=new Map(),usage=new Set();let privilegeStatements=0,renames=0;
  const update=(map,target,actors,add)=>{if(!map.has(target))map.set(target,new Set());for(const actor of actors){if(actor==='public'){need(!add,'COLD_PROGRAM_POLICY_PUBLIC_GRANT');continue;}add?map.get(target).add(actor):map.get(target).delete(actor);}};
  for(const statement of splitColdProgramSqlStatementsV1(sql)){
    const rename=/^ALTER\s+FUNCTION\s+([\s\S]+?)\s+RENAME\s+TO\s+([a-z_][a-z0-9_]*)$/i.exec(statement);
    if(rename){const before=functionTarget(normalize(rename[1]),schema),after=schema+'.'+rename[2]+before.slice(before.indexOf('('));if(functions.has(before)){need(!functions.has(after),'COLD_PROGRAM_POLICY_RENAME_CONFLICT');functions.set(after,functions.get(before));functions.delete(before);}renames++;continue;}
    if(!/^(GRANT|REVOKE)\s/i.test(statement))continue;privilegeStatements++;
    let match=/^(GRANT|REVOKE)\s+(EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+FUNCTION\s+([\s\S]+?)\s+(TO|FROM)\s+([\s\S]+)$/i.exec(statement);
    if(match){const add=match[1].toUpperCase()==='GRANT';need((match[4].toUpperCase()==='TO')===add,'COLD_PROGRAM_POLICY_DIRECTION');need(!add||match[2].toUpperCase()==='EXECUTE','COLD_PROGRAM_POLICY_GRANT');const actors=grantees(match[5]);for(const target of splitList(match[3]))update(functions,functionTarget(target,schema),actors,add);continue;}
    match=/^(GRANT|REVOKE)\s+(USAGE|ALL)\s+ON\s+SCHEMA\s+([a-z][a-z0-9_]*)\s+(TO|FROM)\s+([\s\S]+)$/i.exec(statement);
    if(match){const add=match[1].toUpperCase()==='GRANT';need(match[3]===schema&&(match[4].toUpperCase()==='TO')===add&&(!add||match[2].toUpperCase()==='USAGE'),'COLD_PROGRAM_POLICY_SCHEMA_GRANT');for(const actor of grantees(match[5])){need(!add||actor!=='public','COLD_PROGRAM_POLICY_PUBLIC_GRANT');add?usage.add(actor):usage.delete(actor);}continue;}
    match=/^GRANT\s+SELECT\s+ON\s+(?:TABLE\s+)?([\s\S]+?)\s+TO\s+([\s\S]+)$/i.exec(statement);
    if(match){const actors=grantees(match[2]);for(const target of splitList(match[1])){need(new RegExp('^'+schema+'\\.[a-z_][a-z0-9_]*$').test(target),'COLD_PROGRAM_POLICY_TABLE_TARGET');update(tables,target,actors,true);}continue;}
    match=/^REVOKE\s+ALL\s+ON\s+ALL\s+(TABLES|SEQUENCES|FUNCTIONS)\s+IN\s+SCHEMA\s+([a-z][a-z0-9_]*)\s+FROM\s+PUBLIC$/i.exec(statement);
    if(match){need(match[2]===schema,'COLD_PROGRAM_POLICY_REVOKE_SCHEMA');continue;}
    match=/^REVOKE\s+ALL\s+ON\s+TABLE\s+([a-z][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+FROM\s+PUBLIC$/i.exec(statement);
    if(match){need(match[1].startsWith(schema+'.'),'COLD_PROGRAM_POLICY_TABLE_TARGET');continue;}
    throw Object.assign(Error('COLD_PROGRAM_POLICY_UNSUPPORTED_PRIVILEGE'),{code:'COLD_PROGRAM_POLICY_UNSUPPORTED_PRIVILEGE'});
  }
  const entries=map=>[...map].filter(([,actors])=>actors.size).map(([target,actors])=>({target,roles:[...actors].sort()})).sort((a,b)=>a.target.localeCompare(b.target));
  const body={format:'COLD_MAP_PROGRAM_PRIVILEGE_POLICY_V1',schema,installerSqlSha256:hash(sql),schemaUsageRoles:[...usage].filter(value=>value!=='public').sort(),tableSelect:entries(tables),functionExecute:entries(functions),privilegeStatements,renames,ownerImplicitPrivilegesSeparate:true,allOtherOrdinaryRolePrivilegesDenied:true,noRuntimeGrantOptions:true,noExplicitColumnGrants:true,defaultAclPolicyNotInferred:true,sourceTextDescriptionOnly:true,actualPrivilegesVerified:false,authorizationGranted:false,fullRegisteredRoleMatrixVerified:false};return freeze({...body,sha256:hash(body)});
}

let loading;
/** Fixed real R4 installers only; arbitrary caller SQL cannot mint this bundle. */
export function loadColdMapProgramPrivilegePoliciesV1(){return loading??=(async()=>{
  const options={tenant:'qa',owner:roles.owner,worker:roles.worker,ingress:roles.ingress,deployment:'c'.repeat(64)},inputs=[['state_map_v1',()=>stateMapSchemaSqlV4({tenant:'qa',owner:roles.owner,app:roles.worker,reader:roles.reader})],['governance_jobs_v4',()=>governanceConsoleSchemaSqlV4(options)],['maintenance_jobs_v4',()=>maintenanceJobsSchemaSqlV4(options)],['predictive_jobs_v4',()=>predictiveJobsSchemaSqlV4R2(options)],['reconciliation_jobs_v1',()=>predictiveCancelUiSchemaSqlV1(options)]];
  const policies=[];for(const [schema,build] of inputs)policies.push(compileColdProgramPrivilegePolicyV1({schema,sql:await build()}));return Object.freeze(policies);
})();}

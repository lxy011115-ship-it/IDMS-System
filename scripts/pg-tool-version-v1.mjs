/** Preserve the complete reported version. Package labels never replace executable SHA pins. */
export function isPostgres16ToolVersionV1(value){
 if(typeof value!=='string'||value.length>224)return false;
 const match=/^postgres \(PostgreSQL\) (16\.\d+(?:\.\d+)?)(?: \((Ubuntu|Debian) ([A-Za-z0-9.+:~_-]+)\))?$/.exec(value);
 if(!match||match[0]!==value)return false;
 if(!match[2])return true;
 const packaged=match[3].replace(/^\d+:/,'');
 return packaged===match[1]||['-','+','~'].some(separator=>packaged.startsWith(match[1]+separator));
}

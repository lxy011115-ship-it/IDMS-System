// PostgreSQL supplies backend_type/leader_pid; an application_name never grants
// permission. Autovacuum changes physical maintenance state, not business rows.
export function reviewSessionAllowed(row,{rootPid,readerPid,backupOid}){
 if(row.backend_type==='autovacuum worker')return true;
 if(row.backend_type==='parallel worker'&&[rootPid,readerPid].includes(row.leader_pid))return true;
 return row.usesysid===backupOid;
}

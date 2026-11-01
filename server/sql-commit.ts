import {DomainError} from './service.ts';
export class CommitUnconfirmedError extends DomainError {
 readonly code='COMMIT_UNCONFIRMED';
 constructor(){super(503,'提交结果尚未确认，请使用原事件或原幂等键核对结果');}
}
/** A rejected COMMIT promise cannot establish whether the server committed.
 * Never retry a new business event or turn it into a definitive rejection. */
export async function confirmCommit(client:{query:(sql:string)=>Promise<unknown>}){
 try{await client.query('COMMIT');}catch{throw new CommitUnconfirmedError();}
}

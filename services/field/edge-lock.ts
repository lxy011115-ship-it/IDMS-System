import net from 'node:net';
import {createHash} from 'node:crypto';
import {fieldSource} from '../../integrations/field-profile.ts';
import {fieldFailure} from './error.ts';

export class FieldEdgeLock {
 readonly #name:string;#server:net.Server|null=null;#job:Promise<void>|null=null;#close:Promise<void>|null=null;#closing=false;#held=false;
 constructor(source:unknown){const s=fieldSource(source),id=createHash('sha256').update(JSON.stringify([s.tenantId,s.edgeId])).digest('hex');if(process.platform!=='win32'&&process.platform!=='linux')fieldFailure('FIELD_EDGE_LOCK_PLATFORM_UNSUPPORTED');this.#name=process.platform==='win32'?'\\\\.\\pipe\\idms-field-'+id:'\0idms-field-'+id;}
 get held(){return this.#held&&!this.#closing;}
 async acquire(){if(this.#server||this.#closing)fieldFailure('FIELD_EDGE_LOCK_BUSY');const server=this.#server=net.createServer(socket=>socket.destroy());server.maxConnections=8;server.on('error',()=>{this.#held=false;});const job=new Promise<void>((ok,no)=>{const fail=()=>{server.off('listening',ready);no(Error());},ready=()=>{server.off('error',fail);this.#held=true;ok();};server.once('error',fail);server.once('listening',ready);server.listen({path:this.#name,exclusive:true});});this.#job=job;try{await job;if(this.#closing)fieldFailure('FIELD_EDGE_LOCK_CLOSED');}catch{fieldFailure('FIELD_EDGE_ALREADY_RUNNING');}finally{if(this.#job===job)this.#job=null;}}
 async close(){if(this.#close)return this.#close;this.#closing=true;this.#held=false;const job=Promise.resolve().then(async()=>{await this.#job?.catch(()=>{});const server=this.#server;if(server?.listening)await new Promise<void>((ok,no)=>server.close(e=>e?no(e):ok()));this.#server=null;});this.#close=job;return job;}
}

import {createServer} from 'node:http';
import {loadSiteConsoleRuntimeV4} from '../server/site-console-runtime-v4.ts';
import {createSiteConsoleHttpV4} from '../server/site-console-http-v4.ts';
async function main(){
 if(process.argv.length!==3)throw Error('SITE_RUNTIME_ARGUMENTS');const runtime=await loadSiteConsoleRuntimeV4(process.argv[2]);let server,stopping=false;const stop=()=>{stopping=true;server?.close();};for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);process.on('message',m=>{if(m?.type==='SITE_CONSOLE_STOP')stop();});
 try{const handler=await createSiteConsoleHttpV4(runtime);if(stopping)return;server=createServer((req,res)=>{handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503,{'cache-control':'no-store'});res.end();});});server.requestTimeout=30000;server.headersTimeout=15000;await new Promise((ok,no)=>{server.once('error',no);server.listen(runtime.config.port,runtime.config.host,ok);});console.log(JSON.stringify({event:'SITE_CONSOLE_HTTP_READY',port:runtime.config.port,tenants:[...runtime.members.keys()]}));await new Promise(ok=>server.once('close',ok));}
 finally{if(server?.listening)await new Promise(ok=>server.close(ok));await runtime.close();if(process.connected)process.disconnect();}
}
main().catch(()=>{console.error('SITE_CONSOLE_RUNTIME_FAILED');if(process.connected)process.disconnect();process.exitCode=1;});

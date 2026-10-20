import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {analyze,modelVersion} from './model.ts';
/** The frozen rule model, with an explicit private runtime and drainable lifecycle. */
export function createPredictorServiceV4(serviceToken:string){
 if(typeof serviceToken!=='string'||serviceToken.length<32||serviceToken.length>4096||/[\r\n]/.test(serviceToken))throw Error('PREDICTOR_SERVICE_CREDENTIAL');const expected=Buffer.from('Bearer '+serviceToken);
 const server=createServer({maxHeaderSize:16384,requestTimeout:15000,headersTimeout:10000},async(req,res)=>{const reply=(status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};if(req.method==='GET'&&req.url==='/health'){reply(200,{status:'UP',modelVersion,algorithm:'engineering-rule',rulAvailable:false});return;}const token=Buffer.from(String(req.headers.authorization||''));if(token.length!==expected.length||!timingSafeEqual(token,expected)){reply(401,{error:'PREDICTOR_UNAUTHORIZED'});return;}if(req.method!=='POST'||req.url!=='/v1/analyze'){reply(404,{error:'PREDICTOR_NOT_FOUND'});return;}
  try{const parts:Buffer[]=[];let bytes=0;for await(const b of req){bytes+=b.length;if(bytes>256*1024){res.setHeader('connection','close');reply(413,{error:'PREDICTOR_INPUT_LIMIT'});return;}parts.push(b);}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='points'){reply(400,{error:'PREDICTOR_INPUT'});return;}reply(200,analyze(value.points));}catch{if(!res.headersSent)reply(422,{error:'PREDICTOR_RULE_INPUT_INVALID'});else res.destroy();}
 });return server;
}

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { analyze, modelVersion } from './model.ts';
let token=process.env.IDMS_SERVICE_TOKEN;
if(!token)try{token=(await readFile('.local/service-token','utf8')).trim();}catch{}
if(!token||token.length<32)throw Error('Predictor requires a private service token of at least 32 characters');
const expected=Buffer.from('Bearer '+token);
const server=createServer(async(req,res)=>{
  const reply=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method==='GET'&&req.url==='/health')return reply(200,{status:'UP',modelVersion,algorithm:'engineering-rule',rulAvailable:false});
  const supplied=Buffer.from(String(req.headers.authorization||''));
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(401,{error:'Unauthorized service request'});
  if(req.method!=='POST'||req.url!=='/v1/analyze')return reply(404,{error:'Not found'});
  try{
    let length=0;const chunks=[];
    for await(const chunk of req){length+=chunk.length;if(length>256*1024)return reply(413,{error:'Input too large'});chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return reply(200,analyze(input.points));
  }catch(e){return reply(422,{error:e instanceof Error?e.message:'Invalid input'});}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(Number(process.env.PREDICTOR_PORT||4012),'127.0.0.1',()=>console.log('IDMS independent predictor listening on loopback'));

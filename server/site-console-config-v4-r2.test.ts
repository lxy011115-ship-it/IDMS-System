import test from 'node:test';
import assert from 'node:assert/strict';
import {siteConsoleConfigV4R2,sitePredictiveHttpMemberV4R2} from './site-console-config-v4-r2.ts';
import {siteConsoleShellV4R2} from './site-console-http-v4-r2.ts';
const config=()=>({format:2,purpose:'SITE_CONSOLE_HTTP_R2',baseSiteRuntimeFile:'site.private.json',predictiveRuntimeFiles:['a.private.json','b.private.json']});
test('r2 composition rejects ambiguous or incomplete references and unexpected inline runtime or listener fields',()=>{
 const raw=config(),v=siteConsoleConfigV4R2(raw);raw.predictiveRuntimeFiles[0]='changed';assert.equal(v.predictiveRuntimeFiles[0],'a.private.json');
 for(const bad of [{...config(),format:1},{...config(),host:'0.0.0.0'},{...config(),predictiveRuntimeFiles:[]},{...config(),predictiveRuntimeFiles:Array(33).fill('a')},{...config(),predictiveRuntimeFiles:['a','a']},{...config(),predictiveRuntimeFiles:['site.private.json']},{...config(),predictiveRuntimeFiles:['bad\u0000file']}])assert.throws(()=>siteConsoleConfigV4R2(bad),/SITE_R2_CONFIG/);
});
test('r2 predictive members reject service materials and worker mode before invoking an authenticated loader',()=>{
 const v={format:1,mode:'HTTP',auth:{mode:'oidc'},authRuntimeFile:'auth.json',jobKeyFile:'jobs.json',business:{},queue:{}};assert.equal(sitePredictiveHttpMemberV4R2(v),v);
 for(const k of ['workflow','predictor','sources','aiRuntimeFile','serviceToken'])assert.throws(()=>sitePredictiveHttpMemberV4R2({...v,[k]:'private-value'}),e=>e instanceof Error&&e.message==='SITE_R2_HTTP_ONLY');
 for(const bad of [{...v,mode:'WORKER'},{...v,host:'0.0.0.0'},{...v,port:65536},{...v,authRuntimeFile:'x\n'},{...v,auth:{mode:'demo'}}])assert.throws(()=>sitePredictiveHttpMemberV4R2(bad),/SITE_R2_/);
});
test('r2 shell fails closed when the frozen HTML boundary is ambiguous and adds all module routes once',()=>{
 const html='<html><head></head><body><header>Header</header><main>Body</main></body></html>',out=siteConsoleShellV4R2(html).toString();
 for(const href of ['/','/governance/','/predictive/','/maintenance/'])assert.equal(out.split('href="'+href+'"').length,2);
 assert.equal(out.includes('<main>Body</main>'),true);
 for(const invalid of [html.replace('</head>',''),html.replace('</header>',''),html.replace('</header>','</header></header>')])assert.throws(()=>siteConsoleShellV4R2(invalid),/SITE_R2_STATIC_SHELL_VERSION/);
});

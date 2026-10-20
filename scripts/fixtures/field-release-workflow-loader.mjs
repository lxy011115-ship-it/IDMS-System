import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const catalog=pathToFileURL(resolve('scripts/verify-catalog.mjs')).href;
if(process.env.IDMS_FIELD_RELEASE_REGRESSION_QA!=='1'||pathToFileURL(resolve(process.argv[1]||'')).href!==catalog)throw Error('Explicit owned catalog release regression required');
// Preserve the frozen production workflow launcher and original jars. Only
// this existing QA command uses an explicitly isolated Java build/launcher.
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===catalog&&specifier==='./workflow-local.mjs')return {url:new URL('./field-release-workflow-adapter.mjs',import.meta.url).href,shortCircuit:true};
 return next(specifier,context);
}});

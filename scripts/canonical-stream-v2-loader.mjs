// Explicit --import entry for an isolated or separately prepared runtime.
// Original source modules remain byte-for-byte intact.
import {registerHooks} from 'node:module';
const original=new URL('../server/canonical-state.ts',import.meta.url).href,replacement=new URL('../server/canonical-stream-v2.ts',import.meta.url).href;
registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);return result.url===original&&context.parentURL!==replacement?{...result,url:replacement}:result;}});

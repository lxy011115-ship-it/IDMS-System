import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url),old=new URL('scripts/fixtures/predictive-legacy-sdk-20261020/',root);
// Execute exact saved old modules. Only missing unchanged dependencies resolve to canonical sources.
registerHooks({resolve(specifier,context,next){if(context.parentURL?.startsWith(old.href)&&specifier.startsWith('.')){const target=new URL(specifier,context.parentURL);if(target.href.startsWith(old.href)&&!existsSync(fileURLToPath(target)))return next(new URL(target.href.slice(old.href.length),root).href,context);}return next(specifier,context);}});

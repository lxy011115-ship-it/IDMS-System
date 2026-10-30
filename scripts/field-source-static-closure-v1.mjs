import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.argv.length,4);assert.equal(typeof vm.SourceTextModule,'function');
const root=resolve(process.argv[2]),input=JSON.parse(await readFile(process.argv[3],'utf8'));assert.equal(input.format,'FIELD_SOURCE_STATIC_GRAPH_V1');assert(Array.isArray(input.paths)&&input.paths.length<=4096&&Array.isArray(input.roots)&&input.roots.length>0);
const allowed=new Set(input.paths),paths=new Set(input.roots),visited=new Set(),queue=[...input.roots];let bytes=0;for(const p of allowed){assert(typeof p==='string'&&!isAbsolute(p));const part=relative(root,resolve(root,p));assert(part&&!part.startsWith('..')&&!isAbsolute(part));}for(const p of queue)assert(allowed.has(p));
for(const path of queue){if(visited.has(path)||!/\.(mjs|ts)$/.test(path))continue;visited.add(path);const data=await readFile(resolve(root,path));assert(data.length<=2*1024**2);bytes+=data.length;assert(bytes<=64*1024**2);const source=path.endsWith('.ts')?stripTypeScriptTypes(data.toString('utf8'),{mode:'transform',sourceUrl:path}):data.toString('utf8'),module=new vm.SourceTextModule(source,{identifier:path});for(const specifier of module.dependencySpecifiers){if(!specifier.startsWith('.')||!/\.(mjs|ts|sql)$/.test(specifier))continue;const p=relative(root,resolve(dirname(resolve(root,path)),specifier)).split(String.fromCharCode(92)).join('/');assert(allowed.has(p),'STATIC_CLOSURE_UNPINNED_DEPENDENCY');paths.add(p);if(!visited.has(p))queue.push(p);}}
console.log(JSON.stringify({format:'FIELD_SOURCE_STATIC_CLOSURE_RESULT_V1',parsedModules:visited.size,paths:[...paths].sort(),allowedInputPaths:allowed.size,productModulesLinkedOrEvaluated:false,returnedPathsAreActualRelativeImportClosure:true}));

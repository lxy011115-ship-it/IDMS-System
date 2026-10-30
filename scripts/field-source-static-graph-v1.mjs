// This helper compiles source for static imports. It never links or evaluates it.
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.argv.length,4);assert.equal(typeof vm.SourceTextModule,'function');
const root=resolve(process.argv[2]),input=JSON.parse(await readFile(process.argv[3],'utf8'));
assert(input.format==='FIELD_SOURCE_STATIC_GRAPH_V1'&&Array.isArray(input.paths)&&input.paths.length<=4096);
const paths=new Set(input.paths),visited=new Set();assert(Array.isArray(input.roots)&&input.roots.length>0&&input.roots.every(p=>paths.has(p)));const queue=[...input.roots];let bytes=0;
for(const path of paths){assert(typeof path==='string'&&!isAbsolute(path));const rel=relative(root,resolve(root,path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));}
for(const path of queue){
 assert(paths.size<=4096);if(visited.has(path)||!/\.(mjs|ts)$/.test(path))continue;visited.add(path);
 const data=await readFile(resolve(root,path));assert(data.length<=2*1024**2);bytes+=data.length;assert(bytes<=64*1024**2);
 const source=path.endsWith('.ts')?stripTypeScriptTypes(data.toString('utf8'),{mode:'transform',sourceUrl:path}):data.toString('utf8');
 const module=new vm.SourceTextModule(source,{identifier:path});
 for(const specifier of module.dependencySpecifiers){
  if(!specifier.startsWith('.')||!/\.(mjs|ts|sql)$/.test(specifier))continue;
  const rel=relative(root,resolve(dirname(resolve(root,path)),specifier)).replaceAll('\\','/');assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));paths.add(rel);if(!visited.has(rel))queue.push(rel);
 }
}
console.log(JSON.stringify({format:'FIELD_SOURCE_STATIC_GRAPH_RESULT_V1',parsedModules:visited.size,paths:[...paths].sort(),productModulesLinkedOrEvaluated:false}));

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import archiver from 'archiver';
await mkdir('outputs',{recursive:true});
const target='outputs/IDMS手动上传演示包.zip', output=createWriteStream(target), archive=archiver('zip',{zlib:{level:6}});
const complete=new Promise((resolve,reject)=>{output.on('close',resolve);output.on('error',reject);archive.on('error',reject);});
archive.pipe(output);
for(const dir of ['server','services','public','src','scripts','docs','integrations','infra'])archive.directory(dir,dir);
for(const file of ['package.json','package-lock.json','README.md','openapi.yaml','docker-compose.yml','.env.example','启动演示.cmd','启动IDMS.cmd'])archive.file(file,{name:file});
archive.directory('outputs/demo-data','outputs/demo-data');archive.directory('outputs/demo-preview','outputs/demo-preview');
// Never distribute local customer snapshots, credentials, sessions or identity-runtime data.
// Synthetic fixtures are already included above; a package starts with its own empty import history.
for(const item of await readdir('node_modules',{withFileTypes:true})){
  if(['.bin','.cache','playwright','playwright-core'].includes(item.name))continue;
  if(item.isDirectory())archive.directory(join('node_modules',item.name),join('node_modules',item.name));
}
await archive.finalize();await complete;
console.log(`${target}: ${((await stat(target)).size/1024/1024).toFixed(2)} MiB, production dependencies included, Node.js 24 required.`);

import {readFileSync} from 'node:fs';

// Resolve against this module, independent of the launcher's current directory.
const metadata=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
if(typeof metadata.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version))throw Error('Invalid application package version');
export const applicationVersion:string=metadata.version;

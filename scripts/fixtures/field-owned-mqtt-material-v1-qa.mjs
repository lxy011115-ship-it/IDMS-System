import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,X509Certificate} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fieldMqttDeclaration} from './field-mqtt-fixture.mjs';
import {fieldMqttClientId,fieldSha256} from '../../integrations/field-profile.ts';

// Cross-platform certificate files only. No daemon, listener or database.
export async function fieldOwnedMqttMaterialFixtureV1(source,directory){
  const exec=promisify(execFile),openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'/usr/bin/openssl';
  const run=args=>exec(openssl,args,{windowsHide:true,maxBuffer:1048576});
  await run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',resolve(directory,'ca.key'),'-out',resolve(directory,'ca.pem'),'-days','3','-sha256','-subj','/CN=IDMS owned lifecycle QA CA','-addext','basicConstraints=critical,CA:true,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  let serial=1;
  for(const [name,cn,purpose]of [['broker','localhost','serverAuth'],['edge',fieldMqttClientId(source,'EDGE'),'clientAuth'],['platform',fieldMqttClientId(source,'PLATFORM'),'clientAuth']]){
    await run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',resolve(directory,name+'.key'),'-out',resolve(directory,name+'.csr'),'-subj','/CN='+cn]);
    await writeFile(resolve(directory,name+'.ext'),'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage='+purpose+'\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
    await run(['x509','-req','-in',resolve(directory,name+'.csr'),'-CA',resolve(directory,'ca.pem'),'-CAkey',resolve(directory,'ca.key'),'-set_serial',String(++serial),'-out',resolve(directory,name+'.pem'),'-days','2','-sha256','-extfile',resolve(directory,name+'.ext')]);
  }
  const digest=async name=>fieldSha256(new X509Certificate(await readFile(resolve(directory,name+'.pem'))).raw),eventKey=randomBytes(32);
  const pins={caCertificateSha256:await digest('ca'),serverCertificateSha256:await digest('broker'),edgeCertificateSha256:await digest('edge'),platformCertificateSha256:await digest('platform'),eventKeySha256:fieldSha256(eventKey)};
  return {eventKey,declaration:url=>fieldMqttDeclaration(source,{...pins,brokerUrlSha256:fieldSha256(url)})};
}

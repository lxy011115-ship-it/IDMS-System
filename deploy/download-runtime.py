"""Download the public, hash-pinned runtime cache with resumable HTTPS ranges."""
import concurrent.futures,hashlib,pathlib,time,urllib.request

URL='https://github.com/lxy011115-ship-it/IDMS-System/releases/download/deployment-dependency-keycloak-26.8.1/keycloak-26.8.1-verified.tar.gz'
SIZE=303344814
SHA='b92c40470a40dbf57c2826545916d97a1004c33d4f162c8f692ae3c696849ea5'
root=pathlib.Path('/srv/idms/downloads/keycloak-ranges');root.mkdir(mode=0o700,exist_ok=True)
request=urllib.request.Request(URL,headers={'Range':'bytes=0-0','User-Agent':'IDMS-runtime-download'})
with urllib.request.urlopen(request,timeout=30) as response:
    if response.status!=206 or response.headers.get('Content-Range')!='bytes 0-0/'+str(SIZE):raise RuntimeError('Runtime server does not support verified byte ranges')
    resolved=response.geturl()
    if not resolved.startswith('https://'):raise RuntimeError('Runtime requires HTTPS')
chunks=16
def part(index):
    start=SIZE*index//chunks;end=SIZE*(index+1)//chunks-1;target=root/str(index)
    for attempt in range(6):
        have=target.stat().st_size if target.exists() else 0
        if have==end-start+1:return target
        if have>end-start+1:raise RuntimeError('Unexpected partial runtime size')
        try:
            req=urllib.request.Request(resolved,headers={'Range':'bytes='+str(start+have)+'-'+str(end),'User-Agent':'IDMS-runtime-download'})
            with urllib.request.urlopen(req,timeout=45) as response:
                if response.status!=206 or response.headers.get('Content-Range')!='bytes '+str(start+have)+'-'+str(end)+'/'+str(SIZE):raise RuntimeError('Unexpected runtime range response')
                with target.open('ab') as out:
                    count=have
                    while True:
                        data=response.read(min(262144,end-start+1-count))
                        if not data:break
                        out.write(data);count+=len(data)
                        if count==end-start+1:break
            if target.stat().st_size==end-start+1:
                print('RUNTIME_PART_VERIFIED_LENGTH',index,flush=True);return target
        except Exception as error:
            print('RUNTIME_PART_RETRY',index,attempt,type(error).__name__,flush=True)
        time.sleep(min(attempt+1,5))
    raise RuntimeError('Runtime range retries exhausted: '+str(index))
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
    paths=list(pool.map(part,range(chunks)))
output=root/'keycloak-26.8.1-verified.tar.gz';h=hashlib.sha256()
with output.open('xb') as out:
    for path in paths:
        with path.open('rb') as source:
            while True:
                data=source.read(1048576)
                if not data:break
                h.update(data);out.write(data)
if output.stat().st_size!=SIZE or h.hexdigest()!=SHA:raise RuntimeError('Runtime archive checksum mismatch')
print('RUNTIME_ARCHIVE_SHA256_VERIFIED',str(output),flush=True)

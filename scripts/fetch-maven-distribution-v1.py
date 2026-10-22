"""Fetch the pinned official public distribution into a new directory only."""
from pathlib import Path, PurePosixPath
import argparse, hashlib, json, os, tarfile, tempfile, urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('parent')
parser.add_argument('--github-output')
args=parser.parse_args()
manifest=json.loads(Path(__file__).with_name('maven-distribution-v1.json').read_text(encoding='utf-8'))
assert manifest['version']=='3.9.11'
assert manifest['archiveUrl']=='https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz'
parent=Path(args.parent).resolve(strict=True)
assert parent.is_dir() and not any(ord(c)<32 for c in str(parent))
fd,name=tempfile.mkstemp(prefix='idms-maven-download-',suffix='.tar.gz',dir=parent)
archive=Path(name)
try:
    digest=hashlib.sha512();size=0
    request=urllib.request.Request(manifest['archiveUrl'],headers={'User-Agent':'IDMS-official-distribution-fetch'})
    with os.fdopen(fd,'wb') as output,urllib.request.urlopen(request,timeout=60) as response:
        while True:
            block=response.read(1024*1024)
            if not block:break
            size+=len(block)
            assert size<=manifest['archiveBytes'],'Distribution size exceeded the pinned release asset'
            digest.update(block);output.write(block)
        output.flush();os.fsync(output.fileno())
    assert size==manifest['archiveBytes'] and digest.hexdigest()==manifest['archiveSha512'],'Distribution SHA-512 or length mismatch'
    top='apache-maven-'+manifest['version'];total=0
    with tarfile.open(archive,'r:gz') as bundle:
        members=bundle.getmembers();assert len(members)<=10000
        for member in members:
            parts=PurePosixPath(member.name).parts
            assert parts and parts[0]==top and '..' not in parts and not member.name.startswith('/')
            assert '\\' not in member.name and not any(ord(c)<32 for c in member.name)
            assert member.isdir() or member.isfile(),'Links and special files are not allowed'
            assert 0<=member.size<=32*1024**2
            if member.isfile():total+=member.size
        assert total<=64*1024**2
        destination=Path(tempfile.mkdtemp(prefix='idms-maven-',dir=parent))
        bundle.extractall(destination,members=members,filter='data')
    directory=destination/top
    assert directory.is_dir()
    if args.github_output:
        with Path(args.github_output).open('a',encoding='utf-8') as output:output.write('directory='+str(directory)+'\n')
    print(json.dumps({'directory':str(directory),'version':manifest['version'],'archiveSha512':digest.hexdigest(),'archiveBytes':size,'officialAssetVerified':True,'existingDirectoryOverwritten':False}))
finally:
    archive.unlink(missing_ok=True)

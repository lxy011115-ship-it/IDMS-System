from pathlib import Path
import argparse,hashlib,json,os,platform,re,subprocess,uuid

parser=argparse.ArgumentParser(description='Extract one repository-authenticated Ubuntu Mosquitto package without installing or starting its service')
parser.add_argument('parent');parser.add_argument('--github-output',required=True);args=parser.parse_args()
assert platform.system()=='Linux'and platform.machine()=='x86_64'
parent=Path(args.parent).resolve(strict=True);assert parent.is_dir()
work=parent/('idms-mosquitto-'+str(uuid.uuid4()));work.mkdir(mode=0o700);assert work.resolve().parent==parent
def run(argv,**kwargs):return subprocess.check_output(argv,encoding='utf8',**kwargs)
metadata=run(['apt-cache','show','--no-all-versions','mosquitto']);records=[]
for block in metadata.strip().split('\n\n'):
    row={}
    for line in block.splitlines():
        if line and not line[0].isspace()and ': 'in line:
            key,value=line.split(': ',1);row[key]=value
    if row.get('Package')=='mosquitto'and row.get('Architecture')=='amd64':records.append(row)
assert len(records)==1;metadata=records[0];version=metadata['Version'];assert re.fullmatch(r'[0-9][A-Za-z0-9.+:~_-]{0,100}',version)and re.fullmatch(r'[a-f0-9]{64}',metadata['SHA256'])
run(['apt-get','download','mosquitto='+version],cwd=work)
packages=list(work.glob('*.deb'));assert len(packages)==1;archive=packages[0];archive_sha=hashlib.sha256(archive.read_bytes()).hexdigest();assert archive_sha==metadata['SHA256']
assert run(['dpkg-deb','--field',str(archive),'Package']).strip()=='mosquitto'and run(['dpkg-deb','--field',str(archive),'Version']).strip()==version and run(['dpkg-deb','--field',str(archive),'Architecture']).strip()=='amd64'
destination=work/'extracted';destination.mkdir(mode=0o700);assert destination.resolve().parent==work.resolve()
run(['dpkg-deb','--extract',str(archive),str(destination)])
program=destination/'usr/sbin/mosquitto';assert program.is_file()and not program.is_symlink()and program.stat().st_nlink==1 and os.access(program,os.X_OK)
program_sha=hashlib.sha256(program.read_bytes()).hexdigest()
result={'format':'IDMS_MOSQUITTO_UBUNTU_PACKAGE_V1','version':version,'architecture':'amd64','packageSha256':archive_sha,'programSha256':program_sha,'program':str(program),'packageInstalled':False,'serviceStarted':False}
(work/'verification.json').write_text(json.dumps(result,indent=2),encoding='utf8')
with Path(args.github_output).open('a',encoding='utf8')as output:
    output.write('directory='+str(program.parent)+'\nsha256='+program_sha+'\npackage_sha256='+archive_sha+'\nversion='+version+'\n')
print(json.dumps(result))

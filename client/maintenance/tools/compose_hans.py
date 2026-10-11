"""Build the reviewed Hans localization and window policy together through the audited unified profile."""
import argparse,subprocess,sys
from pathlib import Path
def main():
    p=argparse.ArgumentParser(description='Audited unified 2.19.1 build; external --source/--base are retired.')
    p.add_argument('--prepare-only',action='store_true')
    p.add_argument('--root',type=Path)
    args=p.parse_args()
    command=[sys.executable,str(Path(__file__).with_name('maintain.py')),'--prepare' if args.prepare_only else '--queue']
    if args.root:command += ['--root',str(args.root.resolve())]
    raise SystemExit(subprocess.call(command,creationflags=subprocess.CREATE_NO_WINDOW))
if __name__=='__main__':main()

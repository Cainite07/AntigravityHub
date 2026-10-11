"""Windows maintenance coordinator. No terminate/kill/restart commands.

Preparation may run in the client session. Deployment runs independently after
all processes from the exact installation path have exited, or before launch.
"""
import argparse
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from ctypes import wintypes

HERE = Path(__file__).resolve().parent
STATE = Path(os.environ.get('ANTIGRAVITY_MAINTENANCE_STATE', HERE.parent / 'state')).resolve()
DEFAULT_ROOT = Path(os.environ['LOCALAPPDATA']) / 'Programs/antigravity'
NO_WINDOW = 0x08000000
k = ctypes.WinDLL('kernel32', use_last_error=True)

class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
                ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]

k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
k.Process32NextW.argtypes = k.Process32FirstW.argtypes
k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k.OpenProcess.restype = wintypes.HANDLE
k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
k.WaitForSingleObject.restype = wintypes.DWORD
k.CloseHandle.argtypes = [wintypes.HANDLE]
k.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
k.CreateMutexW.restype = wintypes.HANDLE
k.ReleaseMutex.argtypes = [wintypes.HANDLE]
k.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]

def process_stamp(handle):
    values = [wintypes.FILETIME() for _ in range(4)]
    if not k.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime

def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    stage.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(stage, path)

def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def emit(value):
    if sys.stdout:
        print(json.dumps(value, ensure_ascii=False))

@contextlib.contextmanager
def mutex(root, purpose='deploy', timeout=60000):
    key = hashlib.sha256(str(root).lower().encode('utf-8')).hexdigest()[:24]
    handle = k.CreateMutexW(None, False, 'Local\\AntigravityMaintenance-' + purpose + '-' + key)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    acquired = False
    try:
        result = k.WaitForSingleObject(handle, timeout)
        acquired = result in (0, 0x80)
        if not acquired:
            raise RuntimeError('Another maintenance operation is active')
        yield
    finally:
        if acquired:
            k.ReleaseMutex(handle)
        k.CloseHandle(handle)

def running(root):
    expected = str(root / 'Antigravity.exe').lower()
    snapshot = k.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    found = []
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(entry)
        more = k.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            if entry.szExeFile.lower() == 'antigravity.exe':
                handle = k.OpenProcess(0x1000, False, entry.th32ProcessID)
                if handle:
                    try:
                        buffer = ctypes.create_unicode_buffer(32768)
                        size = wintypes.DWORD(len(buffer))
                        if not k.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        if buffer.value.lower() == expected:
                            found.append(entry.th32ProcessID)
                    finally:
                        k.CloseHandle(handle)
                elif ctypes.get_last_error() not in (87,):
                    raise RuntimeError('Cannot verify process identity; deployment refused')
            more = k.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        k.CloseHandle(snapshot)
    return found

def wait_for_exit(root, deadline):
    while time.time() < deadline:
        pids = running(root)
        if not pids:
            # Allow renderer exit and ordinary official-updater relaunch to settle.
            time.sleep(3)
            if not running(root):
                return
            continue
        handles = []
        try:
            for pid in pids:
                handle = k.OpenProcess(0x100000 | 0x1000, False, pid)
                if handle:
                    handles.append(handle)
            # Wait on a kernel process handle, not UI polling. Check expiry between waits.
            if handles:
                k.WaitForSingleObject(handles[0], min(30000, max(1, int((deadline - time.time()) * 1000))))
            else:
                time.sleep(1)
        finally:
            for handle in handles:
                k.CloseHandle(handle)
    raise RuntimeError('Queued maintenance expired; no client process was stopped')

def node_tool(*args):
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js >=22.12 is required')
    result = subprocess.run([node, str(HERE / 'prepare.cjs'), *map(str, args)],
                            capture_output=True, text=True, encoding='utf-8', errors='replace',
                            stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return json.loads(result.stdout.strip())

def validate_unpacked(root, manifest):
    base = root / 'resources/app.asar.unpacked'
    for item in manifest:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts or ':' in str(relative):
            raise RuntimeError('Unsafe sidecar path')
        target = base / relative
        if not target.is_file() or target.stat().st_size != item['size'] or sha(target) != item['sha256']:
            raise RuntimeError('Unpacked dependency changed: ' + item['path'])

def prepare(root):
    job = STATE / 'jobs' / uuid.uuid4().hex
    result = node_tool('--prepare', root / 'resources/app.asar', job)
    if result['status'] == 'already-installed':
        return None, result
    record = read(job / 'prepared.json')
    record.update(root=str(root), job=str(job), status='prepared', expiresAt=time.time() + 12 * 3600)
    save(job / 'job.json', record)
    return job, record

def deploy(root, job):
    record = read(job / 'job.json')
    archive = root / 'resources/app.asar'
    candidate = job / 'app.asar'
    if Path(record['root']) != root or Path(record['sourceArchive']) != archive:
        raise RuntimeError('Job belongs to another installation/source')
    if time.time() > record['expiresAt']:
        raise RuntimeError('Prepared job expired')
    current_hash = sha(archive)
    if sha(candidate) != record['after']:
        raise RuntimeError('Candidate changed; deployment refused')
    if current_hash == record['after']:
        validate_unpacked(root, record['unpacked'])
        record.update(status='already-installed-by-another-operation')
        save(job / 'job.json', record)
        return record
    if running(root):
        raise RuntimeError('Client is running; deferred deployment remains required')
    if current_hash != record['before']:
        raise RuntimeError('Source/candidate changed; stale job cancelled')
    validate_unpacked(root, record['unpacked'])
    verified = node_tool('--inspect', candidate)
    if not record.get('rollback') and (not verified['patched'] or verified['integrityIssues'] or
                                       (verified['version'] == '2.19.1' and not verified.get('unified'))):
        raise RuntimeError('Candidate no longer passes complete verification')
    backup = STATE / 'backups' / job.name
    backup.mkdir(parents=True, exist_ok=False)
    shutil.copy2(archive, backup / 'app.asar')
    sidecar = root / 'resources/app.asar.unpacked'
    if sidecar.exists():
        shutil.copytree(sidecar, backup / 'app.asar.unpacked')
    if sha(backup / 'app.asar') != record['before']:
        raise RuntimeError('Backup verification failed')
    for item in record['unpacked']:
        if sha(backup / 'app.asar.unpacked' / item['path']) != item['sha256']:
            raise RuntimeError('Backup sidecar verification failed')
    stage = archive.with_name('app.asar.maintenance-' + job.name)
    shutil.copy2(candidate, stage)
    try:
        if sha(stage) != record['after'] or sha(archive) != record['before'] or running(root):
            raise RuntimeError('Process/archive changed before commit')
        validate_unpacked(root, record['unpacked'])
        record.update(status='committing', backup=str(backup))
        save(job / 'job.json', record)
        # One ASAR replacement. Sidecar bytes are unchanged and checked before commit.
        os.replace(stage, archive)
        record.update(status='installed', installedAt=time.time())
        save(job / 'job.json', record)
        save(STATE / 'last-status.json', record)
        save(STATE / 'last-installation.json', record)
    finally:
        if stage.exists():
            stage.unlink()
    return record

def queue(root):
    with mutex(root):
        pending = STATE / 'pending.json'
        if pending.exists():
            active = read(pending)
            if active.get('root') == str(root) and active.get('expiresAt', 0) > time.time():
                pid = active.get('workerPid', 0)
                handle = k.OpenProcess(0x100000 | 0x1000, False, pid) if pid else None
                if handle:
                    try:
                        if k.WaitForSingleObject(handle, 0) == 0x102 and process_stamp(handle) == active.get('workerCreated'):
                            return {'status': 'already-queued', 'job': active['job']}
                    finally:
                        k.CloseHandle(handle)
        job, result = prepare(root)
        if not job:
            save(STATE / 'last-status.json', result)
            return result
        return submit(root, job, result)

def submit(root, job, result):
    # Caller holds the deployment mutex. Also used by the composed Hans build.
    if not running(root):
        return deploy(root, job)
    pythonw = Path(sys.executable).with_name('pythonw.exe')
    if not pythonw.exists():
        raise RuntimeError('pythonw.exe is required for an independent hidden worker')
    try:
        # A new process group alone does not escape a host's Windows Job Object.
        # Request breakaway; if the host forbids it, rely on the independent
        # desktop prelaunch path instead of claiming the worker will survive.
        child = subprocess.Popen([str(pythonw), str(HERE / 'maintain.py'), '--worker', str(job), '--root', str(root)],
                                 creationflags=NO_WINDOW | 0x200 | 0x01000000, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    except OSError as error:
        if error.winerror != 5:
            raise
        deferred = {'status': 'prepared-for-next-launch', 'root': str(root), 'job': str(job),
                    'reason': 'Host prevented an independent worker; desktop prelaunch will recheck/apply',
                    'expiresAt': result['expiresAt']}
        save(STATE / 'last-status.json', deferred)
        return deferred
    handle = k.OpenProcess(0x1000, False, child.pid)
    if not handle:
        raise RuntimeError('Worker did not remain running after launch')
    try:
        created = process_stamp(handle)
    finally:
        k.CloseHandle(handle)
    pending_value = {'status': 'queued', 'root': str(root), 'job': str(job),
                     'workerPid': child.pid, 'workerCreated': created, 'expiresAt': result['expiresAt']}
    save(STATE / 'pending.json', pending_value)
    save(STATE / 'last-status.json', pending_value)
    return pending_value

def worker(root, job):
    try:
        with mutex(root, 'worker', timeout=0):
            record = read(job / 'job.json')
            wait_for_exit(root, record['expiresAt'])
            with mutex(root):
                return deploy(root, job)
    except Exception as error:
        status = {'status': 'failed-or-stale', 'job': str(job), 'error': str(error)}
        save(job / 'worker-result.json', status)
        save(STATE / 'last-status.json', status)
        raise

def rollback(root, original_job):
    with mutex(root):
        original = read(original_job / 'job.json')
        if original.get('root') != str(root) or original.get('status') not in ('installed', 'committing'):
            raise RuntimeError('No verified committed deployment for this installation')
        backup = Path(original['backup']) / 'app.asar'
        if sha(root / 'resources/app.asar') != original['after'] or sha(backup) != original['before']:
            raise RuntimeError('Installed package/backup changed; cross-version rollback refused')
        validate_unpacked(root, original['unpacked'])
        job = STATE / 'jobs' / uuid.uuid4().hex
        job.mkdir(parents=True)
        shutil.copy2(backup, job / 'app.asar')
        if backup.with_name('app.asar.unpacked').exists():
            shutil.copytree(backup.with_name('app.asar.unpacked'), job / 'app.asar.unpacked')
        record = {**original, 'status': 'prepared', 'job': str(job), 'rollback': True, 'before': original['after'],
                  'after': original['before'], 'expiresAt': time.time() + 12 * 3600,
                  'changes': ['Restore exact previous ASAR'], 'rolledBackJob': str(original_job)}
        record.pop('backup', None)
        save(job / 'job.json', record)
        with mutex(root, 'worker', timeout=0):
            pass
        return submit(root, job, record)

def launch(root, args):
    # The same mutex serializes cooperating launches with final deployment.
    with mutex(root):
        if not running(root):
            try:
                job, result = prepare(root)
                if job:
                    result = deploy(root, job)
                save(STATE / 'last-status.json', result)
            except Exception as error:
                save(STATE / 'last-status.json', {'status': 'maintenance-failed-app-launching', 'error': str(error)})
        child = subprocess.Popen([str(root / 'Antigravity.exe'), *args], close_fds=True)
        return {'status': 'launched', 'pid': child.pid}

def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--check', action='store_true')
    modes.add_argument('--prepare', action='store_true')
    modes.add_argument('--queue', action='store_true')
    modes.add_argument('--launch', action='store_true')
    modes.add_argument('--worker', type=Path)
    modes.add_argument('--rollback', type=Path)
    modes.add_argument('--status', action='store_true')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('app_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.check:
        result = node_tool('--inspect', root / 'resources/app.asar')
        result['runningPids'] = running(root)
    elif args.prepare:
        job, result = prepare(root)
        if job:
            result = {**result, 'job': str(job), 'unpacked': len(result['unpacked'])}
    elif args.queue:
        result = queue(root)
    elif args.worker:
        result = worker(root, args.worker.resolve())
    elif args.rollback:
        result = rollback(root, args.rollback.resolve())
    elif args.launch:
        result = launch(root, args.app_args[1:] if args.app_args[:1] == ['--'] else args.app_args)
    else:
        result = read(STATE / 'last-status.json') if (STATE / 'last-status.json').exists() else {'status': 'no-operation-yet'}
    emit({**result, 'unpacked': len(result['unpacked'])} if isinstance(result.get('unpacked'), list) else result)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        status = {'status': 'failed', 'error': str(error)}
        save(STATE / 'last-error.json', status)
        emit(status)
        sys.exit(1)

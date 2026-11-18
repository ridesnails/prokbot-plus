"""Read-only, bounded Linux guest and Compose project telemetry. No workload driver."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import threading
import time

SCHEMA = 1
MODES = {
    'x86-local': {'host': ('linux/amd64', ('host', 'box'))},
    'arm-split': {'host': ('linux/arm64', ('host',)), 'desktop': ('linux/amd64', ('gateway', 'box'))},
    'arm-emulated': {'host': ('linux/arm64', ('host', 'box'))},
    'host-only': {'host': (None, ('host',))},
}
# Recognized results from systemd-detect-virt --vm, shared by sampling and offline validation.
VM_TYPES = frozenset('qemu kvm amazon google zvm vmware microsoft oracle powervm xen bochs uml parallels '
                     'bhyve qnx acrn apple sre vm-other'.split())
ID = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}')
HEX = re.compile(r'[a-f0-9]{64}')
SOCKET = 'unix:///var/run/docker.sock'
CGROUP = Path('/sys/fs/cgroup')
PROC = Path('/proc')
LABEL = 'com.docker.compose.project'
SERVICE = 'com.docker.compose.service'
ACTIONS = ('start', 'die', 'oom', 'restart', 'destroy')
INSPECT = '\t'.join(('{{.Id}}', '{{index .Config.Labels "' + SERVICE + '"}}', '{{.State.Status}}',
                     '{{.State.Pid}}', '{{.State.StartedAt}}', '{{.RestartCount}}', '{{.State.OOMKilled}}',
                     '{{.Image}}', '{{with index .State "Health"}}{{.Status}}{{else}}none{{end}}'))


def require(test, reason):
    if not test:
        raise ValueError(reason)


def host_platform(os_type, architecture):
    # Offline evidence review needs no imports from deployment tooling.
    release = str(Path(__file__).resolve().parents[1] / 'release')
    if release not in sys.path:
        sys.path.insert(0, release)
    from platforms import host_platform as normalize
    return normalize(os_type, architecture)


def dock(*args):
    return ['docker', '--host', SOCKET, *args]


def output(*args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)
    # Do not propagate daemon diagnostics, which may contain private paths or endpoints.
    require(result.returncode == 0, f'{args[0]} read failed (exit {result.returncode})')
    return result.stdout.strip()


def read(path):
    return path.read_text(encoding='ascii').strip()


def counters(path):
    return {key.rstrip(':'): int(value) for key, value, *_ in (line.split() for line in read(path).splitlines())}


def private_key(path, pattern):
    value = read(path)
    require(re.fullmatch(pattern, value) and value.replace('-', '').strip('0'), 'Missing guest identity')
    return hashlib.sha256(('prokbot-bench/v1:' + value).encode()).hexdigest()


def cpu_stat(proc):
    lines = read(proc / 'stat').splitlines()
    fields = lines[0].split()
    require(fields[0] == 'cpu' and len(fields) >= 9, 'Incomplete /proc/stat')
    user, nice, system, idle, wait, irq, softirq, steal = map(int, fields[1:9])
    # guest and guest_nice are already included in user and nice.
    busy = user + nice + system + irq + softirq
    return sum(bool(re.match(r'^cpu\d+\s', line)) for line in lines), [busy, idle, wait, steal]


def whole(proc, disks):
    cpus, ticks = cpu_stat(proc)
    mem, vm = counters(proc / 'meminfo'), counters(proc / 'vmstat')
    return {'vcpus': cpus, 'cpuTicks': ticks, 'ramBytes': mem['MemTotal'] * 1024,
            'availableBytes': mem['MemAvailable'] * 1024, 'swapBytes': mem['SwapTotal'] * 1024,
            'swapUsedBytes': (mem['SwapTotal'] - mem['SwapFree']) * 1024, 'oomKills': vm['oom_kill'],
            'swapInPages': vm['pswpin'], 'swapOutPages': vm['pswpout'],
            'disks': {name: list(shutil.disk_usage(path)) for name, path in disks.items()}}


def disk_layout(root, extra):
    paths = {'root': Path('/'), 'docker': Path(root)}
    for item in extra:
        name, sep, path = item.partition('=')
        require(sep and ID.fullmatch(name) and name not in paths and Path(path).is_absolute(),
                '--disk requires a unique label and absolute existing directory: label=/mount')
        paths[name] = Path(path)
    devices, disks, aliases = {}, {}, {}
    for name, path in paths.items():
        require(path.is_absolute() and path.is_dir(), f'Cannot read {name} filesystem')
        primary = devices.setdefault(path.stat().st_dev, name)
        aliases[name] = primary
        disks[primary] = path
    return disks, aliases


def limits(group, root):
    # Ancestors can impose tighter limits than the Docker leaf. Effective cpuset is already inherited.
    quotas, memory, swap = [], [], []
    path = group
    while path != root:
        for field, values in (('memory.max', memory), ('memory.swap.max', swap)):
            value = read(path / field)
            if value != 'max':
                values.append(int(value))
        quota, period = read(path / 'cpu.max').split()
        if quota != 'max':
            quotas.append(int(quota) / int(period))
        path = path.parent
    return {'cpuCores': min(quotas, default=None), 'memoryBytes': min(memory, default=None),
            'swapBytes': min(swap, default=None), 'cpuSet': read(group / 'cpuset.cpus.effective')}


def proc_stat(proc, pid):
    # The parenthesized comm field can contain spaces and closing parentheses; never retain it.
    raw = (proc / str(pid) / 'stat').read_bytes()
    fields = raw.rsplit(b') ', 1)[1].split()
    return int(fields[19]), int(fields[11]) + int(fields[12]), int(fields[21])


def usage(proc, root, pid, cid, page):
    # macOS resolves /var to /private/var. Compare two canonical paths so the
    # fixture and a real cgroup root use the same containment rule.
    root = root.resolve()
    memberships = [line[3:] for line in read(proc / str(pid) / 'cgroup').splitlines() if line.startswith('0::/')]
    require(len(memberships) == 1, 'Cannot identify cgroup v2 for project PID')
    group = (root / memberships[0].lstrip('/')).resolve()
    require(group.is_relative_to(root) and group.name in (cid, f'docker-{cid}.scope'),
            'Cannot attribute project PID to its container cgroup')
    # Avoid scanning the dozens of virtual controller files in leaf cgroups every tick.
    if counters(group / 'cgroup.stat')['nr_descendants']:
        def walk_error(error):
            raise error
        ids = {int(n) for path, _, files in os.walk(group, onerror=walk_error) if 'cgroup.procs' in files
               for n in read(Path(path) / 'cgroup.procs').split()}
    else:
        ids = {int(n) for n in read(group / 'cgroup.procs').split()}
    require(pid in ids, 'Container init PID missing from project cgroup')
    init_start, init_ticks, init_rss = proc_stat(proc, pid)
    total_rss = missed = 0
    for member in ids:
        try:
            total_rss += (init_rss if member == pid else proc_stat(proc, member)[2]) * page
        except (FileNotFoundError, ProcessLookupError):
            missed += 1
    events = counters(group / 'memory.events')
    return {'cpuUs': counters(group / 'cpu.stat')['usage_usec'], 'ramBytes': int(read(group / 'memory.current')),
            'oom': events['oom'], 'oomKills': events['oom_kill'], 'limits': limits(group, root),
            'processCount': len(ids), 'rssMissed': missed, 'processRssBytes': total_rss,
            'initStartTicks': init_start, 'initTicks': init_ticks, 'initRssBytes': init_rss * page}


def services(project, allowed, images, page):
    ids = output(*dock('ps', '-aq', '--no-trunc', '--filter', f'label={LABEL}={project}')).splitlines()
    if not ids:
        return {}
    require(len(ids) <= len(allowed) and all(HEX.fullmatch(cid) for cid in ids), 'Unexpected project containers')
    rows = output(*dock('container', 'inspect', '--format', INSPECT, *ids)).splitlines()
    require(len(rows) == len(ids), 'Partial container inspection')
    result = {}
    for row in rows:
        cid, name, state, pid, started, restarts, killed, image, health = row.split('\t')
        require(cid in ids and name in allowed and name not in result, 'Unexpected or duplicate Compose service')
        require(image.startswith('sha256:') and HEX.fullmatch(image[7:]), 'Invalid Docker image identity')
        if image not in images:
            os_arch = output(*dock('image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', image))
            images[image] = host_platform(*os_arch.split('/'))
        sample = None
        if state == 'running' and int(pid) > 0:
            try:
                sample = usage(PROC, CGROUP, int(pid), cid, page)
            except (FileNotFoundError, ProcessLookupError):
                pass  # A stop between inspect and /proc is unknown, not zero usage.
        result[name] = {'id': cid, 'image': image[7:], 'arch': images[image], 'state': state, 'health': health,
                        'started': started, 'autoRestarts': int(restarts), 'oomKilled': killed == 'true', 'usage': sample}
    return result


def environment(args):
    require(args.isolated_guest, 'sample requires explicit --isolated-guest authorization')
    require(sys.platform == 'linux', 'sample requires an isolated Linux VM, not the workstation')
    require(args.role in MODES[args.mode], 'Role does not belong to this mode')
    require(ID.fullmatch(args.run_id) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,60}', args.project), 'Invalid run/project ID')
    require(1 <= args.interval <= 30 and 2 * args.interval <= args.duration <= 86400, 'Use 1..30s ticks and a bounded duration (2 ticks..24h)')
    require(os.environ.get('DOCKER_HOST', SOCKET) == SOCKET and os.environ.get('DOCKER_CONTEXT', 'default') == 'default',
            'Refusing non-default Docker context/endpoint')
    require(not any(Path(p).exists() for p in ('/.dockerenv', '/run/.containerenv')) and
            'microsoft' not in platform.release().lower(), 'Refusing container/WSL as a whole VM')
    container = subprocess.run(['systemd-detect-virt', '--container'], capture_output=True, text=True, timeout=5,
                               stdin=subprocess.DEVNULL)
    require(container.returncode == 1 and container.stdout.strip() == 'none', 'Refusing container/unknown namespace')
    virt = output('systemd-detect-virt', '--vm')
    require(virt in VM_TYPES, 'Cannot verify VM virtualization')
    arch = host_platform('linux', platform.machine())
    expected, _ = MODES[args.mode][args.role]
    require(expected in (None, arch), 'Guest architecture does not match mode/role')
    daemon, version, cgroup, docker_root = output(*dock('info', '--format',
        '{{.OSType}}/{{.Architecture}}\t{{.ServerVersion}}\t{{.CgroupVersion}}\t{{.DockerRootDir}}')).split('\t')
    require(host_platform(*daemon.split('/')) == arch and cgroup == '2' and (CGROUP / 'cgroup.controllers').is_file(),
            'A matching local cgroup-v2 Docker daemon is required')
    disks, aliases = disk_layout(docker_root, args.disk)
    release = platform.freedesktop_os_release()
    machine = {'key': private_key(Path('/etc/machine-id'), r'[a-f0-9]{32}'), 'arch': arch, 'virt': virt,
               'os': release['ID'], 'osVersion': release['VERSION_ID'], 'kernel': platform.release(),
               'dockerVersion': version, 'pageBytes': os.sysconf('SC_PAGE_SIZE'), 'tickHz': os.sysconf('SC_CLK_TCK'),
               'disks': aliases}
    return {'type': 'header', 'schema': SCHEMA, 'origin': 'linux-whole-guest', 'runId': args.run_id,
            'mode': args.mode, 'role': args.role, 'project': args.project, 'machine': machine,
            'boot': private_key(PROC / 'sys/kernel/random/boot_id', r'[a-f0-9-]{36}'),
            'intervalMs': args.interval * 1000, 'durationMs': args.duration * 1000}, disks


def clock_ms():
    return time.time_ns() // 1_000_000


def record(args):
    header, disks = environment(args)
    allowed = MODES[args.mode][args.role][1]
    page = header['machine']['pageBytes']
    images, failures = {}, []
    lock = threading.Lock()
    with open(args.out, 'x', encoding='utf-8', newline='\n', opener=private_open) as sink:
        def emit(obj):
            with lock:
                sink.write(json.dumps(obj, separators=(',', ':'), allow_nan=False) + '\n')
                sink.flush()

        emit(header)
        start = time.monotonic()
        stamp = time.time_ns()
        since = f'{stamp // 10**9}.{stamp % 10**9:09d}'
        fmt = '{{.TimeNano}}\t{{.Action}}\t{{.Actor.ID}}\t{{index .Actor.Attributes "' + SERVICE + '"}}'
        filters = [flag for action in ACTIONS for flag in ('--filter', 'event=' + action)]
        # Subscribe during the run; a retrospective docker events query only retains 256 events.
        event_cmd = dock('events', '--since', since, '--filter', 'type=container', '--filter',
                         f'label={LABEL}={args.project}', *filters, '--format', fmt)
        with subprocess.Popen(event_cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True) as watcher:
            def listen():
                try:
                    for line in watcher.stdout:
                        ns, action, cid, name = line.rstrip('\n').split('\t')
                        require(action in ACTIONS and HEX.fullmatch(cid) and name in allowed, 'Unexpected project event')
                        emit({'type': 'event', 'atMs': int(ns) // 10**6, 'action': action, 'service': name, 'id': cid})
                except (OSError, ValueError) as error:
                    failures.append(str(error))

            listener = threading.Thread(target=listen, daemon=True)
            listener.start()
            count, offset = 0, 0
            try:
                while True:
                    require(watcher.poll() is None and not failures, 'Docker event stream interrupted')
                    monotonic_ms, wall_ms = time.monotonic_ns() // 10**6, clock_ms()
                    guest = whole(PROC, disks)
                    scoped = services(args.project, allowed, images, page)
                    emit({'type': 'sample', 'seq': count, 'atMs': wall_ms, 'monoMs': monotonic_ms,
                          'guest': guest, 'services': scoped})
                    count += 1
                    if count == 1:
                        print('sampling-ready', flush=True, file=sys.stderr)
                    if offset == args.duration:
                        break
                    offset = min(args.duration, max(offset + args.interval, time.monotonic() - start + 0.001))
                    due = start + offset
                    time.sleep(max(0, due - time.monotonic()))
                require(watcher.poll() is None and not failures, 'Docker event stream interrupted')
            finally:
                if watcher.poll() is None:
                    watcher.terminate()  # Only the read-only CLI subprocess started above.
                try:
                    watcher.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    watcher.kill()
                    watcher.wait(timeout=3)
                listener.join(timeout=3)
            require(not listener.is_alive() and not failures, 'Incomplete Docker event stream')
        emit({'type': 'end', 'samples': count, 'eventsComplete': True})


def private_open(path, flags):
    return os.open(path, flags, 0o600)

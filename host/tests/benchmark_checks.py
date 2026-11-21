"""Offline fixtures only. The `measured` branch is exercised with temporary records; never publish these."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import contextlib
from datetime import datetime, timezone
import io
from types import SimpleNamespace
import unittest
from unittest.mock import patch

BENCH = Path(__file__).resolve().parents[1] / 'bench'
sys.path.insert(0, str(BENCH))
import bench
import evidence
import guest
import telemetry


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def dump(path, rows):
    data = ''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in rows)
    path.write_bytes(data.encode())
    return sha(data)


def fixture(directory, mode='x86-local', number=1, after=False, synthetic=True, extra=False, mutate=None):
    directory.mkdir(parents=True, exist_ok=True)
    start = 1_700_000_000_000 + (number + 10 * after) * 10_000_000
    duration = 4140000 if extra else 4020000
    run_id = ('after-' if after else 'before-') + str(number)
    phases = {name: {'startMs': start + a, 'endMs': start + b} for name, a, b in [
        ('build', 10000, 60000), ('cold', 60000, 90000), ('idle', 90000, 150000), ('chat', 150000, 210000),
        ('desktop', 210000, 270000), ('restart', 270000, 330000), ('soak', 330000, 3930000),
        ('concurrent', 3930000, 4110000)] if (extra or name not in ('build', 'concurrent')) and
              (mode != 'host-only' or name != 'desktop')}
    m = {'schema': 1, 'runId': run_id, 'mode': mode, 'revision': ('b' if after else 'a') * 40,
         'origin': 'synthetic' if synthetic else 'measured', 'modelKind': 'external-api', 'phases': phases,
         **{field: sha(field) for field in evidence.PREREQ}, 'provisioned': {}, 'traceSha256': {}}
    actions = []
    def receipt(phase, check, begin, end, client='user1'):
        item = {'runId': run_id, 'source': 'synthetic' if synthetic else 'build-log' if phase == 'build' else 'real-client',
                'phase': phase, 'check': check, 'id': f'a{len(actions)}', 'client': client, 'startMs': start + begin,
                'endMs': start + end, 'ok': True, 'evidenceSha256': sha(run_id + str(len(actions)))}
        if check in evidence.CHAT:
            item['upstreamMs'] = (end - begin) // 2
        actions.append(item)
    if extra:
        for role in guest.MODES[mode]:
            receipt('build', 'pinned-inputs', 10000, 11000, role); receipt('build', 'image-ready', 40000, 50000, role)
    receipt('cold', 'client-ready', 60500, 80000); receipt('idle', 'idle-healthy', 141000, 148000)
    receipt('chat', 'chat-reply', 153000, 156000); receipt('chat', 'context-reply', 159000, 163000)
    if mode != 'host-only':
        receipt('desktop', 'desktop-frame', 214000, 218000); receipt('desktop', 'desktop-input', 220000, 225000)
    receipt('restart', 'identity-restored', 305000, 310000); receipt('restart', 'history-restored', 315000, 320000)
    for second in range(360, 3930, 60):
        receipt('soak', 'chat-reply', second * 1000 - 100, second * 1000)
    if extra:
        receipt('concurrent', 'chat-reply', 3931000, 4109000, 'user1')
        receipt('concurrent', 'chat-reply', 3932000, 4108000, 'user2')
    traces = {}
    for role, (arch, names) in guest.MODES[mode].items():
        arch = arch or 'linux/amd64'
        cap = 2 << 30; m['provisioned'][role] = {'vcpus': 2, 'ramBytes': cap}
        header = {'type': 'header', 'schema': 1, 'origin': 'synthetic' if synthetic else 'linux-whole-guest',
                  'runId': run_id, 'mode': mode, 'role': role, 'project': 'demo-' + role, 'boot': sha('boot' + role),
                  'intervalMs': 30000, 'durationMs': duration, 'machine': {'key': sha(role), 'arch': arch,
                  'virt': 'kvm', 'os': 'fixture', 'osVersion': '1', 'kernel': 'fixture', 'dockerVersion': 'fixture',
                  'pageBytes': 4096, 'tickHz': 100, 'disks': {'root': 'root', 'docker': 'root'}}}
        rows = [header]; ids = {name: sha(name + run_id) for name in names}
        for i, ms in enumerate(range(0, duration + 1, 30000)):
            services = {}
            if ms >= 90000:
                for name in names:
                    restarted = name == 'host' and ms >= 300000
                    u = {'cpuUs': i * 3000000, 'ramBytes': 200000, 'oom': 0, 'oomKills': 0, 'processCount': 3,
                         'rssMissed': 0, 'processRssBytes': 160000, 'initStartTicks': 250 if restarted else 15,
                         'initTicks': i * 150, 'initRssBytes': 45000,
                         'limits': {'cpuCores': None, 'memoryBytes': None, 'swapBytes': None, 'cpuSet': '0-1'}}
                    stamp = datetime.fromtimestamp((start + (281000 if restarted else 61000))/1000, timezone.utc)
                    services[name] = {'id': ids[name], 'image': sha(name + str(after)), 'arch': arch if name == 'host' else 'linux/amd64',
                                      'state': 'running', 'health': 'none', 'started': stamp.isoformat(timespec='milliseconds'),
                                      'autoRestarts': 0, 'oomKilled': False, 'usage': u}
            used = 200000 + (80000 if i == 10 else 5 * i)
            g = {'vcpus': 2, 'cpuTicks': [60 * i, 190 * i, 25 * i, 25 * i], 'ramBytes': cap - 50000000,
                 'availableBytes': (800000000 if after else 750000000), 'swapBytes': 900000, 'swapUsedBytes': 2 * i,
                 'swapInPages': 4 + i, 'swapOutPages': 10 + i, 'oomKills': 0, 'disks': {'root': [2000000, used, 2000000 - used - 5]}}
            rows.append({'type': 'sample', 'seq': i, 'monoMs': 10000 + ms, 'atMs': start + ms, 'guest': g, 'services': services})
        for name in names:
            events = [('start', 61000)] + ([('die', 276000), ('start', 281000), ('restart', 281001)] if name == 'host' else [])
            rows.extend({'type': 'event', 'service': name, 'atMs': start + ms, 'action': act, 'id': ids[name]} for act, ms in events)
        rows.append({'type': 'end', 'samples': duration // 30000 + 1, 'eventsComplete': True}); traces[role] = rows
    if mutate:
        mutate(m, actions, traces)
    for role, rows in traces.items():
        m['traceSha256'][role] = dump(directory / (role + '.jsonl'), rows)
    m['actionLogSha256'] = dump(directory / 'actions.jsonl', actions)
    (directory / 'run.json').write_text(json.dumps(m), encoding='ascii')
    return directory


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup); self.root = Path(temp.name).resolve()

    def check(self, mutate=None, **kw):
        return evidence.inspect_run(fixture(self.root / 'run', mutate=mutate, **kw))

    def test_all_modes_fixture_smoke_no_capacity_claim(self):
        for mode, roles in guest.MODES.items():
            with self.subTest(mode=mode):
                r = evidence.inspect_run(fixture(self.root / mode, mode=mode))
                self.assertFalse(r['eligibleRound']); self.assertEqual(set(r['machines']), set(roles))
                self.assertTrue(all('ynthetic' in issue or 'real client' in issue or 'measured' in issue for issue in r['issues']), r['issues'])

    def test_matched_three_rounds_report_paired_delta_not_a_measurement(self):
        for after, side in ((False, 'before'), (True, 'after')):
            for n in range(1, 4):
                fixture(self.root / side / str(n), number=n, after=after, synthetic=False, extra=True)
        r = evidence.compare(self.root / 'before', self.root / 'after')
        self.assertTrue(r['eligibleForReview'], r['issues']); self.assertTrue(r['buildObserved']); self.assertTrue(r['concurrencyAndHeadroomObserved'])
        self.assertEqual(r['deltas']['host.soak.ramPeakBytes']['pairedDeltas'], [-50000000] * 3)
        h = r['rounds'][0]['before']['machines']['host']['phases']['concurrent']['overlapHeadroom']
        self.assertEqual((h['intervals'], h['measuredMs'], h['nonIdlePct']['p95']), (4, 120000, 36.666666666666664))
        sample = r['rounds'][0]['before']['machines']['host']['observation']
        self.assertEqual(sample['guest']['disks']['root']['peakGrowthBytes'], 80000)
        self.assertEqual(sample['guest']['disks']['root']['endGrowthBytes'], 690)
        self.assertEqual(sample['serviceRamPeakBytes'], 400000); self.assertEqual(sample['services']['box']['cpuCores']['max'], .1)
        self.assertEqual(sample['guest']['cpu']['busyPct']['p95'], 20)
        self.assertEqual(sample['guest']['swapOutBytes'], 138 * 4096)

    def test_build_without_an_in_phase_interval_is_not_observed(self):
        def mutate(m, actions, traces):
            begin = m['phases']['build']['startMs']; m['phases']['build']['endMs'] = begin + 9000
            for action in actions:
                if action['phase'] == 'build':
                    action['startMs'] = begin + (500 if action['check'] == 'pinned-inputs' else 6000)
                    action['endMs'] = action['startMs'] + 1000
        result = self.check(mutate, synthetic=False, extra=True)
        self.assertFalse(result['eligibleRound']); self.assertTrue(any('build interval' in s for s in result['issues']))

    def test_service_generation_changed_during_chat_without_a_matching_start(self):
        def mutate(m, actions, traces):
            began = m['phases']['chat']['startMs']; stamp = datetime.fromtimestamp(began/1000,timezone.utc).isoformat()
            for r in traces['host']:
                if r['type'] == 'sample' and r['atMs'] >= began:
                    s = r['services']['host']; s['started'] = stamp; s['usage']['initStartTicks'] = 200
        result = self.check(mutate, synthetic=False, extra=True)
        self.assertFalse(result['eligibleRound']); self.assertTrue(any('generation' in s for s in result['issues']))

    def test_accepts_docker_nanosecond_start_times_on_python_310(self):
        def mutate(m, actions, traces):
            for r in traces['host']:
                for s in r.get('services', {}).values():
                    s['started'] = s['started'].replace('.000+00:00', '.000000123Z')
        result = self.check(mutate, synthetic=False, extra=True)
        self.assertTrue(result['eligibleRound'], result['issues'])

    def test_truncated_bad_clock_corrupt_raw_and_counter_reset(self):
        changes = [lambda m, a, t: t['host'].pop(), lambda m, a, t: t['host'][-1].update(samples=1),
                   lambda m, a, t: t['host'][10].update(seq=3), lambda m, a, t: t['host'][10].update(atMs=t['host'][1]['atMs']),
                   lambda m, a, t: t['host'][10]['guest'].update(swapBytes=-1),
                   lambda m, a, t: t['host'][10]['guest'].update(swapUsedBytes=True),
                   lambda m, a, t: t['host'][10]['guest'].update(cpuTicks=[0, 0, 0, 0]),
                   lambda m, a, t: t['host'][10]['services']['box']['usage'].update(cpuUs=0),
                   lambda m, a, t: t['host'][10]['services']['box']['usage']['limits'].update(memoryBytes=1)]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check(change)
        path = fixture(self.root / 'run')
        with (path / 'actions.jsonl').open('ab') as f:
            f.write(b'{}\n')
        with self.assertRaises(ValueError): evidence.inspect_run(path)
        with self.assertRaisesRegex(ValueError, 'Duplicate'): telemetry.decode('{"x":1,"x":2}')
        with self.assertRaisesRegex(ValueError, 'Non-finite'): telemetry.decode('{"x":NaN}')

    def test_topology_provisioning_and_binding_fail_closed(self):
        for mode, change in [
            ('arm-emulated', lambda m, a, t: t['host'][0]['machine'].update(arch='linux/amd64')),
            ('arm-emulated', lambda m, a, t: t['host'][10]['services']['box'].update(arch='linux/arm64')),
            ('arm-split', lambda m, a, t: t.pop('desktop')),
            ('arm-split', lambda m, a, t: t['desktop'][0]['machine'].update(key=sha('host'))),
            ('host-only', lambda m, a, t: m['phases'].update(desktop={'startMs': m['phases']['chat']['endMs'], 'endMs': m['phases']['restart']['startMs']})),
            ('host-only', lambda m, a, t: m['provisioned']['host'].update(ramBytes=512 * 1024**2)),
            ('x86-local', lambda m, a, t: a[0].update(runId='reused'))]:
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                evidence.inspect_run(fixture(self.root / mode, mode=mode, mutate=change))

    def test_soak_failure_and_unmeasured_provider_are_not_success(self):
        def bad(m, a, t):
            a[2]['ok'] = False
            for receipt in a:
                if 'upstreamMs' in receipt: receipt['upstreamMs'] = None
            a[:] = [x for x in a if x['phase'] != 'soak' or x['endMs'] == m['phases']['soak']['startMs'] + 30000]
        r = self.check(bad, synthetic=False)
        self.assertFalse(r['eligibleRound']); self.assertEqual(r['actions']['chat']['errors'], 1)
        self.assertIsNone(r['actions']['chat']['nonUpstreamMs']); self.assertGreater(r['actions']['soak']['longestCompletionGapMs'], 60000)
        self.assertTrue(any('Failed operation' in s for s in r['issues'])); self.assertTrue(any('Soak shorter' in s for s in r['issues']))
        with self.assertRaisesRegex(ValueError, 'integer'):
            self.check(lambda m, a, t: a[2].update(upstreamMs=1000000))

    def test_unplanned_restart_oom_and_missing_usage(self):
        def observed(m, a, t):
            rows = t['host']; rows[7]['services']['box']['usage'] = None
            for row in rows[8:]:
                if row['type'] == 'sample': row['guest']['oomKills'] = 1
            rows.insert(-1, dict(rows[-2], action='oom', atMs=m['phases']['chat']['startMs']))
            rows.insert(-1, dict(rows[-2], action='start', atMs=m['phases']['chat']['startMs'] + 10))
        r = self.check(observed, synthetic=False)
        self.assertFalse(r['eligibleRound']); self.assertTrue(any('whole-guest OOM' in issue for issue in r['issues']))
        self.assertTrue(any('healthy service' in issue for issue in r['issues']))
        self.assertEqual(r['machines']['host']['lifecycle']['box']['outOfWindowEvents'], 2)

    def test_health_poll_only_and_parallel_claims(self):
        def bad(m, a, t):
            a[0]['source'] = 'probe'
            for action in a:
                if action['phase'] == 'concurrent': action['client'] = 'same'
                if action['phase'] == 'chat': action['endMs'] = m['phases']['chat']['endMs']
            t['host'][10]['services']['box']['oomKilled'] = True
        r = self.check(bad, synthetic=False, extra=True)
        self.assertFalse(r['eligibleRound']); self.assertTrue(any('overlapping successful' in s for s in r['issues']))
        self.assertTrue(any('sequential single-client' in s for s in r['issues'])); self.assertTrue(any('real client' in s for s in r['issues']))

    def test_short_cohort_unmatched_controls_and_replay(self):
        a, b = self.root / 'before', self.root / 'after'
        fixture(a / '1', synthetic=False); fixture(b / '1', after=True, synthetic=False)
        r = evidence.compare(a, b); self.assertFalse(r['eligibleForReview']); self.assertEqual(r['deltas'], {})
        for change in [lambda m, a, t: m.update(modelConfigSha256=sha('different-endpoint')),
                       lambda m, a, t: t['host'][0]['machine'].update(key=sha('another-vm')),
                       lambda m, a, t: t['host'][0]['machine'].update(dockerVersion='other'),
                       lambda m, a, t: a.pop()]:
            fixture(b / '1', after=True, synthetic=False, mutate=change)
            with self.assertRaisesRegex(ValueError, 'control'): evidence.compare(a, b)
        fixture(b / '1', after=True, synthetic=False); fixture(b / '3', number=3, after=True, synthetic=False)
        with self.assertRaisesRegex(ValueError, 'Missing round'): evidence.compare(a, b)

    def test_sampler_denies_before_docker_or_files_without_opt_in(self):
        out = self.root / 'forbidden.jsonl'
        with patch.object(guest, 'output') as docker, self.assertRaisesRegex(ValueError, 'isolated-guest'):
            bench.main(['sample', '--mode', 'x86-local', '--role', 'host', '--project', 'bench', '--run-id', 'b1',
                        '--out', str(out), '--duration', '10'])
        docker.assert_not_called(); self.assertFalse(out.exists())

    def test_cgroup_attribution_inherited_limits_rss_and_pid_race(self):
        cid = sha('scoped-container'); proc = self.root / 'proc'; cg = self.root / 'cgroups'
        parent = cg / 'system.slice'; leaf = parent / ('docker-' + cid + '.scope')
        child = leaf / 'child'; child.mkdir(parents=True)
        (proc / '10').mkdir(parents=True); (proc / '11').mkdir()
        def put(directory, mapping):
            for name, value in mapping.items(): (directory / name).write_text(value, encoding='ascii')
        put(parent, {'cpu.max': '100000 100000', 'memory.max': '10000', 'memory.swap.max': '2000'})
        put(leaf, {'cpu.max': 'max 100000', 'memory.max': '20000', 'memory.swap.max': 'max', 'cpuset.cpus.effective': '0-1',
                   'memory.events': 'oom 1\noom_kill 0', 'cgroup.procs': '10', 'cgroup.stat': 'nr_descendants 1',
                   'memory.current': '4000', 'cpu.stat': 'usage_usec 66666'})
        put(child, {'cgroup.procs': '11\n12'})
        stat = ['0'] * 22
        stat[0], stat[11], stat[12], stat[19], stat[21] = 'S', '14', '15', '123', '2'
        put(proc / '10', {'stat': '10 (name ) with spaces) ' + ' '.join(stat),
                          'cgroup': '0::/system.slice/docker-' + cid + '.scope'})
        stat[21] = '3'; put(proc / '11', {'stat': '11 (child) ' + ' '.join(stat)})
        u = guest.usage(proc, cg, 10, cid, 4096)
        self.assertEqual(u['limits'], {'cpuCores': 1., 'memoryBytes': 10000, 'swapBytes': 2000, 'cpuSet': '0-1'})
        self.assertEqual(u['processCount'], 3); self.assertEqual(u['rssMissed'], 1)
        self.assertEqual(u['processRssBytes'], 5 * 4096); self.assertEqual(u['initTicks'], 29)
        self.assertEqual(u['initStartTicks'], 123); self.assertEqual(u['cpuUs'], 66666)
        with self.assertRaisesRegex(ValueError, 'attribute'): guest.usage(proc, cg, 10, sha('unrelated-container'), 4096)
        put(leaf, {'cgroup.stat': 'nr_descendants 0'})
        with patch.object(guest.os, 'walk') as walked:
            self.assertEqual(guest.usage(proc, cg, 10, cid, 4096)['processRssBytes'], 2 * 4096)
            walked.assert_not_called()

    def test_docker_inspection_only_uses_matching_project_and_image(self):
        cid, image = sha('container'), sha('image'); invocations = []
        def fake(*cmd):
            invocations.append(cmd)
            self.assertEqual(cmd[:3], ('docker', '--host', guest.SOCKET))
            if cmd[3] == 'ps':
                self.assertIn('label=com.docker.compose.project=bench', cmd)
                return cid
            if cmd[3] == 'container':
                self.assertEqual(cmd[-1], cid); self.assertNotIn('.Config.Env', cmd[-2])
                return '\t'.join((cid, 'host', 'running', '10', '2026-01-01T00:00:00Z', '0', 'false', 'sha256:' + image, 'none'))
            self.assertEqual(cmd[3:5], ('image', 'inspect')); self.assertEqual(cmd[-1], 'sha256:' + image)
            return 'linux/amd64'
        with patch.object(guest, 'output', side_effect=fake), patch.object(guest, 'usage', side_effect=FileNotFoundError):
            cache = {}
            self.assertIsNone(guest.services('bench', ('host',), cache, 4096)['host']['usage'])
            self.assertIsNone(guest.services('bench', ('host',), cache, 4096)['host']['usage'])
            self.assertEqual(sum(cmd[3] == 'image' for cmd in invocations), 1)
            with self.assertRaisesRegex(ValueError, 'Compose service'): guest.services('bench', ('box',), cache, 4096)

    def test_synthetic_or_short_never_produce_deltas_even_with_three_pairs(self):
        a, b = self.root / 'before', self.root / 'after'
        for n in range(1, 4):
            fixture(a / str(n), number=n); fixture(b / str(n), number=n, after=True)
        r = evidence.compare(a, b)
        self.assertFalse(r['eligibleForReview']); self.assertEqual(r['deltas'], {})
        self.assertFalse(r['buildObserved']); self.assertFalse(r['concurrencyAndHeadroomObserved'])
        path = a / '1'; manifest = json.loads((path / 'run.json').read_bytes())
        manifest['traceSha256']['host'] = sha('wrong')
        (path / 'run.json').write_text(json.dumps(manifest), encoding='ascii')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'): evidence.inspect_run(path)

    def test_source_artifacts_opt_in_and_content_digest(self):
        path = fixture(self.root / 'review', synthetic=False); raw = self.root / 'redacted'; raw.mkdir()
        r = evidence.inspect_run(path); self.assertIsNone(r['sourceArtifactsChecked']); self.assertTrue(r['eligibleRound'])
        r = evidence.inspect_run(path, raw); self.assertFalse(r['eligibleRound']); self.assertEqual(r['sourceArtifactsChecked'], 0)
        actions = [json.loads(line) for line in (path / 'actions.jsonl').read_bytes().splitlines()]
        for i, action in enumerate(actions):
            (raw / action['evidenceSha256']).write_bytes(('before-1' + str(i)).encode())
        r = evidence.inspect_run(path, raw); self.assertTrue(r['eligibleRound']); self.assertEqual(r['sourceArtifactsChecked'], len(actions))
        self.assertIn('not attestation', r['reviewScope'])
        (raw / actions[0]['evidenceSha256']).write_bytes(b'altered capture')
        r = evidence.inspect_run(path, raw); self.assertFalse(r['eligibleRound']); self.assertTrue(any('digest mismatch' in e for e in r['issues']))

    def test_bad_round_retains_other_round_diagnostics_and_cli_exit_status(self):
        before, after = self.root / 'before', self.root / 'after'
        fixture(before / '1', synthetic=False); fixture(after / '1', after=True, synthetic=False)
        fixture(before / '2', number=2, synthetic=False, mutate=lambda m, a, t: t['host'].pop())
        fixture(after / '2', number=2, after=True, synthetic=False)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            status = bench.main(['compare', '--before', str(before), '--after', str(after)])
        r = json.loads(out.getvalue()); self.assertEqual(status, 2); self.assertEqual(r['deltas'], {})
        self.assertTrue(r['rounds'][0]['before']['eligibleRound']); self.assertIn('footer', r['rounds'][1]['before']['invalid'])

    def test_incomplete_event_stream_stops_sampler_and_leaves_no_footer(self):
        from io import StringIO
        class Stopped:
            stdout = StringIO('')
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def poll(self): return 1
            def wait(self, timeout): return 1
        dest = self.root / 'partial.jsonl'
        args = SimpleNamespace(project='bench', mode='host-only', role='host', out=dest, interval=1, duration=2)
        header = {'type': 'header', 'machine': {'pageBytes': 4096}}
        with patch.object(guest, 'environment', return_value=(header, {})), patch.object(guest.subprocess, 'Popen', return_value=Stopped()) as popen:
            with self.assertRaisesRegex(ValueError, 'event stream'): guest.record(args)
            cmd = popen.call_args.args[0]
            self.assertIn('events', cmd); self.assertIn('label=com.docker.compose.project=bench', cmd)
            self.assertEqual(json.loads(dest.read_bytes())['type'], 'header')
            with self.assertRaises(FileExistsError): guest.record(args)
            self.assertEqual(popen.call_count, 1)

    def test_observer_writes_complete_samples_and_only_stops_its_cli_child(self):
        from threading import Event
        stop = Event(); clock = [100.0]
        class FakeWatcher:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def poll(self): return -15 if stop.is_set() else None
            def wait(self, timeout): return -15
            def terminate(self): stop.set()
            @property
            def stdout(self):
                def stream():
                    yield '101000000000\tstart\t' + sha('observed') + '\thost\n'
                    stop.wait(3)
                return stream()
        def sleep(s): clock[0] += s
        args = SimpleNamespace(project='fixture', mode='host-only', role='host', out=self.root / 'out.jsonl', interval=1, duration=2)
        header = {'type': 'header', 'machine': {'pageBytes': 4096}}
        with patch.object(guest, 'environment', return_value=(header, {})), patch.object(guest, 'whole', return_value={}), \
             patch.object(guest, 'services', return_value={}), patch.object(guest.subprocess, 'Popen', return_value=FakeWatcher()), \
             patch.object(guest.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(guest.time, 'sleep', side_effect=sleep), \
             patch.object(guest.time, 'monotonic_ns', side_effect=lambda: int(clock[0]*1e9)), \
             patch.object(guest.time, 'time_ns', side_effect=lambda: int(clock[0]*1e9)), contextlib.redirect_stderr(io.StringIO()):
            guest.record(args)
        rows = [json.loads(line) for line in args.out.read_bytes().splitlines()]
        self.assertTrue(stop.is_set()); self.assertEqual([r['seq'] for r in rows if r['type'] == 'sample'], [0, 1, 2])
        self.assertEqual(len([r for r in rows if r['type'] == 'event']), 1)
        self.assertEqual(rows[-1], {'type': 'end', 'samples': 3, 'eventsComplete': True})

    def test_restart_events_correlated_and_missing_or_reused_rounds_rejected(self):
        r = self.check(lambda m, a, t: t['host'][-2].update(id=sha('other-service')), synthetic=False)
        self.assertFalse(r['eligibleRound']); self.assertTrue(any('lifecycle not bound' in s for s in r['issues']))
        def lost_restart(m, a, t):
            for row in t['host']:
                if row['type'] == 'sample' and row['services']:
                    row['services']['host']['started'] = '2025-01-01T00:00:01Z'
        r = self.check(lost_restart, synthetic=False)
        self.assertTrue(any('uncorroborated' in s for s in r['issues']))
        a, b = self.root / 'before', self.root / 'after'
        for side, after in ((a, False), (b, True)):
            fixture(side / '1', after=after, synthetic=False)
            fixture(side / '2', number=1, after=after, synthetic=False)
        with self.assertRaisesRegex(ValueError, 'reused'): evidence.compare(a, b)

    def test_headroom_uses_whole_intervals_of_distinct_clients_not_idle_time(self):
        receipts = [{'client': c, 'startMs': s, 'endMs': e} for c, s, e in
                    [('a', 1, 14), ('a', 2, 8), ('b', 4, 5), ('b', 5, 7), ('c', 9, 12)]]
        spans = evidence.overlap_windows(receipts)
        self.assertEqual(spans, [[4, 7], [9, 12]])
        times = [3, 5, 7, 9, 10, 12]
        rows = [{'atMs': t, 'monoMs': t, 'guest': {'availableBytes': 1 if t == 7 else 20, 'cpuTicks': [0, t, 0, 0]}}
                for t in times]
        h = evidence.overlap_headroom(rows, times, spans, 1)
        self.assertEqual((h['intervals'], h['measuredMs'], h['minAvailableBytes']), (1, 1, 20))
        def bad(m, actions, traces):
            for row in traces['desktop']:
                if row['type'] == 'sample' and row['atMs'] == m['phases']['concurrent']['startMs'] + 60000:
                    row['guest']['availableBytes'] = row['guest']['ramBytes'] // 20
        r = self.check(bad, mode='arm-split', synthetic=False, extra=True)
        self.assertFalse(r['eligibleRound']); self.assertIn('desktop: concurrent workload lacks configured CPU/RAM headroom', r['issues'])


class PublicationRegressionTests(unittest.TestCase):
    def reject(self, change, issue, mode='x86-local'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); blobs = root / 'blobs'; blobs.mkdir()
            for after, side in ((False, 'before'), (True, 'after')):
                for n in range(1, 4):
                    def mutate(m, actions, traces):
                        if after:
                            change(m, actions, traces)
                        for a in actions:
                            data = (m['runId'] + ':' + a['id']).encode('ascii')
                            a['evidenceSha256'] = hashlib.sha256(data).hexdigest()
                            (blobs / a['evidenceSha256']).write_bytes(data)
                    fixture(root / side / str(n), mode=mode, number=n, after=after, synthetic=False, extra=True, mutate=mutate)
            r = evidence.compare(root / 'before', root / 'after', blobs)
            self.assertTrue(all(p['before']['eligibleRound'] for p in r['rounds']))
            self.assertTrue(r['sourceArtifactsChecked'])  # Matched arbitrary bytes cannot override contradictions.
            self.assertFalse(r['eligibleForReview']); self.assertFalse(r['concurrencyAndHeadroomObserved'])
            self.assertEqual(r['deltas'], {}); self.assertTrue(any(issue in s for s in r['issues']), r['issues'])

    def test_ready_before_required_service_start(self):
        def late_desktop(m, actions, traces):
            ready = next(a for a in actions if a['phase'] == 'cold')
            for event in traces['desktop']:
                if event['type'] == 'event' and event['action'] == 'start' and event['service'] == 'box':
                    event['atMs'] = ready['endMs'] + 1
        self.reject(late_desktop, 'client-ready did not follow', 'arm-split')

    def test_identity_or_history_read_before_host_restart(self):
        def premature(m, actions, traces):
            for a in actions:
                if a['check'] == 'identity-restored':
                    a.update(startMs=m['phases']['restart']['startMs'] + 100, endMs=m['phases']['restart']['startMs'] + 200)
                if a['check'] == 'history-restored':
                    a['startMs'] = m['phases']['restart']['startMs'] + 10000  # After die but before the new start.
        self.reject(premature, 'recovery read did not begin after')

    def test_recovery_from_another_client(self):
        def different(m, actions, traces):
            for a in actions:
                if a['phase'] == 'restart': a['client'] = 'different-pairing'
        self.reject(different, 'original paired chat client')

    def test_distinct_revision_with_identical_running_host_image(self):
        def same_host(m, actions, traces):
            for row in traces['host']:
                if 'host' in row.get('services', {}): row['services']['host']['image'] = sha('hostFalse')
        self.reject(same_host, 'distinct observed Host images')  # A different desktop image does not qualify.

    def test_overlap_with_no_counter_interval(self):
        def short_overlap(m, actions, traces):
            t = m['phases']['concurrent']['startMs']
            for a in actions:
                if a['phase'] == 'concurrent': a.update(startMs=t + 100, endMs=t + 4000, upstreamMs=100)
        self.reject(short_overlap, 'telemetry inside concurrent overlap')


if __name__ == '__main__':
    unittest.main()

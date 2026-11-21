import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

HOST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOST))
import deploy
import backup
import platforms

spec = importlib.util.spec_from_file_location('builder', HOST / 'release/build-docker.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.args = ['--home', str(self.home)]

    def invoke(self, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            deploy.main(self.args + list(args))
        return out.getvalue()

    def test_platforms(self):
        for arch in ('amd64', 'x86_64', 'arm64', 'aarch64'):
            self.assertEqual(platforms.host_platform('Linux', arch), 'linux/' + ('arm64' if arch in ('arm64', 'aarch64') else 'amd64'))
        for os_name, arch in [('windows', 'amd64'), ('linux', 'armv7l')]:
            with self.assertRaises(ValueError): platforms.host_platform(os_name, arch)

    def test_runtime_matrix(self):
        for mode in (True, False):
            self.assertEqual(builder.choose_runtime('linux/amd64', mode), (platforms.BOX['localTag'], True))
            image, needs_box = builder.choose_runtime('linux/arm64', mode)
            self.assertNotEqual(image, platforms.BOX['localTag']); self.assertEqual(needs_box, not mode)

    def test_arm_probe_precedes_download(self):
        with patch.object(sys, 'argv', ['build']), patch.object(builder, 'docker_platform', return_value='linux/arm64'), \
             patch.object(builder, 'check_box_execution', side_effect=ValueError('no emulator')), patch.object(builder, 'prepare_box') as box:
            with self.assertRaisesRegex(ValueError, 'no emulator'): builder.main()
            box.assert_not_called()

    def test_arm_remote_skips_box_and_emulator(self):
        with patch.object(sys, 'argv', ['build', '--host-only', '--host-archive', str(self.home / 'missing')]), \
             patch.object(builder, 'docker_platform', return_value='linux/arm64'), patch.object(builder, 'check_box_execution') as probe, \
             patch.object(builder, 'prepare_box') as box:
            with self.assertRaises(FileNotFoundError): builder.main()
            box.assert_not_called(); probe.assert_not_called()

    def test_init_once_and_mode(self):
        with patch.object(deploy, 'check_runtime_versions', return_value={}):
            self.invoke('--host-only', '--project', 'mybot', 'init', '--listen', '::1', '--public-url', 'http://[::1]:18080')
        env = (self.home / '.env').read_text()
        self.assertIn('GROKBOT_LISTEN_ADDRESS=[::1]', env)
        with patch.object(deploy, 'check_runtime_versions', return_value={}), \
             self.assertRaisesRegex(ValueError, 'never overwrites'):
            self.invoke('init')
        self.assertEqual(env, (self.home / '.env').read_text())
        with patch.object(deploy, 'run') as run: self.invoke('status')
        self.assertIn('mybot', run.call_args.args[0]); self.assertIn(str(deploy.RELEASE / 'compose.host.yaml'), run.call_args.args[0])
        with self.assertRaisesRegex(ValueError, 'Project name conflicts'): self.invoke('--project', 'other', 'status')

    def test_invalid_url_writes_nothing(self):
        for url in ['http://bot/path', 'http://user@bot', 'https://bot:65536', 'http://bot?key=x', 'https://bot:0']:
            with self.assertRaises(ValueError): self.invoke('init', '--public-url', url)
        self.assertFalse((self.home / '.env').exists())

    def test_preflight_failure_is_json(self):
        with patch.object(deploy, 'docker_platform', side_effect=ValueError('unsupported')), contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as failure: deploy.main(self.args + ['doctor'])
            self.assertEqual(failure.exception.code, 1); self.assertFalse(json.loads(out.getvalue())['ok'])

    def test_archive_flags_keep_pinned_build_path(self):
        archive = self.home / 'original.tgz'; archive.touch()
        args = SimpleNamespace(host_only=True, host_archive=archive, box_archive=None)
        with patch.object(deploy, 'run') as called: deploy.build(args, 'candidate')
        self.assertEqual(called.call_args.args[0][-3:], ['--host-only', '--host-archive', str(archive.resolve())])

    def test_runtime_versions_require_subpath_capable_engine_and_compose(self):
        def versions(server, compose='2.26.0'):
            def run(cmd, **kwargs):
                if cmd[1] == 'version':
                    return SimpleNamespace(stdout=json.dumps(server))
                self.assertEqual(cmd, ['docker', 'compose', 'version', '--short'])
                return SimpleNamespace(stdout=compose)
            return run

        server = {'Version': '26.0.0', 'ApiVersion': '1.45'}
        with patch.object(deploy, 'run', side_effect=versions(server)):
            self.assertEqual(deploy.check_runtime_versions(), {
                'dockerEngineVersion': '26.0.0', 'dockerApiVersion': '1.45', 'composeVersion': '2.26.0'})
        ubuntu = {'Version': '26.1.5+dfsg1', 'ApiVersion': '1.45'}
        with patch.object(deploy, 'run', side_effect=versions(ubuntu, '2.40.3+ds1-0ubuntu1~24.04.1')):
            self.assertEqual(deploy.check_runtime_versions()['composeVersion'], '2.40.3')
        for old_server, old_compose, message in [
            ({'Version': '25.0.9', 'ApiVersion': '1.44'}, '2.26.0', 'Docker Engine 25.0.9 is too old'),
            ({'Version': '26.0.0', 'ApiVersion': '1.44'}, '2.26.0', 'Docker API 1.44.0 is too old'),
            (server, '2.25.0', 'Docker Compose 2.25.0 is too old'),
            (server, '2.25.0+ds1-0ubuntu1~22.04.1', 'Docker Compose 2.25.0 is too old'),
            (server, 'dev', 'usable Compose version'),
        ]:
            with self.subTest(message=message), patch.object(deploy, 'run', side_effect=versions(old_server, old_compose)):
                with self.assertRaisesRegex(ValueError, message):
                    deploy.check_runtime_versions()

    def test_init_and_update_reject_old_runtime_before_writing_or_building(self):
        with patch.object(deploy, 'check_runtime_versions', side_effect=ValueError('runtime too old')):
            with self.assertRaisesRegex(ValueError, 'runtime too old'):
                self.invoke('init')
        self.assertFalse((self.home / '.env').exists())

        (self.home / '.env').write_text('PROKBOT_MODE=local\nPROKBOT_PROJECT=demo\n', encoding='utf-8')
        with patch.object(deploy, 'check_runtime_versions', side_effect=ValueError('runtime too old')), \
             patch.object(deploy, 'build') as build:
            with self.assertRaisesRegex(ValueError, 'runtime too old'):
                self.invoke('update')
            build.assert_not_called()

    def test_host_only_skips_subpath_runtime_gate(self):
        with patch.object(deploy, 'check_runtime_versions', side_effect=ValueError('runtime too old')) as gate:
            self.invoke('--host-only', 'init')
            with patch.object(deploy, 'operate') as operate, \
                 patch.object(deploy.volume_backup, 'project_lock', return_value=contextlib.nullcontext()):
                self.invoke('--host-only', 'update')
            operate.assert_called_once()
            gate.assert_not_called()
        self.assertIn('PROKBOT_MODE=remote', (self.home / '.env').read_text())


class ComposeMountTests(unittest.TestCase):
    dc = ['docker', 'compose', '-p', 'demo']
    image_id = 'sha256:' + '1' * 64

    @staticmethod
    def config(existing=False, box=False):
        specs = {'host': ('host:local', [('host-data', '/data')])}
        if box:
            specs['box'] = (deploy.BOX['localTag'], [('box-home', '/home/box'), ('box-workspace', '/workspace')])
        services, volumes = {}, {}
        for service, (image, pairs) in specs.items():
            services[service] = {'image': image, 'volumes': [
                {'type': 'volume', 'source': name, 'target': dest} for name, dest in pairs]}
            if service == 'box':
                services[service]['volumes'].extend(
                    {'type': 'volume', 'source': 'host-data', 'target': target,
                     'volume': {'subpath': str(backup.DATA_SOURCE_ROOT / tree)}}
                    for target, tree in backup.BOX_DATA_TARGETS.items())
            for name, _ in pairs:
                volumes[name] = {'name': 'demo_' + name}
                if existing:
                    volumes[name]['external'] = True
        return {'services': services, 'volumes': volumes}

    @contextlib.contextmanager
    def config_only(self, config, existing, pinned=None):
        def read(cmd, **kwargs):
            self.assertEqual(cmd, self.dc + ['config', '--format', 'json'])
            self.assertTrue(kwargs['capture'])
            env = kwargs['env']
            self.assertEqual(env['PROKBOT_EXISTING_VOLUMES'], 'true' if existing else 'false')
            for service, image in (pinned or {}).items():
                self.assertEqual(env['GROKBOT_' + service.upper() + '_IMAGE'], image)
            return SimpleNamespace(stdout=json.dumps(config))

        with patch.object(deploy, 'run', side_effect=read) as run, \
             patch('subprocess.Popen', side_effect=AssertionError('Unexpected external process')):
            try:
                yield
            finally:
                run.assert_called_once()

    def images(self, config, existing=False):
        with self.config_only(config, existing):
            return deploy.instance_images(self.dc, 'demo', tuple(config['services']), existing)

    def test_supported_mounts_and_non_overlapping_tmpfs(self):
        for box in (False, True):
            for existing in (False, True):
                with self.subTest(box=box, existing=existing):
                    config = self.config(existing, box)
                    services = config['services']
                    images = {s: v['image'] for s, v in services.items()}
                    self.assertEqual(self.images(config, existing), images)
                    services['host']['volumes'].insert(0, {'type': 'tmpfs', 'target': '/database'})
                    services['host']['tmpfs'] = '/run:mode=0700'
                    if box:
                        services['box']['volumes'].reverse()
                        services['box']['tmpfs'] = ['/home/box-old', '/run:mode=0700']
                    self.assertEqual(self.images(config, existing), images)

    def test_rejects_extra_duplicate_and_shadowing_mounts(self):
        cases = [('host', 'bind', '/fixture', '/logs'), ('host', 'volume', 'extra', '/logs'),
                 ('host', 'volume', None, '/scratch'), ('host', 'volume', 'host-data', '/copy'),
                 ('host', 'volume', 'host-data', '/data'), ('host', 'bind', '/fixture', '/data'),
                 ('host', 'volume', 'extra', '/data/uploads'), ('box', 'bind', '/fixture', '/workspace/logs'),
                 ('box', 'bind', '/fixture', '/home/box/sand-data/agents'),
                 ('box', 'volume', 'host-data', '/data/runtime/host-data/agent-transcripts'),
                 ('host', 'tmpfs', None, '/'), ('box', 'tmpfs', None, '/home'),
                 ('host', 'tmpfs', None, '//data/.'), ('host', 'tmpfs', None, '/scratch/../data/cache')]
        for service, kind, source, target in cases:
            with self.subTest(service=service, kind=kind, target=target):
                config = self.config(box=True)
                mount = {'type': kind, 'target': target}
                if source is not None:
                    mount['source'] = source
                if source == 'extra':
                    config['volumes'][source] = {'name': 'demo_extra'}
                config['services'][service]['volumes'].append(mount)
                with self.assertRaisesRegex(ValueError, service):
                    self.images(config)

    def test_checks_mounts_outside_service_volumes_list(self):
        for key, value in [('tmpfs', '/data:mode=0700'), ('tmpfs', ['/data/cache:size=64k']),
                           ('tmpfs', ['/run/.:mode=0700']), ('volumes_from', ['container:peer']),
                           ('configs', [{'source': 'cfg', 'target': '/data/cfg'}]),
                           ('secrets', [{'source': 'key'}]), ('use_api_socket', True)]:
            with self.subTest(key=key, value=value):
                config = self.config()
                config['services']['host']['volumes'].append({'type': 'tmpfs', 'target': '/run'})
                config['services']['host'][key] = value
                if key in ('configs', 'secrets'):
                    config[key] = {value[0]['source']: {'file': '/fixture'}}
                with self.assertRaisesRegex(ValueError, 'host'):
                    self.images(config)

    def test_required_volume_is_still_exact_and_writable(self):
        for mount, volume in [(None, {}), ({'source': 'other'}, {}), ({'read_only': True}, {}),
                              ({'type': 'tmpfs'}, {}), ({}, {'name': 'other_host-data'}), ({}, {'external': True})]:
            with self.subTest(mount=mount, volume=volume):
                config = self.config()
                mounts = config['services']['host']['volumes']
                if mount is None:
                    mounts.clear()
                else:
                    mounts[0].update(mount)
                config['volumes']['host-data'].update(volume)
                with self.assertRaisesRegex(ValueError, '/data'):
                    self.images(config)

    def test_existing_volume_subdirectory_is_not_the_managed_data_root(self):
        for service, expected in [('host', '/data'), ('box', '/home/box')]:
            with self.subTest(service=service):
                config = self.config(existing=True, box=True)
                mount = config['services'][service]['volumes'][0]
                mount['volume'] = {'nocopy': True}
                self.assertIn(service, self.images(config, existing=True))
                mount['volume']['subpath'] = 'other-instance'
                with self.assertRaisesRegex(ValueError, expected):
                    self.images(config, existing=True)

    def test_new_install_and_update_reject_before_inventory(self):
        for action in ('up', 'update'):
            with self.subTest(action=action):
                existing = action == 'update'
                config = self.config(existing)
                config['services']['host']['tmpfs'] = ['/data/cache']
                args = SimpleNamespace(action=action, host_only=True, project='demo')
                with self.config_only(config, existing), patch.object(deploy, 'inventory') as inventory:
                    with self.assertRaisesRegex(ValueError, '/data/cache'):
                        deploy.operate(args, None, self.dc)
                    inventory.assert_not_called()

    def test_last_preflight_rejects_before_compose_up(self):
        images = {'host': self.image_id}
        for existing in (False, True):
            with self.subTest(existing=existing):
                config = self.config(existing)
                config['services']['host'].update(image=self.image_id, tmpfs=['/data/cache'])
                with self.config_only(config, existing, images), self.assertRaisesRegex(ValueError, '/data/cache'):
                    deploy.up_and_wait(self.dc, 'demo', ('host',), images, existing=existing)

    def test_post_build_preflight_rejects_before_stop_or_backup(self):
        config = self.config(existing=True)
        config['services']['host']['tmpfs'] = ['/data/cache']
        old = {'host': {'Id': 'original', 'Image': self.image_id, 'State': {'Status': 'running'}}}
        staged = contextlib.nullcontext({'host': 'sha256:' + '2' * 64})
        with self.config_only(config, True), patch.object(deploy, 'tag_state', return_value=self.image_id), \
             patch.object(deploy, 'image_id', return_value=self.image_id), patch.object(deploy, 'staged_host', return_value=staged), \
             patch.object(deploy, 'inventory', return_value=old), patch.object(deploy, 'backup') as backup:
            with self.assertRaisesRegex(ValueError, '/data/cache'):
                deploy.upgrade(SimpleNamespace(project='demo'), None, self.dc, ('host',), 'host:local', old, 'demo', False)
            backup.assert_not_called()

    def test_recovery_preflight_rejects_before_writing_volumes(self):
        config = self.config(existing=True)
        config['services']['host'].update(image=self.image_id, tmpfs=['/data/cache'])
        images = {'host': self.image_id}
        manifest = {'project': 'original', 'serviceImages': images, 'volumes': [{'suffix': 'host-data'}]}
        args = SimpleNamespace(project='demo', directory=Mock(spec=Path))
        with self.config_only(config, True, images), patch.object(deploy.volume_backup, 'read_manifest', return_value=manifest), \
             patch.object(deploy, 'image_id', return_value=self.image_id), patch.object(deploy, 'check_platform'), \
             patch.object(deploy.volume_backup, 'restore') as restore:
            with self.assertRaisesRegex(ValueError, '/data/cache'):
                deploy.recover(args, None, self.dc, ('host',))
            restore.assert_not_called()


if __name__ == '__main__':
    unittest.main()

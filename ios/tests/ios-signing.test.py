"""Signing entitlement and Expo token-store configuration tests."""
from pathlib import Path
import io
import json
import plistlib
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch


IOS_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(IOS_ROOT / 'patchers' / 'ios'))
import signing  # noqa: E402


def profile(
    bundle_id='dev.example.app',
    prefix='TEAM123456',
    groups=None,
    keychains=None,
):
    return {
        'ApplicationIdentifierPrefix': [prefix],
        'TeamIdentifier': [prefix],
        'Entitlements': {
            'application-identifier': prefix + '.' + bundle_id,
            'keychain-access-groups': keychains or [prefix + '.*'],
            'com.apple.security.application-groups': groups or [],
            'get-task-allow': True,
        },
    }


class EntitlementTests(unittest.TestCase):
    def test_main_and_extensions_get_default_and_shared_keychain_groups(self):
        main = profile(groups=['group.dev.example.app'])
        values = signing.entitlements(
            main, 'dev.example.app', 'group.dev.example.app', 'dev.example.app'
        )
        self.assertEqual(
            values['keychain-access-groups'],
            [
                'TEAM123456.dev.example.app',
                'TEAM123456.dev.example.app.shared',
            ],
        )
        self.assertEqual(
            values['com.apple.security.application-groups'],
            ['group.dev.example.app'],
        )

    def test_profile_without_app_group_omits_the_entitlement_and_warns(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            values = signing.entitlements(
                profile(), 'dev.example.app', 'group.dev.example.app', 'dev.example.app'
            )
        self.assertNotIn('com.apple.security.application-groups', values)
        self.assertIn('does not authorize App Group group.dev.example.app', stderr.getvalue())

    def test_sign_uses_team_identifier_for_expo_config_and_updates_extension_app_protection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'Demo.app'
            ext = app / 'PlugIns' / 'Widgets.appex'
            (app / 'EXConstants.bundle').mkdir(parents=True)
            ext.mkdir(parents=True)
            (app / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': 'dev.example.app',
                'CFBundleExecutable': 'Demo',
                'GrokAppProtection': {'appGroupIdentifiers': ['group.old'], 'keychainAccessGroups': ['OLD.group']},
            }))
            (ext / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': 'dev.example.app.widgets',
                'CFBundleExecutable': 'Widgets',
                'GrokAppProtection': {'appGroupIdentifiers': ['group.old'], 'keychainAccessGroups': ['OLD.group']},
            }))
            (app / 'Demo').write_bytes(b'not-macho')
            (ext / 'Widgets').write_bytes(b'not-macho')
            cfg = json.dumps({'ios': {'appleTeamId': 'OLDTEAM'}, 'extra': {'appleTeamId': 'OLDTEAM'}}).encode()
            (app / 'EXConstants.bundle' / 'app.config').write_bytes(cfg.ljust(512, b' '))
            main_mp = root / 'main.mobileprovision'
            ext_mp = root / 'ext.mobileprovision'
            main_mp.write_bytes(b'main')
            ext_mp.write_bytes(b'ext')

            def fake_profile(path):
                bid = 'dev.example.app' if path == main_mp else 'dev.example.app.widgets'
                return {
                    'Name': 'Test',
                    'ApplicationIdentifierPrefix': ['PREFIX9999'],
                    'TeamIdentifier': ['TEAMID1234'],
                    'Entitlements': {
                        'application-identifier': f'PREFIX9999.{bid}',
                        'keychain-access-groups': ['PREFIX9999.*'],
                        'com.apple.security.application-groups': ['group.dev.example.app'],
                        'get-task-allow': True,
                    },
                }

            with patch.object(signing, 'profile', side_effect=fake_profile), \
                 patch.object(signing.subprocess, 'run') as mock_run:
                signing.sign(
                    app=app,
                    identity='TEST',
                    main_profile=main_mp,
                    extension_profiles={'Widgets.appex': ext_mp},
                    group='group.dev.example.app',
                    records=[{'name': 'Widgets.appex'}],
                    commands=lambda _b: [],
                    output=root,
                )
            self.assertTrue(mock_run.called)
            updated_cfg = json.loads((app / 'EXConstants.bundle' / 'app.config').read_text(encoding='utf-8'))
            self.assertEqual(updated_cfg['ios']['appleTeamId'], 'TEAMID1234')
            self.assertEqual(updated_cfg['extra']['appleTeamId'], 'TEAMID1234')
            main_info = plistlib.loads((app / 'Info.plist').read_bytes())
            self.assertEqual(main_info['GrokAppProtection']['appGroupIdentifiers'], ['group.dev.example.app'])
            self.assertEqual(
                main_info['GrokAppProtection']['keychainAccessGroups'],
                ['PREFIX9999.dev.example.app', 'PREFIX9999.dev.example.app.shared'],
            )
            ext_info = plistlib.loads((ext / 'Info.plist').read_bytes())
            self.assertEqual(ext_info['GrokAppProtection']['appGroupIdentifiers'], ['group.dev.example.app'])
            self.assertEqual(
                ext_info['GrokAppProtection']['keychainAccessGroups'],
                ['PREFIX9999.dev.example.app.widgets', 'PREFIX9999.dev.example.app.shared'],
            )

    def test_sign_writes_empty_app_group_identifiers_when_profile_lacks_requested_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'Demo.app'
            ext = app / 'PlugIns' / 'Widgets.appex'
            (app / 'EXConstants.bundle').mkdir(parents=True)
            ext.mkdir(parents=True)
            (app / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': 'dev.example.app',
                'CFBundleExecutable': 'Demo',
                'GrokAppProtection': {'appGroupIdentifiers': ['group.dev.example.app'], 'keychainAccessGroups': []},
            }))
            (ext / 'Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier': 'dev.example.app.widgets',
                'CFBundleExecutable': 'Widgets',
                'GrokAppProtection': {'appGroupIdentifiers': ['group.dev.example.app'], 'keychainAccessGroups': []},
            }))
            (app / 'Demo').write_bytes(b'not-macho')
            (ext / 'Widgets').write_bytes(b'not-macho')
            cfg = json.dumps({'ios': {'appleTeamId': 'OLDTEAM'}, 'extra': {'appleTeamId': 'OLDTEAM'}}).encode()
            (app / 'EXConstants.bundle' / 'app.config').write_bytes(cfg.ljust(512, b' '))
            main_mp = root / 'main.mobileprovision'
            ext_mp = root / 'ext.mobileprovision'
            main_mp.write_bytes(b'main')
            ext_mp.write_bytes(b'ext')

            def fake_profile(path):
                bid = 'dev.example.app' if path == main_mp else 'dev.example.app.widgets'
                return {
                    'Name': 'TestNoGroup',
                    'ApplicationIdentifierPrefix': ['PREFIX9999'],
                    'TeamIdentifier': ['TEAMID1234'],
                    'Entitlements': {
                        'application-identifier': f'PREFIX9999.{bid}',
                        'keychain-access-groups': ['PREFIX9999.*'],
                        'com.apple.security.application-groups': [],
                        'get-task-allow': True,
                    },
                }

            stderr = io.StringIO()
            with redirect_stderr(stderr), \
                 patch.object(signing, 'profile', side_effect=fake_profile), \
                 patch.object(signing.subprocess, 'run') as mock_run:
                signing.sign(
                    app=app,
                    identity='TEST',
                    main_profile=main_mp,
                    extension_profiles={'Widgets.appex': ext_mp},
                    group='group.dev.example.app',
                    records=[{'name': 'Widgets.appex'}],
                    commands=lambda _b: [],
                    output=root,
                )
            self.assertTrue(mock_run.called)
            self.assertIn('does not authorize App Group group.dev.example.app', stderr.getvalue())
            main_info = plistlib.loads((app / 'Info.plist').read_bytes())
            ext_info = plistlib.loads((ext / 'Info.plist').read_bytes())
            self.assertEqual(main_info['GrokAppProtection']['appGroupIdentifiers'], [])
            self.assertEqual(ext_info['GrokAppProtection']['appGroupIdentifiers'], [])
            main_ent = plistlib.loads((root / 'Demo.app.entitlements.plist').read_bytes())
            ext_ent = plistlib.loads((root / 'Widgets.appex.entitlements.plist').read_bytes())
            self.assertNotIn('com.apple.security.application-groups', main_ent)
            self.assertNotIn('com.apple.security.application-groups', ext_ent)

    def test_allowed_groups_only_returns_an_authorized_group(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'profile.mobileprovision'
            path.write_bytes(b'fixture')
            with patch.object(
                signing, 'profile', return_value=profile(groups=['group.allowed'])
            ):
                self.assertEqual(
                    signing.entitlements_allowed_groups(path, 'group.allowed'),
                    ['group.allowed'],
                )
                self.assertEqual(
                    signing.entitlements_allowed_groups(path, 'group.other'),
                    [],
                )


class ExpoConfigTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.app = Path(self.temporary.name) / 'Demo.app'
        self.path = self.app / 'EXConstants.bundle' / 'app.config'
        self.path.parent.mkdir(parents=True)

    def write_config(self, value):
        payload = json.dumps(value, separators=(',', ':')).encode()
        self.path.write_bytes(payload.ljust(4096, b' '))

    def test_updates_team_and_removes_previous_team(self):
        value = {
            'ios': {'appleTeamId': 'OLDTEAM'},
            'extra': {
                'appleTeamId': 'OLDTEAM',
                'previousAppleTeamId': 'PREVIOUS',
                'other': True,
            },
        }
        self.write_config(value)
        signing.update_expo_config(self.app, 'NEWTEAM')
        updated = json.loads(self.path.read_text(encoding='utf-8'))
        self.assertEqual(updated['ios']['appleTeamId'], 'NEWTEAM')
        self.assertEqual(updated['extra']['appleTeamId'], 'NEWTEAM')
        self.assertNotIn('previousAppleTeamId', updated['extra'])
        self.assertTrue(updated['extra']['other'])
        self.assertEqual(self.path.stat().st_size, 4096)

    def test_missing_config_fails_without_creating_a_file(self):
        with self.assertRaisesRegex(ValueError, 'Missing Expo app.config'):
            signing.update_expo_config(self.app, 'NEWTEAM')
        self.assertFalse(self.path.exists())

    def test_malformed_config_fails_without_modifying_it(self):
        self.path.write_bytes(b'{not json')
        with self.assertRaisesRegex(ValueError, 'Malformed Expo app.config'):
            signing.update_expo_config(self.app, 'NEWTEAM')
        self.assertEqual(self.path.read_bytes(), b'{not json')

    def test_missing_sections_fail_without_modifying_config(self):
        value = {'ios': {}, 'extra': []}
        self.write_config(value)
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, 'missing ios or extra'):
            signing.update_expo_config(self.app, 'NEWTEAM')
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()

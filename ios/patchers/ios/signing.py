"""Sign the app and its extensions using caller-supplied provisioning profiles."""
import json
import hashlib
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile


def profile(path):
    return plistlib.loads(subprocess.check_output(
        ['security', 'cms', '-D', '-i', str(path)], stderr=subprocess.DEVNULL))


def allows(pattern, value):
    return pattern == value or (pattern.endswith('.*') and value.startswith(pattern[:-1]))


def entitlements(info, bundle_id, group=None, parent_id=None):
    prefix = info['ApplicationIdentifierPrefix'][0]
    allowed = info['Entitlements']
    expected = prefix + '.' + bundle_id
    if not allows(allowed['application-identifier'], expected):
        raise ValueError('Profile does not authorize ' + bundle_id)
    shared = prefix + '.' + parent_id + '.shared' if parent_id else None
    keychain_groups = [expected]
    if shared and shared != expected:
        if not any(allows(value, shared) for value in allowed.get('keychain-access-groups', [])):
            raise ValueError('Profile does not allow the shared keychain group')
        keychain_groups.append(shared)
    result = {'application-identifier': expected,
              'com.apple.developer.team-identifier': info['TeamIdentifier'][0],
              'keychain-access-groups': keychain_groups,
              'get-task-allow': allowed.get('get-task-allow', False)}
    if group:
        if group in allowed.get('com.apple.security.application-groups', []):
            result['com.apple.security.application-groups'] = [group]
        else:
            print(
                f'Warning: provisioning profile for {bundle_id} does not authorize App Group {group}; '
                'omitting com.apple.security.application-groups (widgets, share and notification '
                'extensions may not share state with the main app).',
                file=sys.stderr,
            )
    environment = allowed.get('aps-environment')
    if environment in ('development', 'production'):
        if allowed['application-identifier'] != expected:
            raise ValueError('APNs requires an exact App ID profile')
        result['aps-environment'] = environment
    return result


def update_expo_config(app, team_id):
    """Point Expo's token store at the selected TeamIdentifier without breaking integrity."""

    path = app / 'EXConstants.bundle' / 'app.config'
    if not path.is_file():
        raise ValueError('Missing Expo app.config')
    try:
        config = json.loads(path.read_text(encoding='utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('Malformed Expo app.config') from error
    if not isinstance(config, dict):
        raise ValueError('Expo app.config must be a JSON object')
    ios = config.get('ios')
    extra = config.get('extra')
    if not isinstance(ios, dict) or not isinstance(extra, dict):
        raise ValueError('Expo app.config is missing ios or extra')
    ios['appleTeamId'] = team_id
    extra['appleTeamId'] = team_id
    extra.pop('previousAppleTeamId', None)
    payload = json.dumps(config, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    original_size = path.stat().st_size
    if len(payload) > original_size:
        # Keep the embedded file's size stable because Expo's native reader may
        # be compiled against the stock metadata. The replacement removes a
        # 17-byte value and adds an 11-byte value, so this is normally smaller.
        raise ValueError('Updated Expo app.config is larger than the original')
    payload += b' ' * (original_size - len(payload))
    manifest = path.parent / '.expo-metadata.json'
    if manifest.is_file():
        metadata = json.loads(manifest.read_text(encoding='utf-8'))
        files = metadata.get('files')
        if not isinstance(files, dict):
            raise ValueError('Malformed Expo metadata')
        files['app.config'] = {
            'sha256': hashlib.sha256(payload).hexdigest(),
            'size': len(payload),
        }
        payload_metadata = (
            json.dumps(metadata, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        )
    else:
        payload_metadata = None
    descriptor, temporary = tempfile.mkstemp(
        prefix='.app.config.', dir=path.parent
    )
    metadata_descriptor = metadata_temporary = None
    if payload_metadata is not None:
        metadata_descriptor, metadata_temporary = tempfile.mkstemp(
            prefix='.expo-metadata.', dir=path.parent
        )
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if payload_metadata is not None:
            with os.fdopen(metadata_descriptor, 'wb') as stream:
                stream.write(payload_metadata)
                stream.flush()
                os.fsync(stream.fileno())
        os.replace(temporary, path)
        if payload_metadata is not None:
            os.replace(metadata_temporary, manifest)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
        if metadata_temporary and os.path.exists(metadata_temporary):
            os.unlink(metadata_temporary)


def entitlements_allowed_groups(main_profile, group):
    """Return only App Groups actually authorized by the main profile."""

    if not group or not main_profile:
        return []
    data = profile(main_profile)
    allowed = data.get('Entitlements', {}).get('com.apple.security.application-groups', [])
    return [group] if group in allowed else []


def sign(app, identity, main_profile, extension_profiles, group, records, commands, output):
    bundle_id = plistlib.loads((app / 'Info.plist').read_bytes())['CFBundleIdentifier']
    targets = [(app, main_profile)] + [(app / 'PlugIns' / row['name'], extension_profiles.get(row['name']))
                                      for row in records]
    prepared = []
    team = None
    prefix = None
    for target, path in targets:
        info = plistlib.loads((target / 'Info.plist').read_bytes())
        data = profile(path) if path else None
        if main_profile and not data:
            raise ValueError('Missing extension profile for ' + target.name)
        if data:
            current = data['TeamIdentifier'][0]
            current_prefix = data['ApplicationIdentifierPrefix'][0]
            if team and team != current:
                raise ValueError('App and extensions must use the same signing team')
            if prefix and prefix != current_prefix:
                raise ValueError('App and extensions must use the same App ID prefix')
            team = current
            prefix = current_prefix
            values = entitlements(data, info['CFBundleIdentifier'], group if records else None, bundle_id)
            updated_info = False
            if records:
                info['SandKeychainAccessGroups'] = values['keychain-access-groups']
                updated_info = True
            if isinstance(info.get('GrokAppProtection'), dict):
                info['GrokAppProtection'] = {
                    **info['GrokAppProtection'],
                    'appGroupIdentifiers': list(values.get('com.apple.security.application-groups', [])),
                    'keychainAccessGroups': list(values['keychain-access-groups']),
                }
                updated_info = True
            if updated_info:
                (target / 'Info.plist').write_bytes(plistlib.dumps(info))
            shutil.copy2(path, target / 'embedded.mobileprovision')
        else:
            groups = entitlements_allowed_groups(main_profile, group) if records else []
            values = {'com.apple.security.application-groups': groups} if groups else {}
        prepared.append((target, values, data))
    if team:
        update_expo_config(app, team)
    executables = {target / plistlib.loads((target / 'Info.plist').read_bytes())['CFBundleExecutable']
                   for target, _, _ in prepared}
    for binary in sorted(app.rglob('*'), key=lambda path: -len(path.parts)):
        if binary.is_file() and binary not in executables and commands(binary.read_bytes()):
            subprocess.run(['codesign', '--force', '--sign', identity, '--timestamp=none', str(binary)],
                           check=True, capture_output=True)
    for target, values, _ in reversed(prepared):
        ep = output / (target.name + '.entitlements.plist')
        ep.write_bytes(plistlib.dumps(values))
        subprocess.run(['codesign', '--force', '--sign', identity, '--timestamp=none', '--entitlements',
                        str(ep), str(target)], check=True, capture_output=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True, capture_output=True)
    return prepared[0][2]

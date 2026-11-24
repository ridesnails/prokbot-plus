"""Command line interface for the v98 reader."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .model import HBCFile


def _summary(file: HBCFile) -> dict[str, object]:
    invalid = [
        {'offset': offset, 'opcode': opcode}
        for offset, opcode in file.validation.invalid_opcodes
    ]
    return {
        'version': file.header.version,
        'fileBytes': len(file.data),
        'functionCount': len(file.function_headers),
        'uniqueBodyCount': len(file.body_groups),
        'functionInfoCount': len(file.function_infos),
        'functionSourceCount': file.header.function_source_count,
        'bodyStart': file.body_start,
        'infoStart': file.info_start,
        'debugInfoOffset': file.header.debug_info_offset,
        'stringSwitchImms': file.header.num_string_switch_imms,
        'validationErrors': file.validation.errors,
        'validationWarnings': file.validation.warnings,
        'invalidOpcodes': invalid,
        'sha256': hashlib.sha256(file.data).hexdigest(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--allow-legacy', action='store_true')
    parser.add_argument('--rebuild', type=Path)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)

    file = HBCFile.from_path(args.input, strict=True, allow_legacy=args.allow_legacy)
    if args.rebuild:
        if args.rebuild.exists():
            parser.error('--rebuild output already exists')
        rebuilt = file.rebuild()
        args.rebuild.write_bytes(rebuilt)
    result = _summary(file)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        for key, value in result.items():
            if isinstance(value, (list, dict)):
                continue
            print('%s: %s' % (key, value))
        if result['validationErrors']:
            for error in file.validation.errors:
                print('error: %s' % error)
        if result['invalidOpcodes']:
            for item in result['invalidOpcodes']:
                print('invalid opcode %d at 0x%x' % (item['opcode'], item['offset']))
    return 0 if file.validation.ok else 2


if __name__ == '__main__':
    raise SystemExit(main())

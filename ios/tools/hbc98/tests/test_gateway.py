from __future__ import annotations

import hashlib
import struct
import unittest

from ios.tools.build_ios_126_recipe import build_gateway_body, inject_gateway
from ios.tools.hbc98.opcodes import OpcodeSet


OPCODES = OpcodeSet.load_default()


def _metadata() -> dict[str, object]:
    names = (
        'NewObject',
        'LoadConstString',
        'LoadConstStringLongIndex',
        'LoadConstUInt8',
        'Add',
        'DefineOwnById',
        'DefineOwnByIdLong',
        'Ret',
    )
    return {
        'opcodes': {name: OPCODES.ids[name] for name in names},
        'strings': {str(code): 1000 + code for code in range(33, 127)},
        'emptyString': 1100,
        'urlKey': 1200,
        'tokenKey': 1201,
        'bodyOffset': 64,
        'bodyCapacity': 512,
        'bodyLengthOffset': 48,
    }


class GatewayInjectionTests(unittest.TestCase):
    def test_body_uses_strings_digits_and_both_object_keys(self) -> None:
        metadata = _metadata()
        strings = metadata['strings']
        assert isinstance(strings, dict)
        strings.pop(str(ord('7')))
        body = build_gateway_body(metadata, 'https://host.example/7', 'pair-ABC-9')

        instructions = OPCODES.decode(body, 0, len(body))
        names = [instruction.name for instruction in instructions]
        self.assertEqual(names[0], 'NewObject')
        self.assertEqual(names[-1], 'Ret')
        self.assertIn('LoadConstUInt8', names)
        self.assertEqual(names.count('DefineOwnById'), 2)
        self.assertLessEqual(len(body), 512)

    def test_rejects_non_ascii_addresses(self) -> None:
        with self.assertRaisesRegex(ValueError, 'printable ASCII'):
            build_gateway_body(_metadata(), 'https://例子.example', 'pair')

    def test_injection_updates_length_zero_fills_capacity_and_rehashes(self) -> None:
        template = bytearray(b'\xa5' * 1024)
        output, body = inject_gateway(
            bytes(template),
            _metadata(),
            'https://host.example',
            'pair-ABC-9',
        )

        self.assertEqual(len(output), len(template))
        self.assertEqual(output[64:64 + len(body)], body)
        self.assertFalse(any(output[64 + len(body):64 + 512]))
        self.assertEqual(struct.unpack_from('<I', output, 48)[0], len(body))
        self.assertEqual(hashlib.sha1(output[:-20]).digest(), output[-20:])
        self.assertEqual(output[:48], template[:48])
        self.assertEqual(output[52:64], template[52:64])

    def test_injection_rejects_body_over_capacity(self) -> None:
        metadata = _metadata()
        metadata['bodyCapacity'] = 8
        with self.assertRaisesRegex(ValueError, 'capacity is 8'):
            inject_gateway(bytes(1024), metadata, 'https://host.example', 'pair')


if __name__ == '__main__':
    unittest.main()

from __future__ import annotations

import struct
import unittest
from types import SimpleNamespace

from ios.tools.hbc98.model import HBCFormatError, Section
from ios.tools.hbc98.opcodes import OpcodeSet
from ios.tools.hbc98.strings import (
    ascii_string_map,
    hbc_strings,
    matching_target_instruction_indexes,
    remap_untagged_string_operands,
    unique_string,
)


OPCODES = OpcodeSet.load_default()


def _small_entry(offset: int, length: int, *, utf16: bool = False) -> bytes:
    packed = (offset << 1) | int(utf16) | (length << 24)
    return struct.pack('<I', packed)


def _string_file(
    entries: list[tuple[str, bool]],
    overflow: dict[int, tuple[int, int]],
) -> SimpleNamespace:
    storage = bytearray()
    locations: list[tuple[int, int, bool]] = []
    for text, utf16 in entries:
        raw = text.encode('utf-16-le' if utf16 else 'utf-8')
        locations.append((len(storage), len(text), utf16))
        storage.extend(raw)

    table = bytearray()
    overflow_positions = {
        entry_index: position
        for position, entry_index in enumerate(overflow)
    }
    for index, (offset, length, utf16) in enumerate(locations):
        if index in overflow:
            table.extend(_small_entry(overflow_positions[index], 0xFF, utf16=utf16))
        else:
            table.extend(_small_entry(offset, length, utf16=utf16))
    overflow_data = b''.join(
        struct.pack('<II', offset, length)
        for offset, length in overflow.values()
    )

    table_offset = 112
    overflow_offset = (table_offset + 3 + len(table) + 3) & ~3
    storage_offset = (overflow_offset + 2 + len(overflow_data) + 3) & ~3
    sections = {
        'small_string_table': Section('small_string_table', table_offset, b'abc', bytes(table)),
        'overflow_string_table': Section('overflow_string_table', overflow_offset, b'de', overflow_data),
        'string_storage': Section('string_storage', storage_offset, b'f', bytes(storage)),
    }
    data = bytearray(storage_offset + 1 + len(storage) + 32)
    for section in sections.values():
        start = section.offset + len(section.padding)
        data[start:start + len(section.data)] = section.data
    return SimpleNamespace(
        header=SimpleNamespace(string_count=len(entries)),
        sections=sections,
        data=bytes(data),
    )


def _ascii_entries(characters: str) -> list[tuple[str, bool]]:
    return [(character, False) for character in characters]


def _instruction(name: str, *values: int) -> bytes:
    result = bytearray([OPCODES.ids[name]])
    for operand, value in zip(OPCODES.operands(name), values):
        width = {
            'Reg8': 1,
            'UInt8': 1,
            'UInt16': 2,
            'UInt32': 4,
        }[operand]
        result.extend(value.to_bytes(width, 'little'))
    return bytes(result)


class HBC98StringTests(unittest.TestCase):
    def test_decodes_utf8_utf16_and_overflow_strings(self) -> None:
        file = _string_file(
            [('alpha', False), ('你好', True), ('overflow', False)],
            {2: (9, 8)},
        )

        entries = hbc_strings(file)

        self.assertEqual([entry.text for entry in entries], ['alpha', '你好', 'overflow'])
        self.assertFalse(entries[0].is_utf16)
        self.assertEqual(entries[0].byte_length, 5)
        self.assertTrue(entries[1].is_utf16)
        self.assertEqual(entries[1].byte_length, 4)
        self.assertEqual(
            entries[2].storage_offset,
            file.sections['string_storage'].offset + 1 + 9,
        )

    def test_rejects_string_storage_outside_its_section(self) -> None:
        file = _string_file([('outside', False)], {})
        sections = dict(file.sections)
        sections['string_storage'] = Section(
            'string_storage',
            file.sections['string_storage'].offset,
            b'',
            b'',
        )
        file.sections = sections

        with self.assertRaisesRegex(HBCFormatError, 'storage is outside the section'):
            hbc_strings(file)

    def test_unique_string_requires_exactly_one_match(self) -> None:
        file = _string_file([('only', False), ('duplicate', False), ('duplicate', False)], {})

        self.assertEqual(unique_string(file, 'only').index, 0)
        with self.assertRaisesRegex(ValueError, 'found 0'):
            unique_string(file, 'missing')
        with self.assertRaisesRegex(ValueError, 'found 2'):
            unique_string(file, 'duplicate')

    def test_ascii_map_accepts_each_printable_character_once(self) -> None:
        characters = ''.join(chr(code) for code in range(33, 127))
        file = _string_file(_ascii_entries(characters), {})

        result = ascii_string_map(file)

        self.assertEqual(len(result), 94)
        self.assertEqual(result['!'], 0)
        self.assertEqual(result['~'], 93)

    def test_ascii_map_rejects_missing_and_duplicate_characters(self) -> None:
        characters = ''.join(chr(code) for code in range(33, 127))
        missing = _string_file(_ascii_entries(characters[1:]), {})
        duplicate = _string_file(_ascii_entries(characters + '!'), {})

        with self.assertRaisesRegex(ValueError, 'one table entry'):
            ascii_string_map(missing)
        with self.assertRaisesRegex(ValueError, 'one table entry'):
            ascii_string_map(duplicate)

    def test_remaps_only_legacy_origin_define_own_by_id(self) -> None:
        source = _string_file(
            [
                ('changes', False),
                ('stable', False),
                ('readCache', False),
                ('targetOnlyKey', False),
            ],
            {},
        )
        target = _string_file(
            [
                ('Balanced', False),
                ('stable', False),
                ('exclusive', False),
                ('EMPTY_LOG', False),
                ('changes', False),
                ('filler', False),
                ('readCache', False),
            ],
            {},
        )
        first = _instruction('DefineOwnById', 0, 1, 0, 0)
        stable = _instruction('DefineOwnById', 0, 1, 0, 1)
        second = _instruction('DefineOwnById', 0, 1, 0, 2)
        target_index = _instruction('DefineOwnById', 0, 1, 0, 3)
        body = first + stable + second + target_index + _instruction('Ret', 0)

        result = remap_untagged_string_operands(
            source,
            target,
            body,
            OPCODES,
            source_instruction_indexes={0, 1, 2},
        )

        self.assertEqual([item.text for item in result.changes], ['changes', 'readCache'])
        self.assertEqual([item.target_index for item in result.changes], [4, 6])
        self.assertEqual(result.preserved, (len(first) + len(stable) + len(second),))
        decoded = OPCODES.decode(result.body, 0, len(result.body))
        self.assertEqual(decoded[0].operands[3], 4)
        self.assertEqual(decoded[1].operands[3], 1)
        self.assertEqual(decoded[2].operands[3], 6)
        self.assertEqual(decoded[3].operands[3], 3)
        self.assertEqual(len(result.body), len(body))

    def test_rejects_a_legacy_property_missing_from_the_target(self) -> None:
        source = _string_file([('missingTarget', False)], {})
        target = _string_file([('unrelated', False)], {})
        body = _instruction('DefineOwnById', 0, 1, 0, 0)

        with self.assertRaisesRegex(ValueError, 'missing target string'):
            remap_untagged_string_operands(source, target, body, OPCODES)

    def test_promotes_define_own_by_id_when_target_index_is_wide(self) -> None:
        source = _string_file([('wideKey', False)], {})
        target = _string_file(
            [('filler', False)] * 65536 + [('wideKey', False)],
            {},
        )
        body = _instruction('DefineOwnById', 0, 1, 0, 0) + _instruction('Ret', 0)

        result = remap_untagged_string_operands(source, target, body, OPCODES)

        decoded = OPCODES.decode(result.body, 0, len(result.body))
        self.assertEqual(decoded[0].name, 'DefineOwnByIdLong')
        self.assertEqual(decoded[0].operands[3], 65536)
        self.assertEqual(decoded[1].name, 'Ret')
        self.assertEqual(result.changes[0].target_index, 65536)

    def test_matching_target_indexes_distinguishes_inserted_legacy_code(self) -> None:
        target = _string_file([('unused', False)], {})
        target.opcodes = OPCODES
        target_body = (
            _instruction('DefineOwnById', 0, 1, 0, 0)
            + _instruction('Ret', 0)
        )
        body = (
            _instruction('DefineOwnById', 0, 1, 1, 7)
            + _instruction('DefineOwnByIdLong', 0, 1, 0, 0)
            + _instruction('Ret', 0)
        )

        indexes = matching_target_instruction_indexes(target, target_body, body)

        self.assertEqual(indexes, frozenset({1, 2}))


if __name__ == '__main__':
    unittest.main()

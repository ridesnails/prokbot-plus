"""Small-string-table access for Hermes bytecode v98."""

from __future__ import annotations

import difflib
import struct
from dataclasses import dataclass
from typing import Collection

from .model import HBCFile, HBCFormatError, STRING_SWITCH, UINT_SWITCH
from .opcodes import OPERAND_WIDTHS, OpcodeSet


@dataclass(frozen=True)
class HBCString:
    index: int
    text: str
    is_utf16: bool
    storage_offset: int
    byte_length: int


@dataclass(frozen=True)
class StringOperandRemap:
    offset: int
    opcode: str
    source_index: int
    target_index: int
    text: str


@dataclass(frozen=True)
class StringOperandRemapResult:
    body: bytes
    changes: tuple[StringOperandRemap, ...]
    preserved: tuple[int, ...]


# ``DefineOwnById`` stores a string-table index in its final operand, but the
# public v98 opcode table describes it only as UInt8/UInt16/UInt32. The porting
# pipeline therefore treats it as a scalar unless it is handled explicitly.
UNTAGGED_STRING_OPERANDS = {
    'DefineOwnById': (3,),
    'DefineOwnByIdLong': (3,),
}


def hbc_strings(file: HBCFile) -> tuple[HBCString, ...]:
    """Decode every small-string-table entry and record its file location."""

    table = file.sections['small_string_table']
    overflow = file.sections['overflow_string_table']
    storage = file.sections['string_storage']
    table_offset = table.offset + len(table.padding)
    overflow_offset = overflow.offset + len(overflow.padding)
    storage_offset = storage.offset + len(storage.padding)
    result = []
    for index in range(file.header.string_count):
        packed = struct.unpack_from('<I', file.data, table_offset + index * 4)[0]
        is_utf16 = bool(packed & 1)
        offset = (packed >> 1) & ((1 << 23) - 1)
        length = (packed >> 24) & 0xFF
        if length == 0xFF:
            entry_offset = overflow_offset + offset * 8
            if entry_offset + 8 > overflow_offset + len(overflow.data):
                raise HBCFormatError(
                    f'String {index} overflow entry is outside the table'
                )
            offset, length = struct.unpack_from('<II', file.data, entry_offset)
        byte_length = length * 2 if is_utf16 else length
        absolute = storage_offset + offset
        if absolute + byte_length > storage_offset + len(storage.data):
            raise HBCFormatError(f'String {index} storage is outside the section')
        raw = file.data[absolute:absolute + byte_length]
        text = raw.decode('utf-16-le' if is_utf16 else 'utf-8')
        result.append(HBCString(index, text, is_utf16, absolute, byte_length))
    return tuple(result)


def ascii_string_map(file: HBCFile) -> dict[str, int]:
    """Build the single-character map used by the native gateway injector."""

    indexes: dict[str, list[int]] = {chr(code): [] for code in range(33, 127)}
    for entry in hbc_strings(file):
        if len(entry.text) == 1 and entry.text in indexes:
            indexes[entry.text].append(entry.index)
    ambiguous = {text: values for text, values in indexes.items() if len(values) != 1}
    if ambiguous:
        raise ValueError(
            'Printable ASCII strings must have one table entry each: '
            f'{ambiguous}'
        )
    return {text: values[0] for text, values in indexes.items()}


def unique_string(file: HBCFile, text: str) -> HBCString:
    matches = [entry for entry in hbc_strings(file) if entry.text == text]
    if len(matches) != 1:
        raise ValueError(f'Expected one {text!r} string, found {len(matches)}')
    return matches[0]


def remap_untagged_string_operands(
    source: HBCFile,
    target: HBCFile,
    body: bytes,
    opcodes: OpcodeSet,
    source_instruction_indexes: Collection[int] | None = None,
) -> StringOperandRemapResult:
    """Remap legacy-origin ``DefineOwnById`` property keys by string content.

    Ported function bodies can contain instructions copied from both the legacy
    function and the target release. The caller supplies which instruction
    indexes came from the legacy source; target-origin instructions are left
    untouched because their string indexes already belong to the target table.
    If a legacy key is absent from the target, porting fails instead of guessing
    that the old numeric index happened to mean a different target string.

    If an index crosses the short operand limit, the instruction is promoted to
    its long form and all relative branches are re-encoded. Bodies containing
    switch tables are refused because those table payloads also contain
    relative offsets and require a separate rewrite.
    """

    source_strings = hbc_strings(source)
    target_strings = hbc_strings(target)
    target_by_text: dict[str, int] = {}
    for entry in target_strings:
        target_by_text.setdefault(entry.text, entry.index)

    instructions = opcodes.decode(body, 0, len(body))
    if source_instruction_indexes is None:
        source_instruction_indexes = range(len(instructions))
    source_instruction_indexes = frozenset(source_instruction_indexes)
    output = bytearray(body)
    changes: list[StringOperandRemap] = []
    preserved: list[int] = []
    names = [instruction.name for instruction in instructions]
    operands = [list(instruction.operands) for instruction in instructions]
    promote: set[int] = set()
    for instruction_index, instruction in enumerate(instructions):
        if instruction_index not in source_instruction_indexes:
            if instruction.name in ('DefineOwnById', 'DefineOwnByIdLong'):
                preserved.append(instruction.offset)
            continue
        operand_indexes = UNTAGGED_STRING_OPERANDS.get(instruction.name, ())
        operand_types = opcodes.operands(instruction.name)
        for operand_index in operand_indexes:
            source_index = operands[instruction_index][operand_index]
            if source_index >= len(source_strings):
                raise ValueError(
                    f'{instruction.name} at body offset {instruction.offset} has '
                    f'out-of-range string index {source_index}'
                )
            text = source_strings[source_index].text
            target_index = target_by_text.get(text)
            if target_index is None:
                raise ValueError(
                    f'{instruction.name} at body offset {instruction.offset} '
                    f'references missing target string {text!r}'
                )
            if target_index == source_index:
                continue

            width = OPERAND_WIDTHS[operand_types[operand_index]]
            if target_index >= 1 << (width * 8):
                long_name = _long_variant(instruction.name, opcodes)
                if long_name is None:
                    raise ValueError(
                        f'{instruction.name} at body offset {instruction.offset} '
                        f'needs a wider string index for {text!r}'
                    )
                names[instruction_index] = long_name
                operands[instruction_index][operand_index] = target_index
                promote.add(instruction_index)
            else:
                operands[instruction_index][operand_index] = target_index
                encoded_offset = (
                    instruction.offset
                    + 1
                    + sum(
                        OPERAND_WIDTHS[item]
                        for item in operand_types[:operand_index]
                    )
                )
                output[encoded_offset:encoded_offset + width] = target_index.to_bytes(
                    width, 'little'
                )
            changes.append(
                StringOperandRemap(
                    offset=instruction.offset,
                    opcode=instruction.name,
                    source_index=source_index,
                    target_index=target_index,
                    text=text,
                )
            )

    if promote:
        if any(name in (STRING_SWITCH, UINT_SWITCH) for name in names):
            raise ValueError('Cannot widen a function body containing switch tables')
        output = bytearray(
            _reencode_with_promotions(instructions, names, operands, opcodes)
        )

    return StringOperandRemapResult(
        body=bytes(output),
        changes=tuple(changes),
        preserved=tuple(preserved),
    )


def matching_target_instruction_indexes(
    target: HBCFile,
    target_body: bytes,
    body: bytes,
) -> frozenset[int]:
    """Find output instructions retained from the target function body.

    Hybrid ports contain every target instruction in order, with legacy patch
    instructions inserted between them. Sequence matching therefore identifies
    target-origin instructions without relying on ambiguous string indexes.
    Relative branch operands and short/long opcode widths are normalized because
    those are re-encoded while assembling the hybrid body.
    """

    target_instructions = target.opcodes.decode(
        target_body, 0, len(target_body)
    )
    body_instructions = target.opcodes.decode(body, 0, len(body))
    target_shapes = [
        _portable_instruction_shape(target, instruction)
        for instruction in target_instructions
    ]
    body_shapes = [
        _portable_instruction_shape(target, instruction)
        for instruction in body_instructions
    ]
    matcher = difflib.SequenceMatcher(
        None, target_shapes, body_shapes, autojunk=False
    )
    indexes: set[int] = set()
    for block in matcher.get_matching_blocks():
        indexes.update(range(block.b, block.b + block.size))
    return frozenset(indexes)


def _portable_instruction_shape(
    file: HBCFile,
    instruction,
) -> tuple[str, tuple[int, ...]]:
    names = file.opcodes.ids
    name = instruction.name
    if name == 'GetByIdShort':
        name = 'GetById'
    else:
        for suffix in ('LongIndex', 'Long'):
            if name.endswith(suffix) and name[:-len(suffix)] in names:
                name = name[:-len(suffix)]
                break
    operand_types = file.opcodes.operands(instruction.name)
    operands = tuple(
        0 if operand_type.startswith('Addr') else value
        for operand_type, value in zip(operand_types, instruction.operands)
    )
    return name, operands


def _long_variant(name: str, opcodes: OpcodeSet) -> str | None:
    for suffix in ('LongIndex', 'Long'):
        candidate = name + suffix
        if candidate in opcodes.ids:
            return candidate
    return None


def _signed(value: int, width: int) -> int:
    bits = width * 8
    sign = 1 << (bits - 1)
    return value - (1 << bits) if value & sign else value


def _encode_instruction(name: str, values: list[int], opcodes: OpcodeSet) -> bytes:
    result = bytearray([opcodes.ids[name]])
    for operand_type, value in zip(opcodes.operands(name), values):
        width = OPERAND_WIDTHS[operand_type]
        result.extend(
            value.to_bytes(
                width,
                'little',
                signed=operand_type.startswith('Addr'),
            )
        )
    return bytes(result)


def _reencode_with_promotions(
    instructions,
    names: list[str],
    operands: list[list[int]],
    opcodes: OpcodeSet,
) -> bytes:
    old_body_end = (
        instructions[-1].offset + instructions[-1].size if instructions else 0
    )
    old_by_offset = {
        instruction.offset: index for index, instruction in enumerate(instructions)
    }
    old_by_offset[old_body_end] = len(instructions)

    branch_targets: dict[int, int] = {}
    for instruction_index, instruction in enumerate(instructions):
        operand_types = opcodes.operands(instruction.name)
        if not operand_types or operand_types[0] not in ('Addr8', 'Addr32'):
            continue
        width = OPERAND_WIDTHS[operand_types[0]]
        target = instruction.offset + _signed(instruction.operands[0], width)
        if target not in old_by_offset:
            raise ValueError(
                f'{instruction.name} at body offset {instruction.offset} '
                f'targets non-instruction offset {target}'
            )
        branch_targets[instruction_index] = old_by_offset[target]

    while True:
        offsets: list[int] = []
        cursor = 0
        for name, values in zip(names, operands):
            offsets.append(cursor)
            cursor += 1 + sum(
                OPERAND_WIDTHS[item] for item in opcodes.operands(name)
            )
        body_size = cursor

        changed = False
        for instruction_index, target_index in branch_targets.items():
            operand_types = opcodes.operands(names[instruction_index])
            width = OPERAND_WIDTHS[operand_types[0]]
            target = body_size if target_index == len(instructions) else offsets[target_index]
            displacement = target - offsets[instruction_index]
            if width == 1 and not -128 <= displacement <= 127:
                long_name = _long_variant(names[instruction_index], opcodes)
                if long_name is None:
                    raise ValueError(
                        f'{names[instruction_index]} at body offset '
                        f'{instructions[instruction_index].offset} cannot be widened'
                    )
                names[instruction_index] = long_name
                changed = True
                break
            operands[instruction_index][0] = displacement
        if not changed:
            return b''.join(
                _encode_instruction(name, values, opcodes)
                for name, values in zip(names, operands)
            )

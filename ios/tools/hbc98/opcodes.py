"""Opcode metadata for Hermes bytecode v98.

The checked-in ``opcodes-v98.json`` table derives its 219 opcode names,
ordering, and operand widths (``Reg8``, ``UInt16``, ``Addr32``, etc.) from
Meta's ``facebook/hermes`` (``include/hermes/BCGen/HBC/BytecodeList.def``,
bytecode version 98, MIT License) using the JSON mapping format popularized
by ``hbctool`` (MIT License). See ``ios/THIRD_PARTY/facebook__hermes/LICENSE``
and ``ios/THIRD_PARTY/hbctool/LICENSE``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


OPERAND_WIDTHS = {
    'Reg8': 1,
    'Reg32': 4,
    'UInt8': 1,
    'UInt16': 2,
    'UInt32': 4,
    'Addr8': 1,
    'Addr32': 4,
    'Imm32': 4,
    'Double': 8,
}


@dataclass(frozen=True)
class Instruction:
    offset: int
    opcode: int
    name: str
    operands: tuple[int, ...]
    size: int


class OpcodeSet:
    """Immutable opcode table loaded from the checked-in v98 definition."""

    def __init__(self, definitions: Mapping[str, Sequence[str]]) -> None:
        self._definitions = {
            name: tuple(operands) for name, operands in definitions.items()
        }
        self._names = tuple(self._definitions)
        self._ids = {name: index for index, name in enumerate(self._names)}
        if len(self._names) > 0x100:
            raise ValueError('v98 opcode IDs do not fit in one byte')
        unknown = {
            operand
            for operands in self._definitions.values()
            for operand in operands
            if operand not in OPERAND_WIDTHS
        }
        if unknown:
            raise ValueError('Unknown operand types: %s' % ', '.join(sorted(unknown)))

    @classmethod
    def load_default(cls) -> 'OpcodeSet':
        path = Path(__file__).with_name('opcodes-v98.json')
        with path.open(encoding='utf-8') as stream:
            return cls(json.load(stream))

    @property
    def names(self) -> tuple[str, ...]:
        return self._names

    @property
    def ids(self) -> Mapping[str, int]:
        return self._ids

    def operands(self, name: str) -> tuple[str, ...]:
        return self._definitions[name]

    def instruction_size(self, name: str) -> int:
        return 1 + sum(OPERAND_WIDTHS[item] for item in self.operands(name))

    def decode_one(self, data: bytes, offset: int, limit: int) -> Instruction:
        if offset >= limit:
            raise ValueError('Instruction starts outside its body')
        opcode = data[offset]
        if opcode >= len(self._names):
            raise ValueError('Unknown opcode %d' % opcode)
        name = self._names[opcode]
        operands: list[int] = []
        cursor = offset + 1
        for operand in self.operands(name):
            width = OPERAND_WIDTHS[operand]
            if cursor + width > limit:
                raise ValueError('Truncated %s instruction' % name)
            operands.append(int.from_bytes(data[cursor:cursor + width], 'little'))
            cursor += width
        return Instruction(offset, opcode, name, tuple(operands), cursor - offset)

    def decode(self, data: bytes, offset: int, size: int) -> tuple[Instruction, ...]:
        limit = offset + size
        instructions: list[Instruction] = []
        cursor = offset
        while cursor < limit:
            instruction = self.decode_one(data, cursor, limit)
            instructions.append(instruction)
            cursor += instruction.size
        return tuple(instructions)

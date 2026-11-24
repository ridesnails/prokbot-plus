"""Strict reader/rebuilder for Hermes bytecode version 98.

The parser deliberately keeps each canonical section as raw bytes. This avoids
inventing fields that the v98 writer does not preserve while still validating
the structures needed for semantic function-body edits.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Iterable

from .opcodes import Instruction, OpcodeSet


MAGIC = 0x1F1903C103BC1FC6
VERSION = 98
HEADER_SIZE = 128
FOOTER_SIZE = 20
SMALL_HEADER_SIZE = 12
FULL_HEADER_SIZE = 37

HAS_EXCEPTION_HANDLER = 0x08
HAS_DEBUG_INFO = 0x10
OVERFLOWED = 0x20

UINT_SWITCH = 'UIntSwitchImm'
STRING_SWITCH = 'StringSwitchImm'


class HBCFormatError(ValueError):
    """Raised when a bytecode file violates the v98 on-disk format."""


def align4(value: int) -> int:
    return (value + 3) & ~3


def _checked_slice(data: bytes, start: int, size: int, label: str) -> bytes:
    if start < 0 or size < 0 or start + size > len(data):
        raise HBCFormatError('%s is outside the file' % label)
    return data[start:start + size]


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<I', data, offset)[0]


def _i32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<i', data, offset)[0]


def _opcode_shape(name: str, opcodes: OpcodeSet) -> str:
    for suffix in ('LongIndex', 'Long'):
        base = name[:-len(suffix)]
        if name.endswith(suffix) and base in opcodes.ids:
            return base
    return name


@dataclass(frozen=True)
class Header:
    magic: int
    version: int
    source_hash: bytes
    file_length: int
    global_code_index: int
    function_count: int
    string_kind_count: int
    identifier_count: int
    string_count: int
    overflow_string_count: int
    string_storage_size: int
    bigint_count: int
    bigint_storage_size: int
    regexp_count: int
    regexp_storage_size: int
    literal_value_buffer_size: int
    obj_key_buffer_size: int
    obj_shape_table_count: int
    num_string_switch_imms: int
    segment_id: int
    cjs_module_count: int
    function_source_count: int
    debug_info_offset: int
    options: int
    padding: bytes
    raw: bytes = field(repr=False)

    def encode(self) -> bytes:
        return struct.pack(
            '<QI20s20IB15s',
            self.magic,
            self.version,
            self.source_hash,
            self.file_length,
            self.global_code_index,
            self.function_count,
            self.string_kind_count,
            self.identifier_count,
            self.string_count,
            self.overflow_string_count,
            self.string_storage_size,
            self.bigint_count,
            self.bigint_storage_size,
            self.regexp_count,
            self.regexp_storage_size,
            self.literal_value_buffer_size,
            self.obj_key_buffer_size,
            self.obj_shape_table_count,
            self.num_string_switch_imms,
            self.segment_id,
            self.cjs_module_count,
            self.function_source_count,
            self.debug_info_offset,
            self.options,
            self.padding,
        )


@dataclass(frozen=True)
class Section:
    name: str
    offset: int
    padding: bytes
    data: bytes

    @property
    def end(self) -> int:
        return self.offset + len(self.data)


@dataclass(frozen=True)
class FunctionHeader:
    offset: int
    param_count: int
    loop_depth: int
    bytecode_size: int
    function_name: int
    number_reg_count: int
    non_pointer_reg_count: int
    frame_size: int
    read_cache_size: int
    write_cache_size: int
    num_cache_new_object: int
    private_name_cache_size: int
    flags: int
    raw: bytes = field(repr=False)

    @classmethod
    def parse(cls, data: bytes, offset: int) -> 'FunctionHeader':
        raw = _checked_slice(data, offset, FULL_HEADER_SIZE, 'Full function header')
        values = struct.unpack_from('<8I', raw)
        return cls(
            offset=values[0],
            param_count=values[1],
            loop_depth=values[2],
            bytecode_size=values[3],
            function_name=values[4],
            number_reg_count=values[5],
            non_pointer_reg_count=values[6],
            frame_size=values[7],
            read_cache_size=raw[32],
            write_cache_size=raw[33],
            num_cache_new_object=raw[34],
            private_name_cache_size=raw[35],
            flags=raw[36],
            raw=raw,
        )

    def encode(
        self,
        *,
        offset: int | None = None,
        bytecode_size: int | None = None,
        flags: int | None = None,
    ) -> bytes:
        raw = bytearray(self.raw if len(self.raw) == FULL_HEADER_SIZE else b'\0' * FULL_HEADER_SIZE)
        struct.pack_into(
            '<8I',
            raw,
            0,
            self.offset if offset is None else offset,
            self.param_count,
            self.loop_depth,
            self.bytecode_size if bytecode_size is None else bytecode_size,
            self.function_name,
            self.number_reg_count,
            self.non_pointer_reg_count,
            self.frame_size,
        )
        raw[32] = self.read_cache_size
        raw[33] = self.write_cache_size
        raw[34] = self.num_cache_new_object
        raw[35] = self.private_name_cache_size
        raw[36] = self.flags if flags is None else flags
        return bytes(raw)

    @property
    def has_exception_handler(self) -> bool:
        return bool(self.flags & HAS_EXCEPTION_HANDLER)

    @property
    def has_debug_info(self) -> bool:
        return bool(self.flags & HAS_DEBUG_INFO)


@dataclass(frozen=True)
class SmallFunctionHeader:
    index: int
    offset: int
    param_count: int
    loop_depth: int
    bytecode_size: int
    function_name: int
    number_reg_count: int
    non_pointer_reg_count: int
    frame_size: int
    read_cache_size: int
    write_cache_size: int
    num_cache_new_object: int
    private_name_cache_size: int
    flags: int
    raw: bytes = field(repr=False)
    full_header_offset: int | None = None
    full_header: FunctionHeader | None = None

    @classmethod
    def parse(cls, data: bytes, index: int, offset: int) -> 'SmallFunctionHeader':
        raw = _checked_slice(data, offset, SMALL_HEADER_SIZE, 'Small function header')
        words = struct.unpack('<3I', raw)
        w0, w1 = words[0], words[1]
        small = cls(
            index=index,
            offset=w0 & 0x01FFFFFF,
            param_count=(w0 >> 25) & 0x1F,
            loop_depth=(w0 >> 30) & 0x03,
            bytecode_size=w1 & 0x3FFF,
            function_name=(w1 >> 14) & 0xFF,
            number_reg_count=(w1 >> 22) & 0x1F,
            non_pointer_reg_count=(w1 >> 27) & 0x1F,
            frame_size=raw[8],
            read_cache_size=raw[9],
            write_cache_size=raw[10] & 0x3F,
            num_cache_new_object=(raw[10] >> 6) & 1,
            private_name_cache_size=(raw[10] >> 7) & 1,
            flags=raw[11],
            raw=raw,
        )
        if not small.overflowed:
            return small
        pointer = (small.function_name << 24) | small.offset
        return cls(**{**small.__dict__, 'full_header_offset': pointer})

    @property
    def overflowed(self) -> bool:
        return bool(self.flags & OVERFLOWED)

    @property
    def effective(self) -> FunctionHeader | None:
        return self.full_header

    @property
    def effective_offset(self) -> int:
        return self.full_header.offset if self.full_header else self.offset

    @property
    def effective_bytecode_size(self) -> int:
        return self.full_header.bytecode_size if self.full_header else self.bytecode_size


@dataclass(frozen=True)
class ExceptionHandler:
    start: int
    end: int
    target: int


def remap_exception_handlers(
    handlers: Iterable[ExceptionHandler],
    *,
    source_body: bytes,
    target_body: bytes,
    opcodes: OpcodeSet,
) -> tuple[ExceptionHandler, ...]:
    """Map handler boundaries through an instruction-preserving body rewrite.

    The porting pipeline may widen instructions when a string or function index
    crosses an encoding boundary. Opcode names remain aligned, so an old
    instruction boundary maps to the same ordinal boundary in the new body.
    Refuse ambiguous rewrites instead of silently keeping stale byte offsets.
    """
    handlers = tuple(handlers)
    if not handlers:
        return ()
    source_instructions = opcodes.decode(source_body, 0, len(source_body))
    target_instructions = opcodes.decode(target_body, 0, len(target_body))
    source_names = tuple(_opcode_shape(item.name, opcodes) for item in source_instructions)
    target_names = tuple(_opcode_shape(item.name, opcodes) for item in target_instructions)
    if source_names != target_names:
        raise ValueError(
            'Cannot remap exception handlers across different instruction sequences'
        )

    source_starts = {item.offset: index for index, item in enumerate(source_instructions)}
    target_offsets = [item.offset for item in target_instructions] + [len(target_body)]

    def remap(offset: int, label: str, *, allow_body_end: bool) -> int:
        if offset == len(source_body):
            index = len(source_instructions)
        else:
            index = source_starts.get(offset, -1)
        if index < 0:
            raise ValueError(
                'Exception handler %s offset %d is not an instruction boundary'
                % (label, offset)
            )
        if index == len(source_instructions) and not allow_body_end:
            raise ValueError('Exception handler %s cannot target the end of the body' % label)
        return target_offsets[index]

    return tuple(
        ExceptionHandler(
            start=remap(handler.start, 'start', allow_body_end=False),
            end=remap(handler.end, 'end', allow_body_end=True),
            target=remap(handler.target, 'target', allow_body_end=False),
        )
        for handler in handlers
    )


@dataclass(frozen=True)
class FunctionInfo:
    offset: int
    header: FunctionHeader
    exception_handlers: tuple[ExceptionHandler, ...]
    debug_offset: int | None
    end: int
    raw: bytes = field(repr=False)


@dataclass(frozen=True)
class FunctionMetadata:
    """Header fields that can be changed without changing a function body."""

    param_count: int
    loop_depth: int
    function_name: int
    number_reg_count: int
    non_pointer_reg_count: int
    frame_size: int
    read_cache_size: int
    write_cache_size: int
    num_cache_new_object: int
    private_name_cache_size: int
    flags: int

    @classmethod
    def from_header(cls, header: FunctionHeader) -> 'FunctionMetadata':
        return cls(
            param_count=header.param_count,
            loop_depth=header.loop_depth,
            function_name=header.function_name,
            number_reg_count=header.number_reg_count,
            non_pointer_reg_count=header.non_pointer_reg_count,
            frame_size=header.frame_size,
            read_cache_size=header.read_cache_size,
            write_cache_size=header.write_cache_size,
            num_cache_new_object=header.num_cache_new_object,
            private_name_cache_size=header.private_name_cache_size,
            flags=header.flags,
        )

    def to_header(self, *, offset: int, bytecode_size: int) -> FunctionHeader:
        return FunctionHeader(
            offset=offset,
            param_count=self.param_count,
            loop_depth=self.loop_depth,
            bytecode_size=bytecode_size,
            function_name=self.function_name,
            number_reg_count=self.number_reg_count,
            non_pointer_reg_count=self.non_pointer_reg_count,
            frame_size=self.frame_size,
            read_cache_size=self.read_cache_size,
            write_cache_size=self.write_cache_size,
            num_cache_new_object=self.num_cache_new_object,
            private_name_cache_size=self.private_name_cache_size,
            flags=self.flags,
            raw=b'\0' * FULL_HEADER_SIZE,
        )

    def fits_small(self, *, offset: int, bytecode_size: int) -> bool:
        return (
            0 <= offset <= 0x01FFFFFF
            and 0 <= bytecode_size <= 0x3FFF
            and 0 <= self.param_count <= 0x1F
            and 0 <= self.loop_depth <= 0x03
            and 0 <= self.function_name <= 0xFF
            and 0 <= self.number_reg_count <= 0x1F
            and 0 <= self.non_pointer_reg_count <= 0x1F
            and 0 <= self.frame_size <= 0xFF
            and 0 <= self.read_cache_size <= 0xFF
            and 0 <= self.write_cache_size <= 0x3F
            and self.num_cache_new_object in (0, 1)
            and self.private_name_cache_size in (0, 1)
            and 0 <= self.flags <= 0xFF
        )


@dataclass(frozen=True)
class FunctionEdit:
    """Replace a body and/or update its metadata.

    Exception handlers and the debug-data offset are preserved from the input
    function unless their corresponding ``replace_*`` field is true.
    """

    body: bytes | None = None
    metadata: FunctionMetadata | None = None
    exception_handlers: tuple[ExceptionHandler, ...] | None = None
    debug_offset: int | None = None
    replace_exception_handlers: bool = False
    replace_debug_offset: bool = False


@dataclass(frozen=True)
class NewFunction:
    body: bytes
    metadata: FunctionMetadata
    exception_handlers: tuple[ExceptionHandler, ...] = ()
    debug_offset: int | None = None


@dataclass
class _FunctionState:
    metadata: FunctionMetadata
    body: bytes
    bytecode_size: int
    body_offset: int
    exception_handlers: tuple[ExceptionHandler, ...]
    debug_offset: int | None
    force_full: bool
    info_offset: int | None = None


@dataclass(frozen=True)
class SwitchTable:
    kind: str
    instruction_offset: int
    table_offset: int
    count: int
    raw: bytes


@dataclass(frozen=True)
class BodyGroup:
    offset: int
    size: int
    function_indexes: tuple[int, ...]
    aliases: tuple[int, ...]
    instructions: tuple[Instruction, ...]
    switch_tables: tuple[SwitchTable, ...]
    bytes: bytes = field(repr=False)

    @property
    def end(self) -> int:
        return self.offset + len(self.bytes)


@dataclass(frozen=True)
class DebugInfo:
    offset: int
    filename_count: int
    filename_storage_size: int
    file_region_count: int
    debug_data_size: int
    raw: bytes = field(repr=False)


@dataclass
class Validation:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    invalid_opcodes: list[tuple[int, int]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors and not self.invalid_opcodes

    def require_ok(self) -> None:
        if not self.ok:
            details = self.errors + [
                'unknown opcode %d at 0x%x' % (opcode, offset)
                for offset, opcode in self.invalid_opcodes
            ]
            raise HBCFormatError('; '.join(details))


@dataclass
class HBCFile:
    data: bytes = field(repr=False)
    header: Header
    sections: dict[str, Section]
    function_headers: tuple[SmallFunctionHeader, ...]
    function_infos: dict[int, FunctionInfo]
    body_groups: tuple[BodyGroup, ...]
    debug_info: DebugInfo
    footer: bytes
    epilogue: bytes
    body_start: int
    info_start: int
    validation: Validation
    opcodes: OpcodeSet = field(repr=False)

    @classmethod
    def parse(
        cls,
        data: bytes,
        *,
        strict: bool = True,
        allow_legacy: bool = False,
        opcodes: OpcodeSet | None = None,
    ) -> 'HBCFile':
        if len(data) < HEADER_SIZE + FOOTER_SIZE:
            raise HBCFormatError('File is too short for an HBC v98 header and footer')
        header = _parse_header(data)
        if header.magic != MAGIC:
            raise HBCFormatError('Unexpected HBC magic 0x%x' % header.magic)
        if header.version != VERSION:
            raise HBCFormatError('Expected HBC v98, found v%d' % header.version)
        if header.file_length < HEADER_SIZE + FOOTER_SIZE or header.file_length > len(data):
            raise HBCFormatError('Invalid fileLength %d for a %d-byte file' % (header.file_length, len(data)))

        footer_start = header.file_length - FOOTER_SIZE
        footer = data[footer_start:header.file_length]
        expected_hash = hashlib.sha1(data[:footer_start]).digest()
        if footer != expected_hash:
            raise HBCFormatError('Footer SHA-1 does not cover the declared file')

        sections, cursor = _parse_sections(data, header)
        body_start = cursor
        opcode_set = opcodes or OpcodeSet.load_default()
        validation = Validation()

        if body_start > len(data) - FOOTER_SIZE:
            raise HBCFormatError('Canonical sections extend into the footer')

        function_headers = _parse_function_headers(data, header)
        function_infos, info_start = _parse_function_infos(data, header, function_headers, validation)
        linked_headers = _link_full_headers(function_headers, function_infos)

        body_end_hint = min(
            [info.offset for info in function_infos.values()] or [header.debug_info_offset]
        )
        body_groups = _parse_body_groups(
            data,
            linked_headers,
            body_start,
            body_end_hint,
            opcode_set,
            validation,
            allow_legacy,
        )
        _validate_string_switches(header, body_groups, validation)

        debug_info = _parse_debug_info(data, header, footer_start)
        _validate_canonical_layout(
            function_headers,
            function_infos,
            body_groups,
            debug_info,
            validation,
            allow_legacy=allow_legacy,
        )
        _validate_section_padding(sections, validation)

        if strict and not allow_legacy:
            validation.require_ok()

        return cls(
            data=data,
            header=header,
            sections=sections,
            function_headers=linked_headers,
            function_infos=function_infos,
            body_groups=body_groups,
            debug_info=debug_info,
            footer=footer,
            epilogue=data[header.file_length:],
            body_start=body_start,
            info_start=info_start,
            validation=validation,
            opcodes=opcode_set,
        )

    @classmethod
    def from_path(
        cls,
        path: str | Path,
        *,
        strict: bool = True,
        allow_legacy: bool = False,
    ) -> 'HBCFile':
        return cls.parse(Path(path).read_bytes(), strict=strict, allow_legacy=allow_legacy)

    def write(
        self,
        *,
        replacements: dict[int, bytes | FunctionEdit] | None = None,
        additions: Iterable[NewFunction] = (),
        section_overrides: dict[str, bytes] | None = None,
    ) -> bytes:
        """Write a canonical v98 file with semantic body/header changes.

        Existing bytecode is retained in place. Changed bodies are patched in
        place when possible; larger or alias-sensitive changes are appended
        after the original body region. Function info and debug data then move
        as complete canonical sections, so full-header trailers never overlap
        a neighbouring body.
        """
        normalized: dict[int, FunctionEdit] = {}
        for index, value in (replacements or {}).items():
            if not isinstance(index, int) or not 0 <= index < len(self.function_headers):
                raise ValueError('Function index %r is outside the function table' % (index,))
            normalized[index] = value if isinstance(value, FunctionEdit) else FunctionEdit(body=value)

        new_functions = tuple(additions)
        if any(not isinstance(item, NewFunction) for item in new_functions):
            raise TypeError('additions must contain NewFunction values')
        if not new_functions and not normalized:
            return self.rebuild()

        overrides = {name: bytes(data) for name, data in (section_overrides or {}).items()}
        for name, data in overrides.items():
            if name == 'function_headers':
                raise ValueError('function_headers is managed by the writer')
            section = self.sections.get(name)
            if section is None:
                raise ValueError('Unknown canonical section %s' % name)
            if len(data) != len(section.data):
                raise ValueError('%s overrides must preserve the section size' % name)

        delta = len(new_functions) * SMALL_HEADER_SIZE
        new_body_start = self.body_start + delta
        body = bytearray(self.data[self.body_start:self.info_start])
        group_by_offset = {group.offset: group for group in self.body_groups}
        states: list[_FunctionState] = []
        relocated: list[tuple[_FunctionState, bytes, tuple[int, bytes] | None]] = []

        for index, small in enumerate(self.function_headers):
            edit = normalized.get(index, FunctionEdit())
            info = self.function_infos.get(small.full_header_offset) if small.overflowed else None
            original_header = small.effective or FunctionHeader(
                offset=small.offset,
                param_count=small.param_count,
                loop_depth=small.loop_depth,
                bytecode_size=small.bytecode_size,
                function_name=small.function_name,
                number_reg_count=small.number_reg_count,
                non_pointer_reg_count=small.non_pointer_reg_count,
                frame_size=small.frame_size,
                read_cache_size=small.read_cache_size,
                write_cache_size=small.write_cache_size,
                num_cache_new_object=small.num_cache_new_object,
                private_name_cache_size=small.private_name_cache_size,
                flags=small.flags,
                raw=b'\0' * FULL_HEADER_SIZE,
            )
            metadata = edit.metadata or FunctionMetadata.from_header(original_header)
            original_body = _checked_slice(
                self.data,
                original_header.offset,
                original_header.bytecode_size,
                'Function %d body' % index,
            )
            function_body = original_body if edit.body is None else edit.body
            bytecode_size = original_header.bytecode_size if edit.body is None else len(edit.body)
            body_offset = original_header.offset + delta
            group = group_by_offset.get(original_header.offset)
            if group is None:
                raise HBCFormatError('Function %d has no parsed body group' % index)

            existing_exceptions = info.exception_handlers if info is not None else ()
            existing_debug_offset = info.debug_offset if info is not None else None
            exceptions = (
                edit.exception_handlers if edit.replace_exception_handlers else existing_exceptions
            )
            debug_offset = edit.debug_offset if edit.replace_debug_offset else existing_debug_offset

            if edit.body is not None and edit.body != original_body:
                aliases = set(group.function_indexes)
                shared_edit_is_identical = all(
                    alias in normalized
                    and normalized[alias].body is not None
                    and normalized[alias].body == edit.body
                    for alias in aliases
                )
                if len(edit.body) == original_header.bytecode_size and shared_edit_is_identical:
                    start = original_header.offset + delta - new_body_start
                    body[start:start + len(edit.body)] = edit.body
                else:
                    placeholder = _FunctionState(
                        metadata=metadata,
                        body=edit.body,
                        bytecode_size=len(edit.body),
                        body_offset=0,
                        exception_handlers=tuple(exceptions or ()),
                        debug_offset=debug_offset,
                        force_full=small.overflowed,
                    )
                    shared_key = (
                        (original_header.offset, edit.body)
                        if len(aliases) > 1 and shared_edit_is_identical
                        else None
                    )
                    relocated.append((placeholder, edit.body, shared_key))
                    states.append(placeholder)
                    continue
            states.append(
                _FunctionState(
                    metadata=metadata,
                    body=function_body,
                    bytecode_size=bytecode_size,
                    body_offset=body_offset,
                    exception_handlers=tuple(exceptions or ()),
                    debug_offset=debug_offset,
                    force_full=small.overflowed,
                )
            )

        append_cursor = new_body_start + len(body)
        shared_offsets: dict[tuple[int, bytes], int] = {}
        for state, payload, shared_key in relocated:
            if shared_key is not None and shared_key in shared_offsets:
                state.body_offset = shared_offsets[shared_key]
                continue
            append_cursor = align4(append_cursor)
            if append_cursor > len(body) + new_body_start:
                body.extend(b'\0' * (append_cursor - len(body) - new_body_start))
            state.body_offset = append_cursor
            body.extend(payload)
            append_cursor += len(payload)
            if shared_key is not None:
                shared_offsets[shared_key] = state.body_offset

        for addition in new_functions:
            append_cursor = align4(append_cursor)
            if append_cursor > len(body) + new_body_start:
                body.extend(b'\0' * (append_cursor - len(body) - new_body_start))
            state = _FunctionState(
                metadata=addition.metadata,
                body=addition.body,
                bytecode_size=len(addition.body),
                body_offset=append_cursor,
                exception_handlers=tuple(addition.exception_handlers),
                debug_offset=addition.debug_offset,
                force_full=False,
            )
            states.append(state)
            body.extend(addition.body)
            append_cursor += len(addition.body)

        if len(states) != len(self.function_headers) + len(new_functions):
            raise AssertionError('Function state count mismatch')

        for index, state in enumerate(states):
            try:
                _validate_function_state(state, self.opcodes)
            except ValueError as error:
                raise ValueError('Function %d: %s' % (index, error)) from error

        info_start = align4(new_body_start + len(body))
        info_cursor = info_start
        info_payloads: dict[int, bytes] = {}
        for index, state in enumerate(states):
            if not _needs_function_info(state):
                continue
            info_cursor = align4(info_cursor)
            state.info_offset = info_cursor
            payload = _encode_function_info(state)
            info_payloads[index] = payload
            info_cursor += len(payload)

        debug_offset = align4(info_cursor)
        file_length = debug_offset + len(self.debug_info.raw) + FOOTER_SIZE
        string_switch_count = 0
        counted_body_offsets: set[int] = set()
        for state in states:
            if state.body_offset in counted_body_offsets:
                continue
            counted_body_offsets.add(state.body_offset)
            for instruction in self.opcodes.decode(
                state.body[:state.bytecode_size], 0, state.bytecode_size
            ):
                if instruction.name == STRING_SWITCH:
                    string_switch_count += 1
        header = replace(
            self.header,
            file_length=file_length,
            function_count=len(states),
            debug_info_offset=debug_offset,
            num_string_switch_imms=string_switch_count,
        )

        small_headers = bytearray()
        for state in states:
            if _needs_function_info(state):
                if state.info_offset is None:
                    raise AssertionError('Missing function info offset')
                small_headers.extend(_encode_small_pointer(state.info_offset))
            else:
                small_headers.extend(
                    _encode_small_header(
                        state.metadata,
                        offset=state.body_offset,
                        bytecode_size=state.bytecode_size,
                    )
                )

        output = bytearray(header.encode())
        output.extend(small_headers)
        for name, section in self.sections.items():
            if name == 'function_headers':
                continue
            aligned = align4(len(output))
            output.extend(b'\0' * (aligned - len(output)))
            output.extend(overrides.get(name, section.data))
        body_start = align4(len(output))
        output.extend(b'\0' * (body_start - len(output)))
        if body_start != new_body_start:
            raise AssertionError('Canonical body start mismatch: 0x%x != 0x%x' % (body_start, new_body_start))
        output.extend(body)
        output.extend(b'\0' * (info_start - len(output)))
        for index in range(len(states)):
            payload = info_payloads.get(index)
            if payload is None:
                continue
            output.extend(b'\0' * (states[index].info_offset - len(output)))
            output.extend(payload)
        output.extend(b'\0' * (debug_offset - len(output)))
        output.extend(self.debug_info.raw)
        if len(output) != file_length - FOOTER_SIZE:
            raise AssertionError('File length mismatch before footer')
        output.extend(hashlib.sha1(output).digest())
        output.extend(self.epilogue)
        return bytes(output)

    def rebuild(self) -> bytes:
        """Re-emit every parsed section and recompute the footer hash.

        This initial rebuilder is intentionally lossless: mutations must update
        the owning structured section explicitly before calling it.
        """
        output = bytearray(self.header.encode())
        for section in self.sections.values():
            if section.name == 'function_headers':
                for header in self.function_headers_in_file_order:
                    output.extend(self._small_header_bytes(header))
                continue
            output.extend(section.padding)
            output.extend(section.data)

        # The body and function-info regions may be interleaved in legacy files.
        # Replaying the original region verbatim is the only lossless operation
        # until a semantic writer supplies an explicit canonical layout.
        body_and_info_end = self.header.debug_info_offset
        output.extend(_checked_slice(self.data, self.body_start, body_and_info_end - self.body_start, 'Body/info region'))
        output.extend(self.debug_info.raw)
        output.extend(hashlib.sha1(output).digest())
        output.extend(self.epilogue)

        # Keep the current canonical segment order while allowing raw replay.
        if bytes(output[:HEADER_SIZE]) != self.header.raw:
            raise AssertionError('Header replay mismatch')
        if bytes(output[HEADER_SIZE:self.body_start]) != self.data[HEADER_SIZE:self.body_start]:
            # This catches callers accidentally reordering the parsed sections.
            raise AssertionError('Canonical section replay mismatch')
        if bytes(output) != self.data:
            raise AssertionError('Lossless rebuild mismatch')
        return bytes(output)

    @property
    def function_headers_in_file_order(self) -> tuple[SmallFunctionHeader, ...]:
        return self.function_headers

    @staticmethod
    def _small_header_bytes(header: SmallFunctionHeader) -> bytes:
        return header.raw

    def body_for_function(self, index: int) -> bytes:
        offset = self.function_headers[index].effective_offset
        for group in self.body_groups:
            if group.offset == offset:
                return group.bytes
        raise KeyError('No body for function %d' % index)


def parse(
    source: bytes | str | Path,
    *,
    strict: bool = True,
    allow_legacy: bool = False,
) -> HBCFile:
    if isinstance(source, (str, Path)):
        return HBCFile.from_path(source, strict=strict, allow_legacy=allow_legacy)
    return HBCFile.parse(source, strict=strict, allow_legacy=allow_legacy)


def _parse_header(data: bytes) -> Header:
    values = struct.unpack_from('<QI20s20IB15s', data)
    names = (
        'magic',
        'version',
        'source_hash',
        'file_length',
        'global_code_index',
        'function_count',
        'string_kind_count',
        'identifier_count',
        'string_count',
        'overflow_string_count',
        'string_storage_size',
        'bigint_count',
        'bigint_storage_size',
        'regexp_count',
        'regexp_storage_size',
        'literal_value_buffer_size',
        'obj_key_buffer_size',
        'obj_shape_table_count',
        'num_string_switch_imms',
        'segment_id',
        'cjs_module_count',
        'function_source_count',
        'debug_info_offset',
        'options',
        'padding',
    )
    return Header(**dict(zip(names, values)), raw=data[:HEADER_SIZE])


def _parse_sections(data: bytes, header: Header) -> tuple[dict[str, Section], int]:
    cursor = HEADER_SIZE
    result: dict[str, Section] = {}
    descriptors = (
        ('function_headers', header.function_count, SMALL_HEADER_SIZE),
        ('string_kinds', header.string_kind_count, 4),
        ('identifier_hashes', header.identifier_count, 4),
        ('small_string_table', header.string_count, 4),
        ('overflow_string_table', header.overflow_string_count, 8),
        ('string_storage', header.string_storage_size, 1),
        ('literal_value_buffer', header.literal_value_buffer_size, 1),
        ('object_key_buffer', header.obj_key_buffer_size, 1),
        ('object_shape_table', header.obj_shape_table_count, 8),
        ('bigint_table', header.bigint_count, 8),
        ('bigint_storage', header.bigint_storage_size, 1),
        ('regexp_table', header.regexp_count, 8),
        ('regexp_storage', header.regexp_storage_size, 1),
        ('cjs_module_table', header.cjs_module_count, 8),
        ('function_source_table', header.function_source_count, 8),
    )
    for name, count, width in descriptors:
        aligned = align4(cursor)
        padding = _checked_slice(data, cursor, aligned - cursor, name + ' alignment')
        size = count * width
        payload = _checked_slice(data, aligned, size, name)
        result[name] = Section(name, cursor, padding, payload)
        cursor = aligned + size
    return result, align4(cursor)


def _parse_function_headers(data: bytes, header: Header) -> tuple[SmallFunctionHeader, ...]:
    result = []
    cursor = HEADER_SIZE
    for index in range(header.function_count):
        result.append(SmallFunctionHeader.parse(data, index, cursor))
        cursor += SMALL_HEADER_SIZE
    return tuple(result)


def _parse_function_infos(
    data: bytes,
    header: Header,
    function_headers: tuple[SmallFunctionHeader, ...],
    validation: Validation,
) -> tuple[dict[int, FunctionInfo], int]:
    pointers = sorted({item.full_header_offset for item in function_headers if item.overflowed})
    result: dict[int, FunctionInfo] = {}
    for pointer in pointers:
        if pointer < HEADER_SIZE or pointer + FULL_HEADER_SIZE > header.debug_info_offset:
            validation.errors.append('Function info pointer 0x%x is outside the body/info region' % pointer)
            continue
        full = FunctionHeader.parse(data, pointer)
        cursor = pointer + FULL_HEADER_SIZE
        exceptions: list[ExceptionHandler] = []
        if full.has_exception_handler:
            cursor = align4(cursor)
            if cursor + 4 > header.debug_info_offset:
                validation.errors.append('Exception table for 0x%x is truncated' % pointer)
                continue
            count = _u32(data, cursor)
            cursor += 4
            if cursor + count * 12 > header.debug_info_offset:
                validation.errors.append('Exception entries for 0x%x are truncated' % pointer)
                continue
            for _ in range(count):
                exceptions.append(ExceptionHandler(*struct.unpack_from('<3I', data, cursor)))
                cursor += 12
        debug_offset = None
        if full.has_debug_info:
            cursor = align4(cursor)
            if cursor + 4 > header.debug_info_offset:
                validation.errors.append('Debug offset for 0x%x is truncated' % pointer)
                continue
            debug_offset = _u32(data, cursor)
            cursor += 4
        result[pointer] = FunctionInfo(
            offset=pointer,
            header=full,
            exception_handlers=tuple(exceptions),
            debug_offset=debug_offset,
            end=cursor,
            raw=data[pointer:cursor],
        )
    info_start = min(pointers, default=header.debug_info_offset)
    return result, info_start


def _link_full_headers(
    function_headers: tuple[SmallFunctionHeader, ...],
    function_infos: dict[int, FunctionInfo],
) -> tuple[SmallFunctionHeader, ...]:
    linked = []
    for item in function_headers:
        if not item.overflowed:
            linked.append(item)
            continue
        pointer = item.full_header_offset
        full_info = function_infos.get(pointer)
        if full_info is None:
            linked.append(item)
            continue
        linked.append(
            SmallFunctionHeader(
                **{
                    **item.__dict__,
                    'full_header': full_info.header,
                }
            )
        )
    return tuple(linked)


def _parse_body_groups(
    data: bytes,
    headers: tuple[SmallFunctionHeader, ...],
    body_start: int,
    body_end_hint: int,
    opcodes: OpcodeSet,
    validation: Validation,
    allow_legacy: bool,
) -> tuple[BodyGroup, ...]:
    grouped: dict[int, list[int]] = {}
    for index, item in enumerate(headers):
        offset = item.effective_offset
        if offset < body_start or offset > len(data) - FOOTER_SIZE:
            validation.errors.append('Function %d body offset 0x%x is outside the file' % (index, offset))
            continue
        grouped.setdefault(offset, []).append(index)

    offsets = sorted(grouped)
    groups: list[BodyGroup] = []
    for position, offset in enumerate(offsets):
        indexes = grouped[offset]
        sizes = [headers[index].effective_bytecode_size for index in indexes]
        size = max(sizes, default=0)
        if any(value not in (0, size) for value in sizes):
            validation.errors.append('Function aliases at 0x%x disagree on bytecode size' % offset)
        body = _checked_slice(data, offset, size, 'Function body at 0x%x' % offset)
        instructions: list[Instruction] = []
        cursor = offset
        while cursor < offset + size:
            try:
                instruction = opcodes.decode_one(data, cursor, offset + size)
            except ValueError:
                validation.invalid_opcodes.append((cursor, data[cursor]))
                if not allow_legacy:
                    break
                cursor += 1
                continue
            instructions.append(instruction)
            cursor += instruction.size
        switch_tables = _parse_switch_tables(data, offset, instructions, validation)
        span_end = offsets[position + 1] if position + 1 < len(offsets) else body_end_hint
        if switch_tables:
            required_end = max(table.table_offset + len(table.raw) for table in switch_tables)
            if required_end > span_end:
                validation.errors.append('Switch table at 0x%x crosses into the next structure' % offset)
        groups.append(
            BodyGroup(
                offset=offset,
                size=size,
                function_indexes=tuple(indexes),
                aliases=tuple(indexes[1:]),
                instructions=tuple(instructions),
                switch_tables=tuple(switch_tables),
                bytes=body,
            )
        )
    return tuple(groups)


def _parse_switch_tables(
    data: bytes,
    body_offset: int,
    instructions: Iterable[Instruction],
    validation: Validation,
) -> tuple[SwitchTable, ...]:
    tables: list[SwitchTable] = []
    for instruction in instructions:
        if instruction.name not in (UINT_SWITCH, STRING_SWITCH):
            continue
        if instruction.name == UINT_SWITCH:
            relative = instruction.operands[1]
            minimum, maximum = instruction.operands[3], instruction.operands[4]
            if maximum < minimum:
                validation.errors.append('UIntSwitchImm at 0x%x has an inverted range' % instruction.offset)
                continue
            count = maximum - minimum + 1
            width = 4
        else:
            relative = instruction.operands[2]
            count = instruction.operands[4]
            width = 8
        target = align4(instruction.offset + relative)
        if target < body_offset or target + count * width > len(data):
            validation.errors.append('%s table at 0x%x is outside the file' % (instruction.name, target))
            continue
        tables.append(
            SwitchTable(
                kind=instruction.name,
                instruction_offset=instruction.offset,
                table_offset=target,
                count=count,
                raw=data[target:target + count * width],
            )
        )
    return tuple(tables)


def _validate_string_switches(
    header: Header,
    groups: tuple[BodyGroup, ...],
    validation: Validation,
) -> None:
    found = sum(1 for group in groups for table in group.switch_tables if table.kind == STRING_SWITCH)
    if found != header.num_string_switch_imms:
        validation.errors.append(
            'Header declares %d StringSwitchImm tables, parsed %d'
            % (header.num_string_switch_imms, found)
        )


def _parse_debug_info(data: bytes, header: Header, footer_start: int) -> DebugInfo:
    start = header.debug_info_offset
    if start < 0 or start + 16 > footer_start:
        raise HBCFormatError('Debug info header is outside the declared file')
    filename_count, filename_storage_size, file_region_count, debug_data_size = struct.unpack_from(
        '<4I', data, start
    )
    cursor = start + 16
    cursor += filename_count * 8
    cursor += filename_storage_size
    cursor += file_region_count * 12
    cursor += debug_data_size
    if cursor != footer_start:
        raise HBCFormatError(
            'Debug info ends at 0x%x, expected footer at 0x%x' % (cursor, footer_start)
        )
    return DebugInfo(
        offset=start,
        filename_count=filename_count,
        filename_storage_size=filename_storage_size,
        file_region_count=file_region_count,
        debug_data_size=debug_data_size,
        raw=data[start:footer_start],
    )


def _validate_canonical_layout(
    headers: tuple[SmallFunctionHeader, ...],
    infos: dict[int, FunctionInfo],
    groups: tuple[BodyGroup, ...],
    debug_info: DebugInfo,
    validation: Validation,
    *,
    allow_legacy: bool,
) -> None:
    for section in ():
        pass
    # Alignment bytes are produced by BytecodeSerializer::pad(), which writes
    # zeroes. Nonzero padding is valid raw input but not canonical output.
    # The caller supplies sections through HBCFile; this check is completed in
    # parse() after construction.
    if allow_legacy:
        return
    pointers = sorted(infos)
    if pointers:
        cursor = pointers[0]
        for pointer in pointers:
            info = infos[pointer]
            if pointer != cursor:
                validation.errors.append('Function info region has a gap or overlap at 0x%x' % pointer)
            cursor = align4(info.end)
        if cursor != debug_info.offset:
            validation.errors.append(
                'Function info ends at 0x%x, expected debug info at 0x%x'
                % (cursor, debug_info.offset)
            )
    for left, right in zip(groups, groups[1:]):
        if left.end > right.offset:
            validation.errors.append('Function bodies overlap at 0x%x' % left.offset)
    if groups and groups[-1].end > debug_info.offset:
        validation.errors.append('Last function body crosses debug info')


def _validate_section_padding(sections: dict[str, Section], validation: Validation) -> None:
    for section in sections.values():
        if section.padding and any(section.padding):
            validation.errors.append('%s has nonzero alignment padding' % section.name)


def _needs_function_info(state: _FunctionState) -> bool:
    return (
        state.force_full
        or bool(state.metadata.flags & (HAS_EXCEPTION_HANDLER | HAS_DEBUG_INFO))
        or not state.metadata.fits_small(
            offset=state.body_offset,
            bytecode_size=state.bytecode_size,
        )
    )


def _validate_function_state(state: _FunctionState, opcodes: OpcodeSet) -> None:
    if not 0 <= state.body_offset <= 0xFFFFFFFF:
        raise ValueError('Function body offset does not fit in 32 bits')
    if not 0 <= state.bytecode_size <= 0xFFFFFFFF:
        raise ValueError('Function body is too large')
    if state.bytecode_size > len(state.body):
        raise ValueError('Declared bytecode size exceeds the retained body bytes')
    if state.metadata.flags & OVERFLOWED:
        raise ValueError('The overflow flag belongs to a small header, not FunctionHeader')

    has_exceptions = bool(state.metadata.flags & HAS_EXCEPTION_HANDLER)
    if state.exception_handlers and not has_exceptions:
        raise ValueError('Exception handlers require HAS_EXCEPTION_HANDLER')
    if has_exceptions:
        instructions = opcodes.decode(
            state.body, 0, state.bytecode_size
        )
        starts = {instruction.offset for instruction in instructions}
        boundaries = starts | {state.bytecode_size}
        for index, handler in enumerate(state.exception_handlers):
            if not (0 <= handler.start <= handler.end <= state.bytecode_size):
                raise ValueError('Exception handler %d range is outside the function body' % index)
            if handler.start not in starts:
                raise ValueError(
                    'Exception handler %d start %d is not an instruction boundary'
                    % (index, handler.start)
                )
            if handler.end not in boundaries:
                raise ValueError(
                    'Exception handler %d end %d is not an instruction boundary'
                    % (index, handler.end)
                )
            if handler.target not in starts:
                raise ValueError(
                    'Exception handler %d target %d is not an instruction boundary'
                    % (index, handler.target)
                )

    has_debug = bool(state.metadata.flags & HAS_DEBUG_INFO)
    if has_debug and state.debug_offset is None:
        raise ValueError('HAS_DEBUG_INFO requires a debug-data offset')
    if has_debug and not 0 <= state.debug_offset <= 0xFFFFFFFF:
        raise ValueError('Debug-data offset does not fit in 32 bits')
    if not has_debug and state.debug_offset is not None:
        raise ValueError('A debug-data offset requires HAS_DEBUG_INFO')


def _encode_function_info(state: _FunctionState) -> bytes:
    header = state.metadata.to_header(offset=state.body_offset, bytecode_size=state.bytecode_size)
    output = bytearray(header.encode())
    if state.metadata.flags & HAS_EXCEPTION_HANDLER:
        output.extend(b'\0' * (align4(len(output)) - len(output)))
        output.extend(struct.pack('<I', len(state.exception_handlers)))
        for handler in state.exception_handlers:
            output.extend(struct.pack('<3I', handler.start, handler.end, handler.target))
    if state.metadata.flags & HAS_DEBUG_INFO:
        output.extend(b'\0' * (align4(len(output)) - len(output)))
        output.extend(struct.pack('<I', state.debug_offset))
    return bytes(output)


def _encode_small_header(metadata: FunctionMetadata, *, offset: int, bytecode_size: int) -> bytes:
    if not metadata.fits_small(offset=offset, bytecode_size=bytecode_size):
        raise ValueError('Function metadata does not fit in a small header')
    word0 = offset | (metadata.param_count << 25) | (metadata.loop_depth << 30)
    word1 = (
        bytecode_size
        | (metadata.function_name << 14)
        | (metadata.number_reg_count << 22)
        | (metadata.non_pointer_reg_count << 27)
    )
    cache = (
        (metadata.write_cache_size & 0x3F)
        | ((metadata.num_cache_new_object & 1) << 6)
        | ((metadata.private_name_cache_size & 1) << 7)
    )
    return struct.pack(
        '<2I4B',
        word0,
        word1,
        metadata.frame_size,
        metadata.read_cache_size,
        cache,
        metadata.flags,
    )


def _encode_small_pointer(offset: int) -> bytes:
    if not 0 <= offset <= 0xFFFFFFFF:
        raise ValueError('Function info offset does not fit in 32 bits')
    return struct.pack(
        '<2I4B',
        offset & 0xFFFFFF,
        ((offset >> 24) & 0xFF) << 14,
        0,
        0,
        0,
        OVERFLOWED,
    )

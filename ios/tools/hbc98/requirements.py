"""Function-body resource requirements for Hermes bytecode v98."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Iterable

from .model import (
    FunctionHeader,
    FunctionMetadata,
    HAS_DEBUG_INFO,
    HAS_EXCEPTION_HANDLER,
    HBCFile,
    OVERFLOWED,
)
from .opcodes import Instruction, OpcodeSet


NO_CACHE = 0xFF

# These operand positions are zero-based. Cache index 255 means "do not cache".
_READ_CACHE_OPERANDS = {
    'GetByIdShort': 2,
    'GetById': 2,
    'GetByIdLong': 2,
    'TryGetById': 2,
    'TryGetByIdLong': 2,
    'GetByIdWithReceiverLong': 2,
    'CreateThisForNew': 2,
    'CreateThisForSuper': 3,
}

_WRITE_CACHE_OPERANDS = {
    'PutByIdLoose': 2,
    'PutByIdLooseLong': 2,
    'PutByIdStrict': 2,
    'PutByIdStrictLong': 2,
    'TryPutByIdLoose': 2,
    'TryPutByIdLooseLong': 2,
    'TryPutByIdStrict': 2,
    'TryPutByIdStrictLong': 2,
    'DefineOwnById': 2,
    'DefineOwnByIdLong': 2,
}

_PRIVATE_CACHE_OPERANDS = {
    'PrivateIsIn': 3,
    'GetOwnPrivateBySym': 2,
    'PutOwnPrivateBySym': 2,
}


@dataclass(frozen=True)
class BodyRequirements:
    """Resources a body directly references through its instructions."""

    max_register: int = -1
    # LoadParam is 1-based for parameters and uses 0 for ``this``. This is a
    # body fact only: it must not be compared with the declared param_count.
    max_load_param: int = -1
    read_cache_entries: int = 0
    write_cache_entries: int = 0
    private_name_cache_entries: int = 0
    num_cache_new_object: int = 0

    @property
    def frame_size(self) -> int:
        return self.max_register + 1

    def as_dict(self) -> dict[str, int]:
        return {
            'maxRegister': self.max_register,
            'maxLoadParam': self.max_load_param,
            'readCacheEntries': self.read_cache_entries,
            'writeCacheEntries': self.write_cache_entries,
            'privateNameCacheEntries': self.private_name_cache_entries,
            'numCacheNewObject': self.num_cache_new_object,
            'minimumFrameSize': self.frame_size,
        }


def _cache_entries(instruction: Instruction, operand_index: int) -> int:
    value = instruction.operands[operand_index]
    return 0 if value == NO_CACHE else value + 1


def requirements_from_instructions(
    opcodes: OpcodeSet,
    instructions: Iterable[Instruction],
) -> BodyRequirements:
    """Calculate resource requirements without interpreting control flow."""

    max_register = -1
    max_load_param = -1
    read_cache_entries = 0
    write_cache_entries = 0
    private_name_cache_entries = 0
    num_cache_new_object = 0

    for instruction in instructions:
        operand_types = opcodes.operands(instruction.name)
        for operand_type, value in zip(operand_types, instruction.operands):
            if operand_type in ('Reg8', 'Reg32'):
                max_register = max(max_register, value)

        if instruction.name in ('LoadParam', 'LoadParamLong'):
            max_load_param = max(max_load_param, instruction.operands[1])

        operand_index = _READ_CACHE_OPERANDS.get(instruction.name)
        if operand_index is not None:
            read_cache_entries = max(
                read_cache_entries, _cache_entries(instruction, operand_index)
            )

        operand_index = _WRITE_CACHE_OPERANDS.get(instruction.name)
        if operand_index is not None:
            write_cache_entries = max(
                write_cache_entries, _cache_entries(instruction, operand_index)
            )

        operand_index = _PRIVATE_CACHE_OPERANDS.get(instruction.name)
        if operand_index is not None:
            private_name_cache_entries = max(
                private_name_cache_entries,
                _cache_entries(instruction, operand_index),
            )

        if instruction.name == 'CacheNewObject':
            num_cache_new_object = max(
                num_cache_new_object,
                _cache_entries(instruction, 3),
            )

    return BodyRequirements(
        max_register=max_register,
        max_load_param=max_load_param,
        read_cache_entries=read_cache_entries,
        write_cache_entries=write_cache_entries,
        private_name_cache_entries=private_name_cache_entries,
        num_cache_new_object=num_cache_new_object,
    )


def body_requirements(opcodes: OpcodeSet, body: bytes) -> BodyRequirements:
    return requirements_from_instructions(
        opcodes, opcodes.decode(body, 0, len(body))
    )


def metadata_mismatches(
    requirements: BodyRequirements,
    metadata: FunctionMetadata,
) -> tuple[str, ...]:
    mismatches = []
    if requirements.frame_size > metadata.frame_size:
        mismatches.append(
            f'frame_size {metadata.frame_size} < required {requirements.frame_size}'
        )
    if requirements.read_cache_entries > metadata.read_cache_size:
        mismatches.append(
            'read_cache_size '
            f'{metadata.read_cache_size} < required '
            f'{requirements.read_cache_entries}'
        )
    if requirements.write_cache_entries > metadata.write_cache_size:
        mismatches.append(
            'write_cache_size '
            f'{metadata.write_cache_size} < required '
            f'{requirements.write_cache_entries}'
        )
    if requirements.private_name_cache_entries > metadata.private_name_cache_size:
        mismatches.append(
            'private_name_cache_size '
            f'{metadata.private_name_cache_size} < required '
            f'{requirements.private_name_cache_entries}'
        )
    if requirements.num_cache_new_object > metadata.num_cache_new_object:
        mismatches.append(
            'num_cache_new_object '
            f'{metadata.num_cache_new_object} < required '
            f'{requirements.num_cache_new_object}'
        )
    return tuple(mismatches)


def require_metadata(
    requirements: BodyRequirements,
    metadata: FunctionMetadata,
    *,
    label: str,
) -> None:
    mismatches = metadata_mismatches(requirements, metadata)
    if mismatches:
        raise ValueError(f'{label} metadata is too small: ' + '; '.join(mismatches))


def merge_replacement_metadata(
    *,
    legacy: FunctionMetadata,
    stock: FunctionMetadata,
    requirements: BodyRequirements,
    has_exception_section: bool,
    has_debug_info: bool,
) -> FunctionMetadata:
    """Merge a legacy body into a stock target header without under-allocating."""

    flags = legacy.flags & ~(
        HAS_EXCEPTION_HANDLER | HAS_DEBUG_INFO | OVERFLOWED
    )
    if has_exception_section:
        flags |= HAS_EXCEPTION_HANDLER
    if has_debug_info:
        flags |= HAS_DEBUG_INFO

    metadata = replace(
        legacy,
        function_name=stock.function_name,
        frame_size=max(
            legacy.frame_size,
            stock.frame_size,
            requirements.frame_size,
        ),
        read_cache_size=max(
            legacy.read_cache_size,
            stock.read_cache_size,
            requirements.read_cache_entries,
        ),
        write_cache_size=max(
            legacy.write_cache_size,
            stock.write_cache_size,
            requirements.write_cache_entries,
        ),
        num_cache_new_object=max(
            legacy.num_cache_new_object,
            stock.num_cache_new_object,
            requirements.num_cache_new_object,
        ),
        private_name_cache_size=max(
            legacy.private_name_cache_size,
            stock.private_name_cache_size,
            requirements.private_name_cache_entries,
        ),
        flags=flags,
    )
    if metadata.frame_size > 0xFF:
        raise ValueError(
            f'merged frame_size {metadata.frame_size} does not fit in one byte'
        )
    for name in (
        'read_cache_size',
        'write_cache_size',
        'num_cache_new_object',
        'private_name_cache_size',
    ):
        value = getattr(metadata, name)
        if value > 0xFF:
            raise ValueError(f'merged {name} {value} does not fit in one byte')
    require_metadata(requirements, metadata, label='merged replacement')
    return metadata


def effective_header(file: HBCFile, index: int) -> FunctionHeader:
    small = file.function_headers[index]
    if small.effective is not None:
        return small.effective
    return FunctionHeader(
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
        raw=b'\0' * 37,
    )


def hbc_metadata_issues(file: HBCFile) -> tuple[dict[str, object], ...]:
    """Audit every function using its direct body slice, not a linear lookup."""

    requirements_by_body: dict[tuple[int, int], BodyRequirements] = {}
    issues: list[dict[str, object]] = []
    for index in range(len(file.function_headers)):
        header = effective_header(file, index)
        key = (header.offset, header.bytecode_size)
        requirements = requirements_by_body.get(key)
        if requirements is None:
            body = file.data[header.offset:header.offset + header.bytecode_size]
            try:
                if len(body) != header.bytecode_size:
                    raise ValueError(
                        f'body is truncated: {len(body)} of '
                        f'{header.bytecode_size} bytes'
                    )
                requirements = body_requirements(file.opcodes, body)
            except (IndexError, ValueError) as error:
                issues.append(
                    {
                        'kind': 'decode-error',
                        'function': index,
                        'offset': header.offset,
                        'bytecodeSize': header.bytecode_size,
                        'error': str(error),
                    }
                )
                continue
            requirements_by_body[key] = requirements
        metadata = FunctionMetadata.from_header(header)
        mismatches = metadata_mismatches(requirements, metadata)
        if mismatches:
            issues.append(
                {
                    'kind': 'metadata-mismatch',
                    'function': index,
                    'offset': header.offset,
                    'bytecodeSize': header.bytecode_size,
                    'requirements': requirements.as_dict(),
                    'metadata': {
                        'frameSize': metadata.frame_size,
                        'readCacheSize': metadata.read_cache_size,
                        'writeCacheSize': metadata.write_cache_size,
                        'privateNameCacheSize': metadata.private_name_cache_size,
                        'numCacheNewObject': metadata.num_cache_new_object,
                    },
                    'mismatches': list(mismatches),
                }
            )
    return tuple(issues)

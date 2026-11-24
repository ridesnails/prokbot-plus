from __future__ import annotations

import base64
import json
import unittest
from pathlib import Path

from ios.release import bytepatch
from ios.tools.build_ios_127_recipe import (
    BUILD_PINNED_GATE_FUNCTION,
    EXPECTED_GATEWAY_127_SHA256,
    PINNED_ENABLED_FEATURE_GATES,
    assert_pinned_feature_gates,
    build_pinned_feature_gates_body,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
RECIPES_DIR = REPO_ROOT / 'ios' / 'recipes' / 'ios'

# Relocated offset of patched buildPinnedGate (fn#19464) in 1.27.0 gateway-template.hbc.
BUILD_PINNED_GATE_127_OFFSET = 38725456
# First 28 bytes of the 31-byte prefix (LoadParam r2,1; LoadConstString r3,52518;
# JStrictEqualLong +20,r2,r3; LoadConstString r3,47594; JStrictEqualLong +9,r2,r3;
# Jmp +6; LoadConstTrue opcode); trailing 0x00, 0x76, 0x00 (r0; Ret r0) are reused
# from stock via the following COPY op.
EXPECTED_PINNED_GATE_ADD_PREFIX = bytes.fromhex(
    '890201'
    '900326cd'
    'd4140000000203'
    '9003eab9'
    'd4090000000203'
    'ae06'
    '95'
)


class PinnedFeatureGatesTests(unittest.TestCase):
    def test_127_pinned_gates_include_inline_canvas_flags(self):
        self.assertEqual(BUILD_PINNED_GATE_FUNCTION, 19464)
        self.assertTrue(callable(build_pinned_feature_gates_body))
        self.assertTrue(callable(assert_pinned_feature_gates))
        required = {
            'cloud_canvas_skill',
            'grok_bot_canvas_skill',
        }
        self.assertTrue(required.issubset(set(PINNED_ENABLED_FEATURE_GATES)))
        self.assertEqual(
            len(PINNED_ENABLED_FEATURE_GATES),
            len(set(PINNED_ENABLED_FEATURE_GATES)),
        )

    def test_committed_127_gateway_recipe_pins_canvas_feature_gates(self):
        gateway_recipe = bytepatch.load(RECIPES_DIR / 'gateway-template.hbc.gbp.gz')
        metadata_recipe = bytepatch.load(RECIPES_DIR / 'gateway-template.json.gbp.gz')
        self.assertEqual(gateway_recipe['targetSha256'], EXPECTED_GATEWAY_127_SHA256)

        self.assertEqual(len(metadata_recipe['ops']), 1)
        self.assertEqual(metadata_recipe['ops'][0][0], 'add')
        metadata = json.loads(
            base64.b64decode(metadata_recipe['ops'][0][1], validate=True)
        )
        self.assertEqual(metadata['templateSha256'], EXPECTED_GATEWAY_127_SHA256)

        target_offset = 0
        emitted_prefix = None
        for op in gateway_recipe['ops']:
            if op[0] == 'copy':
                target_offset += op[2]
            else:
                raw = base64.b64decode(op[1], validate=True)
                if target_offset <= BUILD_PINNED_GATE_127_OFFSET < target_offset + len(raw):
                    rel = BUILD_PINNED_GATE_127_OFFSET - target_offset
                    emitted_prefix = raw[rel:rel + len(EXPECTED_PINNED_GATE_ADD_PREFIX)]
                    break
                target_offset += len(raw)
        self.assertEqual(emitted_prefix, EXPECTED_PINNED_GATE_ADD_PREFIX)


if __name__ == '__main__':
    unittest.main()

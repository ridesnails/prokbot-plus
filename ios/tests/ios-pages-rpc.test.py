#!/usr/bin/env python3
"""Verify iOS GBConnectorProtocol intercepts all 8 Canvas/Pages RPCs and forwards to /local/mobile-rpc/."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONNECTORS = ROOT / "clients/ios/GBConnectors.m"

EXPECTED_CANVAS_METHODS = [
    "ListUserCanvases",
    "GetCanvasMetadata",
    "GetCanvasPayload",
    "SetCanvasVisibility",
    "SetPageAddress",
    "GetCanvasShareAccess",
    "UpdateCanvasShareAccess",
    "RefreshCanvasSources",
]


class PagesRpcInterceptionTest(unittest.TestCase):
    def test_canvas_methods_registered_in_connector_protocol(self):
        source = CONNECTORS.read_text(encoding="utf-8")
        match = re.search(
            r"static NSSet \*GBConnectorMethods\(void\)\s*\{(?P<body>.*?)\}",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "GBConnectorMethods() definition not found")
        body = match.group("body")
        for method in EXPECTED_CANVAS_METHODS:
            self.assertIn(
                f'@"{method}"',
                body,
                f"Canvas RPC {method} missing from GBConnectorMethods()",
            )

    def test_connector_protocol_routes_dashboard_service_to_mobile_rpc(self):
        source = CONNECTORS.read_text(encoding="utf-8")
        self.assertIn('@"/aiserver.v1.DashboardService/"', source)
        self.assertIn('@"/local/mobile-rpc/"', source)
        self.assertIn("GBConnection.shared.deviceToken.length", source)

    def test_compiled_dylib_contains_all_canvas_rpc_methods(self):
        dylib = (ROOT / "bin/GrokBotLocal.dylib").read_bytes()
        for method in EXPECTED_CANVAS_METHODS:
            self.assertIn(
                method.encode("ascii"),
                dylib,
                f"Compiled GrokBotLocal.dylib missing {method}",
            )


if __name__ == "__main__":
    unittest.main()

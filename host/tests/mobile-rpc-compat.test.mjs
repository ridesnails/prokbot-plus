import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileCanvasCompatMethods,
  mobileCompatRpc,
  mobileCompatRpcMethods,
  mobileMcpPermissionCompatMethods,
} from "../server/mobile-rpc-compat.mjs";
import { mobileConnectorMethods } from "../server/connectors-mobile.mjs";

test("mobile-rpc-compat handles all 8 Canvas RPCs and both MCP tool permission RPCs outside connectors", () => {
  for (const method of mobileCompatRpcMethods) {
    assert.equal(
      mobileConnectorMethods.has(method),
      false,
      `${method} should stay separate from connectors-mobile.mjs`,
    );
  }

  assert.equal(mobileCanvasCompatMethods.size, 8);
  assert.equal(mobileMcpPermissionCompatMethods.size, 2);

  assert.deepEqual(mobileCompatRpc("ListUserCanvases"), {
    status: 200,
    body: { canvases: [], nextPageToken: "" },
  });

  for (const method of ["GetCanvasMetadata", "GetCanvasPayload"]) {
    const res = mobileCompatRpc(method);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "not_found");
    assert.equal(typeof res.body.message, "string");
  }

  for (const method of [
    "SetCanvasVisibility",
    "SetPageAddress",
    "GetCanvasShareAccess",
    "UpdateCanvasShareAccess",
    "RefreshCanvasSources",
  ]) {
    const res = mobileCompatRpc(method);
    assert.equal(res.status, 501);
    assert.equal(res.body.code, "unimplemented");
    assert.equal(typeof res.body.message, "string");
  }

  assert.deepEqual(mobileCompatRpc("GetGrokBotMcpToolPermissions"), {
    status: 200,
    body: { servers: [] },
  });
  const setMcpRes = mobileCompatRpc("SetGrokBotMcpToolPermissions");
  assert.equal(setMcpRes.status, 501);
  assert.equal(setMcpRes.body.code, "unimplemented");
  assert.equal(typeof setMcpRes.body.message, "string");

  assert.throws(
    () => mobileCompatRpc("UnknownMethod"),
    (err) => err?.status === 404,
  );

  // If a method is registered in mobileCompatRpcMethods without a handler branch,
  // fail loudly instead of silently returning 501.
  mobileCompatRpcMethods.add("__TestUnhandledMethod");
  try {
    assert.throws(
      () => mobileCompatRpc("__TestUnhandledMethod"),
      /Unhandled mobile compat RPC method: __TestUnhandledMethod/,
    );
  } finally {
    mobileCompatRpcMethods.delete("__TestUnhandledMethod");
  }
});

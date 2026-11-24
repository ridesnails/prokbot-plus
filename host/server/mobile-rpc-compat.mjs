// Standalone compatibility responses for mobile DashboardService RPCs that are
// forwarded via /local/mobile-rpc/ by the iOS client but are not part of the
// Connected Apps connector service (connectors-mobile.mjs).
import { check } from "./security.mjs";

export const mobileCanvasCompatMethods = new Set([
  "ListUserCanvases",
  "GetCanvasMetadata",
  "GetCanvasPayload",
  "SetCanvasVisibility",
  "SetPageAddress",
  "GetCanvasShareAccess",
  "UpdateCanvasShareAccess",
  "RefreshCanvasSources",
]);

export const mobileMcpPermissionCompatMethods = new Set([
  "GetGrokBotMcpToolPermissions",
  "SetGrokBotMcpToolPermissions",
]);

export const mobileCompatRpcMethods = new Set([
  ...mobileCanvasCompatMethods,
  ...mobileMcpPermissionCompatMethods,
]);

/**
 * Return { status, body } using Connect-compatible JSON payloads so the iOS
 * client receives structured empty/not_found/unimplemented responses instead
 * of generic connector 404 errors when self-hosted Pages are not enabled.
 */
export function mobileCompatRpc(method) {
  check(mobileCompatRpcMethods.has(method), 404, "兼容移动接口不存在");

  if (method === "ListUserCanvases") {
    return { status: 200, body: { canvases: [], nextPageToken: "" } };
  }
  if (method === "GetCanvasMetadata" || method === "GetCanvasPayload") {
    return {
      status: 404,
      body: {
        code: "not_found",
        message: "Pages are not configured on this Host",
      },
    };
  }
  if (mobileCanvasCompatMethods.has(method)) {
    return {
      status: 501,
      body: {
        code: "unimplemented",
        message: "Pages are not enabled on this Host",
      },
    };
  }
  if (method === "GetGrokBotMcpToolPermissions") {
    return { status: 200, body: { servers: [] } };
  }
  if (method === "SetGrokBotMcpToolPermissions") {
    return {
      status: 501,
      body: {
        code: "unimplemented",
        message: "MCP tool permissions are not configurable on this Host",
      },
    };
  }
  throw new Error(`Unhandled mobile compat RPC method: ${method}`);
}

// startOpenCodeBridge: used by the server entrypoint to mirror activity from an
// externally-managed OpenCode server (desktop app or `opencode serve`).
export { startOpenCodeBridge, stopOpenCodeBridge } from '@/modules/opencode-bridge/opencode-bridge.service.js';
// openCodePermissionGateway: used by the server entrypoint to hand the OpenCode
// runtime the approval gateway backed by this bridge's event stream.
export { openCodePermissionGateway } from '@/modules/opencode-bridge/opencode-bridge.service.js';

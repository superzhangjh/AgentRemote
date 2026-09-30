// startOpenCodeBridge: used by the server entrypoint to mirror activity from
// every externally-managed OpenCode server it can discover (the console's
// `opencode serve`, the desktop apps' v2 background services, and any
// password-protected `opencode serve` visible in the process table).
export { startOpenCodeBridge, stopOpenCodeBridge } from '@/modules/opencode-bridge/opencode-bridge.service.js';
// openCodePermissionGateway: used by the server entrypoint to hand the OpenCode
// runtime the approval gateway backed by this bridge's event stream.
export { openCodePermissionGateway } from '@/modules/opencode-bridge/opencode-bridge.service.js';

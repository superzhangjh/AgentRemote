/// <reference types="vite/client" />

/**
 * Installed package version, injected by Vite's `define` at build time.
 * Read it through `APP_VERSION` in `@/shared/constants`, which also covers
 * runners such as `tsx` that do not apply Vite's define replacement.
 */
declare const __APP_VERSION__: string;

/**
 * Build time of this frontend bundle, injected by Vite's `define`.
 *
 * Shown in the sidebar footer so a client can say which build it is actually
 * running — a phone shell can hold an old bundle across app switches, and
 * without a stamp neither side can tell "the fix did not work" from "the fix
 * is not loaded".
 */
declare const __APP_BUILD_TIME__: string;

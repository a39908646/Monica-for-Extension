/**
 * Long-lived port opened by Monica's own UI surfaces (popup and manager).
 * The background uses it to apply the "immediate" vault timeout policy:
 * the vault locks as soon as the last UI surface closes.
 */
export const MONICA_UI_PORT = "monica-ui";

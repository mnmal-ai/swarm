/**
 * The telemetry API's base URL.
 *
 * Mirrors DEFAULT_TELEMETRY_ENDPOINT in
 * packages/telemetry/src/telemetry/endpoint.ts (the dashboard is a separate
 * npm project and cannot import a workspace package); keep the two equal.
 * A build points at a deployed API with VITE_TELEMETRY_ENDPOINT.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.example.invalid";

export const TELEMETRY_ENDPOINT = import.meta.env.VITE_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT;

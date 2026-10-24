/**
 * The telemetry API's base URL: the one place it is defined.
 *
 * Uploads (`upload.ts`), `swarm logs` and the dashboard all read it. The
 * `.invalid` top-level domain is reserved (RFC 2606) and never resolves, so a
 * build that has not been pointed at a deployed API fails closed: nothing
 * leaves the machine. A deployment replaces this value with its API Gateway
 * URL (the `ApiUrl` output of `infra/`). The dashboard cannot import a
 * workspace package and mirrors this constant in
 * `dashboard/src/telemetry-endpoint.js`; keep the two equal.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.example.invalid";

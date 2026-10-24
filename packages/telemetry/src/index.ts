// Telemetry
export { Telemetry } from "./telemetry/index.js";

// Scrubbing
export {
  parseSecretsExclusions,
  shouldExcludeFile,
  scrubContent,
  scrubConfigJson,
  isTextFile,
} from "./telemetry/scrub.js";
export type { SecretsExclusions } from "./telemetry/scrub.js";

// Tree capture
export { captureTree } from "./telemetry/tree-capture.js";

// Upload
export { DEFAULT_TELEMETRY_ENDPOINT } from "./telemetry/endpoint.js";
export {
  assemblePayload,
  compressPayload,
  uploadPayload,
  cacheForRetry,
  retryPending,
  setUploadEndpoint,
  getUploadEndpoint,
} from "./telemetry/upload.js";
export type {
  UploadConsent,
  UploadIdentity,
  AssembleOptions,
  AssembleResult,
} from "./telemetry/upload.js";

// Claim registry
export { ClaimRegistry, computeClaimAccuracy } from "./claim-registry/index.js";

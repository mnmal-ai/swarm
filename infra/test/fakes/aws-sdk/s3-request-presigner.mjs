// Stand-in for @aws-sdk/s3-request-presigner in tests (see jest.config.js).
export async function getSignedUrl() {
  return "https://example.invalid/presigned";
}

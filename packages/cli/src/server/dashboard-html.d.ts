// Type declarations for Bun's text imports of static assets bundled into the
// CLI binary at compile time. See dashboard-embed.ts and tokens-embed.ts.
declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

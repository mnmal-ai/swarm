/** Strip potential API keys and tokens from Codex's error text before swarm prints, emits or stores it. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "sk-ant-***")
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, "sk-***")
    .replace(/key[=: ]+["']?[a-zA-Z0-9_-]{20,}["']?/gi, "key=***")
    .replace(/(Bearer\s+)[A-Za-z0-9_.~+/-]{20,}/gi, "$1***")
    .replace(/(x-api-key[=: ]+["']?)[A-Za-z0-9_-]{20,}/gi, "$1***")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***jwt");
}

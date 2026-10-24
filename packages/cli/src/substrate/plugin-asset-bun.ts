// Bun-only: embeds the packed plugin tarball into `bun build --compile`
// binaries. Never imported statically; plugin-asset.ts loads it dynamically
// only when running under Bun, so Node never parses `with { type: "file" }`.
import tgz from "../../assets/swarm-substrate-plugin.tgz" with { type: "file" };

export default tgz;

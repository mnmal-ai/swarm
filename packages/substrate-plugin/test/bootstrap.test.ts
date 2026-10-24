/**
 * The bootstrap's config parsing: what Substrate's loader hands the default
 * export after merging `default-config.json` with the operator's
 * `swarm.config.json`.
 */
import { readFileSync } from "node:fs";
import { BootstrapConfigError } from "@mnmal-ai/substrate/sdk";
import { describe, expect, it } from "vitest";
import bootstrap, { SwarmBootstrapConfigSchema, MIN_DRAINSTOP_INTERVAL_MS } from "../src/bootstrap.js";
import { DEFAULT_CONTEXT_NAMESPACE, DEFAULT_DRAINSTOP_INTERVAL_MS } from "../src/plugin.js";

const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

const DEFAULT_CONFIG = readJson("default-config.json");

/** The loader's merge: operator keys over the package defaults. */
const withDefaults = (operator: Record<string, unknown>) => ({ ...DEFAULT_CONFIG, ...operator });

const namespacesOf = (config: Record<string, unknown>) => bootstrap(withDefaults(config)).namespaces.map((n) => n.namespace);

describe("swarm bootstrap config", () => {
  it("builds each scope's namespaces", () => {
    expect(namespacesOf({ scope: "cold" })).toEqual(["swarm", "swarm-docs"]);
    expect(namespacesOf({ scope: "meta" })).toEqual(["swarm_meta"]);
    expect(namespacesOf({ scope: "combined" })).toEqual(["swarm", "swarm-docs", "swarm_meta"]);
    expect(namespacesOf({ scope: "meta", namespace: "hive" })).toEqual(["hive_meta"]);
  });

  it("fills the defaults for everything but scope", () => {
    expect(SwarmBootstrapConfigSchema.parse({ scope: "cold" })).toEqual({
      scope: "cold",
      namespace: "swarm",
      contextNamespace: DEFAULT_CONTEXT_NAMESPACE,
      drainstopIntervalMs: DEFAULT_DRAINSTOP_INTERVAL_MS,
    });
  });

  it("refuses a config without scope, including the bare package defaults", () => {
    expect(() => bootstrap(withDefaults({}))).toThrow(BootstrapConfigError);
    expect(() => bootstrap({})).toThrow(/scope/);
    expect(DEFAULT_CONFIG).not.toHaveProperty("scope");
  });

  it("refuses an unknown scope, a bad namespace and an unknown key", () => {
    expect(() => bootstrap(withDefaults({ scope: "everything" }))).toThrow(BootstrapConfigError);
    expect(() => bootstrap(withDefaults({ scope: "cold", namespace: "a/b" }))).toThrow(BootstrapConfigError);
    expect(() => bootstrap(withDefaults({ scope: "cold", contextNamespace: "a:b" }))).toThrow(BootstrapConfigError);
    expect(() => bootstrap(withDefaults({ scope: "cold", promotionProject: "x" }))).toThrow(/promotionProject/);
  });

  it("holds drainstopIntervalMs to Substrate's scheduled-task floor", () => {
    expect(MIN_DRAINSTOP_INTERVAL_MS).toBe(100);
    const interval = (ms: number) => bootstrap(withDefaults({ scope: "cold", drainstopIntervalMs: ms })).schedule?.[0]?.intervalMs;
    expect(interval(100)).toBe(100);
    expect(() => interval(99)).toThrow(BootstrapConfigError);
    expect(() => interval(0)).toThrow(BootstrapConfigError);
    expect(() => interval(150.5)).toThrow(BootstrapConfigError);
  });

  it("keeps config.schema.json in step with the zod schema", () => {
    const schema = readJson("config.schema.json") as {
      required?: string[];
      additionalProperties?: boolean;
      properties: Record<string, { default?: unknown; minimum?: number; enum?: string[] }>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(SwarmBootstrapConfigSchema.shape).sort());
    expect(schema.required).toEqual(["scope"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.scope).not.toHaveProperty("default");
    expect(schema.properties.scope?.enum).toEqual(["cold", "meta", "combined"]);
    expect(schema.properties.drainstopIntervalMs?.minimum).toBe(MIN_DRAINSTOP_INTERVAL_MS);
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) expect(schema.properties[key]?.default).toEqual(value);
  });
});

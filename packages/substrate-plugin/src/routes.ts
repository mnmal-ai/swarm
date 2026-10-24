/**
 * The swarm plugin's HTTP routes, mounted by Substrate under
 * `/substrate/v1/plugins/swarm/`:
 *
 *   - `GET  /onboard`            the plugin's onboard record (every scope);
 *   - `POST /trigger-drainstop`  one drainstop pass, answering its `DrainstopResult`;
 *   - `POST /reject-promotion`   archive a promoted row and ratchet the anchor.
 *
 * The last two exist only where the swarm namespace is served (`cold` and
 * `combined`). Both run every frame as the caller: the request's identity
 * goes into the engine context, so with auth on the engine's namespace gate
 * sees who asked (the route gate alone checks a capability, not a namespace).
 */
import {
  type EngineHandle,
  jsonResponse,
  makeCtx,
  type PluginRouteContext,
  type PluginRouter,
  type RequestContext,
  type SubstrateRequest,
  type SubstrateResponse,
} from "@mnmal-ai/substrate/sdk";
import { type DrainstopConfig, runDrainstopOnce } from "./drainstop/drainstop.js";
import { messageOf } from "./drainstop/frames.js";
import { registerRejectPromotionRoute } from "./drainstop/reject-promotion.js";

/** Runs drainstop work one pass at a time, so a trigger and the scheduled expiry never interleave. */
export type SerialRunner = <T>(work: () => Promise<T>) => Promise<T>;

export function createSerialRunner(): SerialRunner {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** The caller's context for frames a route issues on its behalf. */
export function requestContext(req: SubstrateRequest, namespace: string): Partial<RequestContext> {
  const ctx: Partial<RequestContext> = makeCtx(namespace, "mutate", req.identity ?? null);
  if (req.clientIp !== undefined) ctx.clientIp = req.clientIp;
  if (req.authEnabled !== undefined) ctx.authEnabled = req.authEnabled;
  return ctx;
}

export interface SwarmRoutesOptions {
  /** The record `GET /onboard` serves. */
  onboard: unknown;
  /** The drainstop's namespaces, or undefined when this instance does not serve the swarm namespace. */
  drainstop?: Pick<DrainstopConfig, "planeNamespace" | "contextNamespace">;
  /** Serialises drainstop work with the scheduled expiry. */
  serial: SerialRunner;
}

export function registerSwarmRoutes(router: PluginRouter, routeCtx: PluginRouteContext, opts: SwarmRoutesOptions): void {
  const onboardBody = JSON.stringify(opts.onboard);
  router.get("/onboard", (): SubstrateResponse => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: onboardBody,
  }));

  const drainstop = opts.drainstop;
  if (drainstop === undefined) return;
  const engine: EngineHandle = routeCtx.engine;

  router.post("/trigger-drainstop", async (req): Promise<SubstrateResponse> => {
    try {
      const result = await opts.serial(() =>
        runDrainstopOnce(engine, {
          ...drainstop,
          ctx: requestContext(req, drainstop.planeNamespace),
          metric: routeCtx.metric,
        }),
      );
      return jsonResponse(200, result);
    } catch (err) {
      const message = messageOf(err);
      routeCtx.metric("swarm_trigger_drainstop_error", { message });
      return jsonResponse(500, { code: "drainstop_failed", message });
    }
  });

  registerRejectPromotionRoute(router, engine, drainstop, (req) => requestContext(req, drainstop.contextNamespace));
}

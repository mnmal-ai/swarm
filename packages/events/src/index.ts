import { EventEmitter } from "node:events";
import type { SwarmEventMap, ISwarmEventBus } from "@mnmal-ai/swarm-types";

/**
 * Typed event bus for Swarm SDK real-time observability.
 *
 * Wraps Node.js EventEmitter with type-safe emit/on/off/once methods
 * keyed to SwarmEventMap.
 */
export class SwarmEventBus implements ISwarmEventBus {
  private emitter = new EventEmitter();
  private anyHandlers = new Set<(event: string, payload: unknown) => void>();

  emit<K extends keyof SwarmEventMap>(event: K, payload: SwarmEventMap[K]): void {
    this.emitter.emit(event, payload);
    for (const handler of this.anyHandlers) {
      handler(String(event), payload);
    }
  }

  on<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void {
    this.emitter.on(event, handler);
  }

  off<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void {
    this.emitter.off(event, handler);
  }

  once<K extends keyof SwarmEventMap>(event: K, handler: (payload: SwarmEventMap[K]) => void): void {
    this.emitter.once(event, handler);
  }

  /** Subscribe to all events -- useful for dashboard broadcast. Returns unsubscribe function. */
  onAny(handler: (event: string, payload: unknown) => void): () => void {
    this.anyHandlers.add(handler);
    return () => { this.anyHandlers.delete(handler); };
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.anyHandlers.clear();
  }
}

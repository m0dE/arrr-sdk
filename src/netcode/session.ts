/**
 * A connection that comes back.
 *
 * The node holds a dropped member's seat for a grace period on the assumption
 * that the client redials; the SDK never did. This dials, and on any loss
 * redials with a backoff capped at five seconds, presenting the same member
 * identity so the node resumes the seat. The model on top sees connect and
 * disconnect events and nothing about the retries.
 */
import type { Runtime } from './runtime.js';

/** A connection a model can close; what it does otherwise is the model's business. */
export interface Closable { leaveRoom(): void; close(): void }
/** Opens a connection, wiring the given events; each model defines its own events. */
export type Dialer<E, C extends Closable> = (events: E) => Promise<C>;

export interface SessionOptions {
  reconnect?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export class Session<E = unknown, C extends Closable = Closable> {
  conn: C | null = null;
  reconnects = 0;
  errors: string[] = [];
  private stopped = false;
  private dialling = false;
  private timer: unknown = null;
  private delay: number;

  constructor(private readonly rt: Runtime, private readonly dialer: Dialer<E, C>, private readonly events: E, private readonly opts: SessionOptions = {}) {
    this.delay = opts.initialDelayMs ?? 500;
  }

  async start(): Promise<void> { this.stopped = false; await this.dial(); }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { this.rt.clearTimeout(this.timer); this.timer = null; }
    try { this.conn?.leaveRoom(); } catch { /* closing */ }
    this.conn = null;
  }

  /** Called by the model when the connection drops, so the redial can begin. */
  lost(): void { this.scheduleRedial(); }

  private async dial(): Promise<void> {
    if (this.dialling || this.stopped) return;
    this.dialling = true;
    try {
      this.conn = await this.dialer(this.events);
      this.delay = this.opts.initialDelayMs ?? 500;
    } catch (err) {
      this.errors.push(`dial: ${(err as Error).message}`);
      this.scheduleRedial();
    } finally {
      this.dialling = false;
    }
  }

  private scheduleRedial(): void {
    if (this.stopped || this.opts.reconnect === false || this.timer !== null) return;
    this.reconnects++;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 5000);
    this.timer = this.rt.setTimeout(() => { this.timer = null; void this.dial(); }, wait);
  }
}

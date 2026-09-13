/**
 * The SDK's `connect` as a `Dial`: the lockstep layer's events become the
 * connect options, and the member identity is the player id, so a redial
 * resumes the same seat.
 */
import { connect, type ConnectOptions } from '../arrr-network.js';
import type { Dial } from './transport.js';

export interface DialOptions extends Omit<ConnectOptions, 'onConnect' | 'onTick' | 'onDisconnect' | 'onError' | 'onClientsUpdate' | 'user'> {
  /** Sent to the node as user.id: the member identity. */
  player: string;
  /** Extra user metadata (a display name, the sim version). */
  user?: Record<string, unknown>;
}

export function dialWith(room: string, opts: DialOptions): Dial {
  return (events) => connect(room, {
    ...opts,
    user: { ...(opts.user || {}), id: opts.player },
    onConnect: events.onConnect,
    onTick: events.onTick,
    onDisconnect: events.onDisconnect,
    onError: events.onError,
    onClientsUpdate: events.onClientsUpdate,
  });
}

/**
 * What the lockstep model needs from a connection, and how one is opened: a
 * subset of the SDK's `Connection`. This is lockstep's contract - ticks of
 * inputs, hash votes, snapshots - and lives with the model; another model
 * defines its own. A test supplies a fake, a game supplies `dialWith` over
 * the real `connect`.
 */
export interface TransportConnection {
  send(data: any, targetFrame?: number): void;
  sendSnapshot(snapshot: any, hash: string, seq?: number, frame?: number): void;
  sendStateHash(frame: number, hash: number): void;
  requestResync(): void;
  close(): void;
  leaveRoom(): void;
  readonly connected: boolean;
  readonly clientId: string | null;
  onResyncSnapshot?: (data: Uint8Array, frame: number, inputs: any[]) => void;
}

export interface TransportEvents {
  onConnect(snapshot: any, inputs: any[], frame: number, node: string | null, fps: number, clientId: string): void;
  onTick(frame: number, inputs: any[], snapshotFrame?: number, snapshotHash?: string, majorityHash?: number): void;
  onDisconnect(): void;
  onError(err: string): void;
  onClientsUpdate?(clients: any[]): void;
}

/** Opens a connection, wiring the given events. */
export type Dial = (events: TransportEvents) => Promise<TransportConnection>;

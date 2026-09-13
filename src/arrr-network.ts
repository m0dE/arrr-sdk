import { decode } from './codec/index.js';

// Binary Message Types (Must match node/src/binary-protocol.ts)
const BinaryMessageType = {
    TICK: 0x01,
    INITIAL_STATE: 0x02,
    ROOM_JOINED: 0x03,
    ROOM_CREATED: 0x04,
    ERROR: 0x05,
    SNAPSHOT_UPDATE: 0x06,
    ROOM_LEFT: 0x07,
    SYNC_HASH: 0x08,
    CLIENT_LIST_UPDATE: 0x09,
    INPUT_SLACK: 0x0C,
    // Client-to-server markers (also used for server broadcast)
    BINARY_INPUT: 0x20,
    BINARY_SNAPSHOT: 0x21,
    // Distributed State Sync (0x30+)
    STATE_HASH: 0x30,      // Client -> Server: [0x30][frame:4][stateHash:4] = 9 bytes
    PARTITION_DATA: 0x31,  // Client -> Server: [0x31][frame:4][partitionId:1][len:2][data:N]
    // Voice (0x40+): off the ordered stream; see node/src/voice-relay.ts
    VOICE: 0x40,           // Client -> Server: [0x40][seq:2][x:f32][y:f32][z:f32][len:2][data:N]
    VOICE_FROM: 0x41,      // Server -> Client: [0x41][idLen:1][from:idLen][seq:2][x,y,z:f32][len:2][data:N]
    VOICE_READY: 0x42      // Server -> Client, once per join: this node relays voice
} as const;

/**
 * Hash a client ID to a 4-byte identifier (matches server-side hash)
 * Uses FNV-1a hash for speed and consistency
 */
export function hashClientId(clientId: string): number {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < clientId.length; i++) {
        hash ^= clientId.charCodeAt(i);
        hash = Math.imul(hash, 16777619) >>> 0; // FNV prime, keep as 32-bit unsigned
    }
    return hash;
}

// Map clientHash -> clientId for decoding TICK messages
const clientHashMap = new Map<number, string>();

/**
 * Register a client ID so we can decode their hash in TICK messages
 * Call this when a client joins (from the join input's clientId)
 */
export function registerClientId(clientId: string): void {
    const hash = hashClientId(clientId);
    clientHashMap.set(hash, clientId);
}

/**
 * Unregister a client ID (call on leave)
 */
export function unregisterClientId(clientId: string): void {
    const hash = hashClientId(clientId);
    clientHashMap.delete(hash);
}

/**
 * Look up client ID from hash
 */
export function lookupClientHash(hash: number): string | undefined {
    return clientHashMap.get(hash);
}

/**
 * Re-resolve clientId for an input using its stored clientHash.
 * This is needed when inputs are decoded before join events register clientIds.
 * Returns true if clientId was updated.
 */
function reResolveClientId(input: any): boolean {
    if (input.clientHash === undefined) return false;
    const resolved = lookupClientHash(input.clientHash);
    if (resolved && input.clientId !== resolved) {
        input.clientId = resolved;
        return true;
    }
    return false;
}

/**
 * NetworkInput represents any input flowing through the transport layer.
 * The network treats all payloads as opaque - it sequences and broadcasts
 * without interpreting contents.
 *
 * Ordering model:
 * - frame: Client-provided timestamp (client's local simulation frame when input was created)
 * - seq: Authority-assigned sequence number (for bulk broadcast per tick)
 *
 * Authority sorts inputs by (frame, clientId) before assigning seq.
 */
export interface NetworkInput {
    id: string;
    clientId: string;
    type: string;
    data: any;
    seq: number;
    frame: number;          // Client-provided frame when input was created
}

export interface Connection {
    /**
     * Send an input. `targetFrame`, when given, is written into the binary
     * input header where the node reads `clientFrame`: the frame the sender
     * predicted this input for. A node that honours it applies the input
     * there; today's nodes keep it for diagnostics.
     */
    send(data: any, targetFrame?: number): void;
    /**
     * Say something, or just say where you are.
     *
     * `data` is one frame of whatever the application encodes with - the
     * node relays it to the people close enough to hear and never opens it.
     * Sent with no data it is a position beacon: nothing is forwarded, but
     * the node learns where this client is, which is what lets it decide who
     * hears whom. A client that wants to hear anybody should send one every
     * half second or so whether or not it ever talks.
     */
    sendVoice(x: number, y: number, z: number, data?: Uint8Array | null): void;
    /** True once the node has said it relays voice. Older nodes never do. */
    readonly voiceReady: boolean;
    sendSnapshot(snapshot: any, hash: string, seq?: number, frame?: number): void;
    leaveRoom(): void;
    close(): void;
    readonly connected: boolean;
    readonly clientId: string | null;
    readonly node: string | null;
    /**
     * False when `nodeUrl` asked for a specific node and central assigned a
     * different one. Worth checking before concluding anything about which node
     * a connection is actually on.
     */
    readonly nodePreferenceHonored: boolean;
    readonly bandwidthIn: number;
    readonly bandwidthOut: number;
    readonly totalBytesIn: number;
    readonly totalBytesOut: number;
    readonly frame: number;
    getLatency(): string;
    getClients(): void;
    // Distributed State Sync methods
    sendStateHash(frame: number, hash: number): void;
    sendPartitionData(frame: number, partitionId: number, data: Uint8Array): void;
    requestResync(): void;  // Request full state resync from server (desync recovery)

    // Callbacks that can be set after connection
    onReliabilityUpdate?: (scores: Record<string, number>, version: number) => void;
    onMajorityHash?: (frame: number, hash: number) => void;
    /**
     * From a node that buffers inputs per target frame: once a second, for
     * each of this client's inputs since the last report, the frame it named
     * and how many ticks early it reached the node (negative = late: it
     * slipped into a later tick). An older node never sends it.
     */
    onInputSlack?: (frame: number, samples: { target: number; slack: number }[]) => void;
    onResyncSnapshot?: (data: Uint8Array, frame: number, inputs: NetworkInput[]) => void;  // Called when resync response arrives
}

export interface ConnectOptions {
    snapshot?: any;
    appId?: string;  // App ID (required when using central service)
    /**
     * The application's API key (`arrr_…` from the portal, or `mk_…`). Sent to
     * central as `x-api-key` when asking for a node. Required when the service
     * runs with APP_REGISTRATION=key; optional otherwise, and a key that is
     * unknown or belongs to another app is refused in either mode. A key in a
     * browser is visible to anyone who opens devtools: it ties rooms to your
     * app and can be revoked, it is not a secret. Per-user identity is
     * joinToken / authToken.
     */
    apiKey?: string;
    user?: any;
    centralServiceUrl?: string;
    // Ask central to place this connection on a particular node. It is a
    // preference, not an override: central may assign a different one, and
    // `connection.nodePreferenceHonored` reports whether it did.
    nodeUrl?: string;
    joinToken?: string;  // JWT token for authentication (required if app has requireUserAuth=true)
    authToken?: string;  // Session token from SDK auth flow (alternative to joinToken)
    fps?: number;  // Tick rate override (for direct node connection without central service)
    getStateHash?: () => string;
    onConnect?: (snapshot: any, inputs: NetworkInput[], frame: number, node: string | null, fps: number, clientId: string) => void;
    onDisconnect?: () => void;
    onError?: (error: string) => void;
    onMessage?: (data: any, seq: number) => void;
    onTick?: (frame: number, inputs: NetworkInput[], snapshotFrame?: number, snapshotHash?: string, majorityHash?: number) => void;
    onSnapshot?: (snapshot: any, hash: string) => void;
    onBinarySnapshot?: (data: Uint8Array) => void;  // Binary snapshot from another client
    onClientsUpdate?: (clients: any[]) => void;
    /**
     * A voice frame from somebody in earshot. `from` is their user id, `seq`
     * the talker's own frame counter (wraps at 65536), and the position is
     * where they said they were when they sent it. `data` is whatever the
     * talker put in - the network does not know what a codec is.
     */
    onVoice?: (from: string, seq: number, x: number, y: number, z: number, data: Uint8Array) => void;
}

export interface DecodedMessage {
    type: string;
    roomId?: string;
    clientId?: string;
    snapshotFrame?: number;  // Frame when server's snapshot was taken (for drift detection)
    snapshotHash?: string;   // Hash of server's snapshot (for drift detection)
    majorityHash?: number;   // Consensus hash from clients' STATE_HASH submissions (for desync detection)
    frame?: number;
    inputs?: NetworkInput[];
    snapshot?: any;
    binaryData?: Uint8Array;  // Binary snapshot data
    events?: NetworkInput[];  // Backwards compatibility alias for inputs
    message?: string;
    clients?: any[];
    /** INPUT_SLACK: per own input since the last report, the frame it named and ticks early it arrived (negative = late). */
    slack?: { target: number; slack: number }[];
}

// Encode sync hash
export function encodeSyncHash(roomId: string, hash: string, seq: number, frame: number): Uint8Array {
    const roomIdBytes = new TextEncoder().encode(roomId);
    const hashBytes = new TextEncoder().encode(hash);

    // 1 (type) + 2 (roomId len) + roomId + 2 (hash len) + hash + 4 (seq) + 4 (frame)
    const buf = new Uint8Array(1 + 2 + roomIdBytes.length + 2 + hashBytes.length + 4 + 4);
    const view = new DataView(buf.buffer);

    let offset = 0;
    buf[offset++] = BinaryMessageType.SYNC_HASH;
    view.setUint16(offset, roomIdBytes.length, true); offset += 2;
    buf.set(roomIdBytes, offset); offset += roomIdBytes.length;
    view.setUint16(offset, hashBytes.length, true); offset += 2;
    buf.set(hashBytes, offset); offset += hashBytes.length;
    view.setUint32(offset, seq, true); offset += 4;
    view.setUint32(offset, frame, true);

    return buf;
}

export function decodeBinaryMessage(buffer: ArrayBuffer): DecodedMessage | null {
    if (buffer.byteLength === 0) return null;
    const view = new DataView(buffer);
    const type = view.getUint8(0);

    try {
        switch (type) {
            case BinaryMessageType.TICK: {
                // Binary format: [type:1][frame:4][snapshotFrame:4][majorityHash:4][hashLen:1][hash:hashLen][count:2][inputs...]
                // Each input: [clientHash:4][seq:4][dataLen:2][data:dataLen]
                // Data can be JSON (join/leave) or binary (game inputs)
                if (buffer.byteLength < 5) {
                    console.error('[arrr-network] TICK message too short:', buffer.byteLength);
                    return null;
                }
                const frame = view.getUint32(1, true);
                let inputs: any[] = [];
                let snapshotFrame: number | undefined;
                let snapshotHash: string | undefined;
                let majorityHash: number | undefined;

                if (buffer.byteLength >= 14) {
                    snapshotFrame = view.getUint32(5, true);
                    majorityHash = view.getUint32(9, true);
                    const hashLen = view.getUint8(13);
                    let offset = 14;

                    if (hashLen > 0 && offset + hashLen <= buffer.byteLength) {
                        snapshotHash = new TextDecoder().decode(new Uint8Array(buffer, offset, hashLen));
                        offset += hashLen;
                    }

                    if (offset + 2 > buffer.byteLength) {
                        return { type: 'TICK', frame, snapshotFrame, snapshotHash, majorityHash, inputs, events: inputs };
                    }

                    // 16-bit: a byte silently truncated any tick over 255 inputs.
                    const inputCount = view.getUint16(offset, true);
                    offset += 2;
                    for (let i = 0; i < inputCount && offset + 10 <= buffer.byteLength; i++) {
                        const clientHash = view.getUint32(offset, true); offset += 4;
                        const seq = view.getUint32(offset, true); offset += 4; // UInt32 to support >65535 inputs
                        const dataLen = view.getUint16(offset, true); offset += 2;

                        if (offset + dataLen > buffer.byteLength) break;

                        const rawBytes = new Uint8Array(buffer, offset, dataLen);
                        offset += dataLen;

                        // Detect format: JSON starts with '{' (0x7B) or '[' (0x5B)
                        let data: any;
                        const firstByte = rawBytes[0];

                        if (firstByte === 0x7B || firstByte === 0x5B) {
                            // JSON format - decode for join/leave inputs
                            try {
                                const jsonStr = new TextDecoder().decode(rawBytes);
                                data = JSON.parse(jsonStr);
                            } catch {
                                data = rawBytes;
                            }
                        } else {
                            // Binary format - pass raw bytes to application layer
                            data = rawBytes;
                        }

                        // Use clientId from JSON data if available, otherwise look up from hash
                        let clientId: string;
                        if (typeof data === 'object' && !(data instanceof Uint8Array) && data.clientId) {
                            clientId = data.clientId;
                            registerClientId(clientId);
                        } else {
                            clientId = lookupClientHash(clientHash) || `hash_${clientHash.toString(16)}`;
                        }

                        inputs.push({ seq, data, clientId, clientHash });
                    }
                }
                // Return both 'inputs' and 'events' for backwards compatibility
                return { type: 'TICK', frame, snapshotFrame, snapshotHash, majorityHash, inputs, events: inputs };
            }

            case BinaryMessageType.INITIAL_STATE: {
                // Binary format: [type:1][frame:4][roomIdLen:2][roomId][snapshotLen:4][snapshot][inputCount:2][inputs...]
                // Each input: [clientHash:4][seq:4][frame:4][dataLen:2][data] (same as TICK)
                // Snapshot contains clientIdMap.toNum with full clientId strings
                let offset = 1;
                const frame = view.getUint32(offset, true); offset += 4;
                const roomIdLen = view.getUint16(offset, true); offset += 2;

                if (offset + roomIdLen > buffer.byteLength) {
                    console.error('[arrr-network] Buffer overflow reading INITIAL_STATE roomId');
                    return null;
                }
                const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen)); offset += roomIdLen;

                const snapshotLen = view.getUint32(offset, true); offset += 4;
                if (offset + snapshotLen > buffer.byteLength) {
                    console.error('[arrr-network] Buffer overflow reading INITIAL_STATE snapshot');
                    return null;
                }
                const snapshotBytes = new Uint8Array(buffer, offset, snapshotLen); offset += snapshotLen;

                // Decode snapshot to extract clientIdMap
                let snapshot: any = null;
                let snapshotHash = '';
                if (snapshotLen > 0) {
                    const firstByte = snapshotBytes[0];
                    if (firstByte === 0x7B) {
                        // JSON format (legacy)
                        try {
                            const jsonStr = new TextDecoder().decode(snapshotBytes);
                            const parsed = JSON.parse(jsonStr);
                            snapshot = parsed.snapshot || parsed;
                            snapshotHash = parsed.snapshotHash || '';
                        } catch {
                            snapshot = null;
                        }
                    } else {
                        // Binary format - decode using codec
                        try {
                            const decoded = decode(snapshotBytes);
                            snapshot = decoded?.snapshot || decoded;
                            snapshotHash = decoded?.hash || '';
                        } catch {
                            snapshot = null;
                        }
                    }
                }

                // Register clientIds from snapshot's clientIdMap BEFORE decoding inputs
                if (snapshot?.clientIdMap?.toNum) {
                    for (const clientId of Object.keys(snapshot.clientIdMap.toNum)) {
                        registerClientId(clientId);
                    }
                }

                // Decode inputs - same format as TICK (clientHash, not full clientId)
                const inputCount = view.getUint16(offset, true); offset += 2;
                const inputs: any[] = [];

                for (let i = 0; i < inputCount && offset < buffer.byteLength; i++) {
                    const clientHash = view.getUint32(offset, true); offset += 4;
                    const seq = view.getUint32(offset, true); offset += 4;
                    const inputFrame = view.getUint32(offset, true); offset += 4;
                    const dataLen = view.getUint16(offset, true); offset += 2;

                    if (offset + dataLen > buffer.byteLength) break;

                    const rawBytes = new Uint8Array(buffer, offset, dataLen);
                    offset += dataLen;

                    // Detect format: JSON starts with '{' (0x7B) or '[' (0x5B)
                    let data: any;
                    const firstByte = rawBytes[0];

                    if (firstByte === 0x7B || firstByte === 0x5B) {
                        try {
                            const jsonStr = new TextDecoder().decode(rawBytes);
                            data = JSON.parse(jsonStr);
                        } catch {
                            data = rawBytes;
                        }
                    } else {
                        data = rawBytes;
                    }

                    // Resolve clientHash → clientId (map populated from snapshot above)
                    // Also check data.clientId for join/leave inputs
                    let clientId: string;
                    if (typeof data === 'object' && !(data instanceof Uint8Array) && data.clientId) {
                        clientId = data.clientId;
                        registerClientId(clientId);
                    } else {
                        clientId = lookupClientHash(clientHash) || `hash_${clientHash.toString(16)}`;
                    }

                    inputs.push({ seq, frame: inputFrame, data, clientId, clientHash });
                }

                // Return decoded snapshot (not raw bytes) - engine doesn't need to decode
                return { type: 'INITIAL_STATE', frame, snapshot, snapshotHash, inputs, events: inputs };
            }

            case BinaryMessageType.ROOM_CREATED: {
                let offset = 1;
                const roomIdLen = view.getUint16(offset, true); offset += 2;
                const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen)); offset += roomIdLen;
                const clientIdLen = view.getUint16(offset, true); offset += 2;
                const clientId = new TextDecoder().decode(new Uint8Array(buffer, offset, clientIdLen)); offset += clientIdLen;
                const snapshotLen = view.getUint32(offset, true); offset += 4;
                const snapshotJson = new TextDecoder().decode(new Uint8Array(buffer, offset, snapshotLen));

                const { snapshot, snapshotHash } = JSON.parse(snapshotJson);
                return { type: 'ROOM_CREATED', roomId, clientId, snapshot, snapshotHash };
            }

            case BinaryMessageType.ROOM_JOINED: {
                let offset = 1;
                const roomIdLen = view.getUint16(offset, true); offset += 2;
                const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen)); offset += roomIdLen;
                const clientIdLen = view.getUint16(offset, true); offset += 2;
                const clientId = new TextDecoder().decode(new Uint8Array(buffer, offset, clientIdLen));
                return { type: 'ROOM_JOINED', roomId, clientId };
            }

            case BinaryMessageType.ERROR: {
                const msgLen = view.getUint16(1, true);
                const message = new TextDecoder().decode(new Uint8Array(buffer, 3, msgLen));
                return { type: 'ERROR', message };
            }

            case BinaryMessageType.SNAPSHOT_UPDATE: {
                let offset = 1;
                const roomIdLen = view.getUint16(offset, true); offset += 2;
                const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen)); offset += roomIdLen;
                const snapshotLen = view.getUint32(offset, true); offset += 4;
                const snapshotJson = new TextDecoder().decode(new Uint8Array(buffer, offset, snapshotLen));

                const { snapshot, snapshotHash } = JSON.parse(snapshotJson);
                return { type: 'SNAPSHOT_UPDATE', roomId, snapshot, snapshotHash };
            }

            case BinaryMessageType.ROOM_LEFT: {
                const roomIdLen = view.getUint16(1, true);
                const roomId = new TextDecoder().decode(new Uint8Array(buffer, 3, roomIdLen));
                return { type: 'ROOM_LEFT', roomId };
            }

            case BinaryMessageType.CLIENT_LIST_UPDATE: {
                let offset = 1;
                const roomIdLen = view.getUint16(offset, true); offset += 2;
                const roomId = new TextDecoder().decode(new Uint8Array(buffer, offset, roomIdLen)); offset += roomIdLen;
                const clientsLen = view.getUint32(offset, true); offset += 4;
                const clientsJson = new TextDecoder().decode(new Uint8Array(buffer, offset, clientsLen));
                const clients = JSON.parse(clientsJson);
                return { type: 'CLIENT_LIST_UPDATE', roomId, clients };
            }

            case BinaryMessageType.INPUT_SLACK: {
                // [0x0C][frame:4][count:1]([target:4][slack:int8] x count)
                const frame = view.getUint32(1, true);
                const n = view.getUint8(5);
                const slack: { target: number; slack: number }[] = [];
                for (let i = 0; i < n && 11 + 5 * i <= buffer.byteLength; i++) slack.push({ target: view.getUint32(6 + 5 * i, true), slack: view.getInt8(10 + 5 * i) });
                return { type: 'INPUT_SLACK', frame, slack };
            }

            case BinaryMessageType.BINARY_SNAPSHOT: {
                // Binary snapshot: [marker:1][data:rest]
                // Data is opaque binary from engine's codec
                const binaryData = new Uint8Array(buffer, 1);
                return { type: 'BINARY_SNAPSHOT', binaryData };
            }

            default:
                return null;
        }
    } catch (err) {
        console.error('[arrr-network] Decode error:', err);
        return null;
    }
}

async function toArrayBuffer(data: any): Promise<ArrayBuffer> {
    if (data instanceof ArrayBuffer) return data;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return await data.arrayBuffer();
    return new Uint8Array(data).buffer;
}

/**
 * Rewrite a loopback node address to the page's own origin.
 *
 * Central tells a client where to reach its node, and it says so with the
 * address the node registered. When the whole stack is tunnelled through one
 * port - which is the arrangement for any environment that exposes a single
 * port, and the reason `e2e/play.js` exists - that address is
 * `ws://localhost:<port>/nodews`. Correct for a browser on the same machine,
 * and meaningless for one anywhere else: `localhost` there is the viewer's own
 * computer, so the socket is opened against them and never reaches the mesh.
 *
 * The symptom is not an error. The page loads, central answers, the token is
 * valid, and the socket simply never opens - so the client sits at frame 0 with
 * no world, and a 3D demo draws an empty scene. Reported as "all I see is
 * black", which is what an unreachable node looks like from the outside.
 *
 * Only loopback is rewritten, and only when this page is not itself on
 * loopback. A deployment where central names a real host means it, and a
 * developer genuinely on localhost is already right - neither is touched. The
 * scheme follows the page, so an https page gets wss and is not blocked as
 * mixed content.
 */
function sameOriginIfLoopback(url: string): string {
    if (!url || typeof location === 'undefined' || !location.host) return url;
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        return url;   // not absolute; leave it for the caller to fail on loudly
    }
    if (!loopback.test(target.hostname)) return url;
    if (loopback.test(location.hostname)) return url;

    const secure = location.protocol === 'https:';
    const rewritten = `${secure ? 'wss:' : 'ws:'}//${location.host}${target.pathname}${target.search}`;
    console.warn(
        `[arrr-network] central pointed at ${url}, which is this browser rather than the server. ` +
        `Using ${rewritten} instead - the page is not on localhost, so the node is reachable ` +
        `through the same origin it was served from.`
    );
    return rewritten;
}

export async function connect(roomId: string, options: ConnectOptions): Promise<Connection> {
    console.log(`[ecs] Starting game locally, connecting to room "${roomId}"...`);
    const initialSnapshot = options.snapshot || {};
    const user = options.user || null;
    const onConnect = options.onConnect || (() => { });
    const onDisconnect = options.onDisconnect || (() => { });
    const onError = options.onError || ((err: string) => console.error('[arrr-network]', err));

    /**
     * Call into the application, and survive it going wrong.
     *
     * Everything the application is handed - the tick, the catch-up, a resync -
     * is called from inside an async onmessage handler. An exception there
     * leaves as an unhandled rejection and takes the rest of that handler with
     * it, which is how somebody else's bug becomes a fault with no error
     * attached to it anywhere.
     *
     * What goes missing differs per call site and is documented at each. The
     * common part is this: the engine cannot fix an application that throws,
     * and it can refuse to be the reason nobody finds out.
     */
    const callApp = (what: string, fn: () => void): void => {
        try {
            fn();
        } catch (err) {
            const detail = (err as Error)?.message || String(err);
            console.error(`[arrr-network] the application threw in ${what}:`, err);
            onError(`application threw in ${what}: ${detail}`);
        }
    };
    const onMessage = options.onMessage || (() => { });
    const onTick = options.onTick || null;
    const onVoice = options.onVoice || null;
    let voiceSeq = 0;
    let voiceReady = false;
    const getStateHash = options.getStateHash || null;
    const appId = options.appId;
    if (!appId) {
        throw new Error('[arrr-network] appId is required. Pass appId in connect options.');
    }

    const centralServiceUrl = options.centralServiceUrl || 'https://cloud.arrr.fun';

    console.log('[arrr-network] Central service URL:', centralServiceUrl);

    let connected = false;
    let initialConnectionComplete = false;  // True after first INITIAL_STATE is processed (not resync)
    /**
     * Sequence numbers already delivered, so a replayed or duplicated input is
     * not applied twice.
     *
     * Bounded, because this used to grow for the lifetime of the connection: at
     * 20Hz with five clients that is about a hundred entries a second, or a few
     * hundred thousand an hour, in every browser connected to the room. Sequence
     * numbers only ever increase, so anything far enough below the high-water
     * mark can never be seen again and is dead weight.
     */
    let deliveredSeqs = new Set<number>();
    let highestDeliveredSeq = -1;
    // Wide enough to cover any retransmission or catch-up replay, and no wider.
    // The first cut at this kept 20000 - which bounded the set but left it the
    // single largest live allocation in a bot, because a duplicate arrives
    // within a handful of inputs or not at all. Two thousand is still an order
    // of magnitude more than anything observed.
    const DELIVERED_SEQ_WINDOW = 2000;

    function markDelivered(seq: number): void {
        if (typeof seq !== 'number') return;
        deliveredSeqs.add(seq);
        if (seq > highestDeliveredSeq) highestDeliveredSeq = seq;
        // Prune in batches rather than on every input: rebuilding a Set is far
        // more expensive than the membership test it protects.
        if (deliveredSeqs.size > DELIVERED_SEQ_WINDOW * 2) {
            const floor = highestDeliveredSeq - DELIVERED_SEQ_WINDOW;
            const kept = new Set<number>();
            for (const s of deliveredSeqs) if (s >= floor) kept.add(s);
            deliveredSeqs = kept;
        }
    }
    let pendingTicks: DecodedMessage[] = [];
    let ws: WebSocket | null = null;
    let nodeUrl: string | null = null;
    // True unless a specific node was requested and central assigned another.
    let nodePreferenceHonored = true;
    let nodeToken: string | null = null;
    let tickRate: number = options.fps || 20;  // Default 20fps, overridden by central service
    let connectionResolve: ((value: Connection | PromiseLike<Connection>) => void) | null = null;

    let bytesIn = 0;
    let bytesOut = 0;
    let lastBytesIn = 0;
    let lastBytesOut = 0;
    let bandwidthIn = 0;
    let bandwidthOut = 0;
    let bandwidthInterval: any = null;
    let hashInterval: any = null;
    let lastSyncSeq = 0;
    let lastSyncFrame = 0;
    let currentFrame = 0;
    let myClientId: string | null = null;

    // Process inputs to auto-register clientIds from join/leave/disconnect/reconnect inputs
    // This is CRITICAL for binary TICK decoding - the hash lookup needs clientIds registered
    function processInputsForClientIds(inputs: NetworkInput[]): void {
        for (const input of inputs) {
            const data = input.data || {};
            const inputType = data.type || input.type;

            if (inputType === 'join' || inputType === 'reconnect') {
                // Register clientId for new joins and reconnections
                const clientId = data.clientId || input.clientId;
                if (clientId) {
                    registerClientId(clientId);
                }
            } else if (inputType === 'leave') {
                // Only unregister on permanent leave (not disconnect)
                // Disconnected members may reconnect with a new clientId
                const clientId = data.clientId || input.clientId;
                if (clientId) {
                    unregisterClientId(clientId);
                }
            }
            // Note: 'disconnect' inputs do NOT unregister the clientId
            // The member is still part of the room, just temporarily offline
        }
    }

    try {
        // Build request body for central service
        const requestBody: any = {};
        if (options.joinToken) {
            requestBody.joinToken = options.joinToken;
        }

        // Include authToken if provided or auto-get from auth module
        const authToken = options.authToken || (typeof localStorage !== 'undefined' ? localStorage.getItem('arrr_auth_token') : null);
        if (authToken && !options.joinToken) {
            requestBody.authToken = authToken;
        }

        // If nodeUrl is specified, extract node port for preferredNodeId
        // This allows multi-node testing while still getting proper JWT auth
        if (options.nodeUrl) {
            // Extract port from nodeUrl (e.g., "ws://localhost:8001/ws" -> look up nodeId by port)
            const portMatch = options.nodeUrl.match(/:(\d+)/);
            if (portMatch) {
                // Use port as hint - central will map this to actual nodeId
                requestBody.preferredNodeId = `port_${portMatch[1]}`;
            }
            console.log('[arrr-network] Requesting preferred node:', options.nodeUrl);
        }

        // Always use the app-specific endpoint
        // Use appId='dev' for development/examples
        const connectUrl = `${centralServiceUrl}/api/apps/${appId}/rooms/${roomId}/connect`;

        const connectHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (options.apiKey) {
            connectHeaders['x-api-key'] = options.apiKey;
        }
        const res = await fetch(connectUrl, {
            method: 'POST',
            headers: connectHeaders,
            body: JSON.stringify(requestBody)
        });

        if (!res.ok) {
            const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            throw new Error(`Failed to get node assignment: ${errorData.error || res.statusText}`);
        }

        const responseData = await res.json();
        // Always use central's assigned node - token is signed for that node
        nodeUrl = sameOriginIfLoopback(responseData.url);
        nodeToken = responseData.token;
        tickRate = responseData.fps || 20;  // Server-provided tick rate
        // Whether the node we asked for is the node we got. Central is free to
        // decline - it may not know that node, or the room may already have an
        // authority elsewhere - and until now the only trace of that was a
        // console line. A caller that pinned a node for a reason then carried on
        // against a different one believing otherwise, which is precisely how a
        // cross-node test can pass without ever crossing a node.
        // Central decides this now and says so, because it is the only party
        // that knows. Comparing the URL asked for against the URL returned is
        // wrong as soon as a node is reachable at more than one address: under a
        // tunnel the node advertises the tunnel, so a request that WAS honoured
        // came back looking declined. The comparison stays as a fallback for a
        // central that predates the field.
        nodePreferenceHonored = !options.nodeUrl
            || (typeof responseData.preferenceHonored === 'boolean'
                ? responseData.preferenceHonored
                : responseData.url === options.nodeUrl);
        if (options.nodeUrl && !nodePreferenceHonored) {
            console.warn(
                `[arrr-network] asked for node ${options.nodeUrl} but central assigned ` +
                `${responseData.url}; this connection is NOT on the requested node`
            );
        }
        console.log('[arrr-network] Received Node URL:', nodeUrl, 'token:', nodeToken ? 'yes' : 'no', 'fps:', tickRate, nodePreferenceHonored && options.nodeUrl ? '(preferred)' : '');

        const WS = (typeof globalThis !== 'undefined' && globalThis.WebSocket) ? globalThis.WebSocket : WebSocket;

        return new Promise<Connection>((resolve, reject) => {
            connectionResolve = resolve;

            // Connection timeout - if we don't get ROOM_CREATED, INITIAL_STATE, etc. within 10 seconds, fail
            const CONNECTION_TIMEOUT_MS = 10000;
            const connectionTimeout = setTimeout(() => {
                if (!connected) {
                    const errMsg = `Connection timeout after ${CONNECTION_TIMEOUT_MS}ms - server did not respond with room state`;
                    console.error(`[arrr-network] ${errMsg}`);
                    if (ws) ws.close();
                    reject(new Error(errMsg));
                }
            }, CONNECTION_TIMEOUT_MS);

            // Helper to clear timeout on successful connection
            const clearConnectionTimeout = () => {
                clearTimeout(connectionTimeout);
            };

            // Append JWT token to WebSocket URL if provided by central service
            const wsUrl = nodeToken ? `${nodeUrl}?token=${encodeURIComponent(nodeToken)}` : nodeUrl;

            // @ts-ignore
            ws = new WS(wsUrl);
            ws!.binaryType = 'arraybuffer';

            /**
             * Close the socket on page unload, and say why it is closing.
             *
             * A closed socket carries no reason, so the node has to assume any
             * disconnection might be a network blip and holds the player's slot
             * for a two-minute grace before removing them from the room. That is
             * the right call for a socket that died on its own; it is the wrong
             * one for a tab being closed, and it is why a player who quit stayed
             * in the world - and on the scoreboard - long after they had gone.
             *
             * The page knows what the socket cannot: an unload means it is
             * closing or reloading, and both are settled within seconds. GOING_AWAY
             * passes that on, and the node expires the member on a short grace
             * unless they rejoin first, which is exactly what a reload does.
             *
             * Sent before close() rather than instead of it: the message is
             * queued on a socket that is then closed normally, so the browser
             * flushes it as part of the closing handshake. If it does not make
             * it out - the tab is being killed, the socket is already half
             * shut - nothing breaks, and the member falls back to the long
             * grace they would have had anyway.
             *
             * `pagehide` as well as `beforeunload`, because mobile Safari fires
             * only the former when a tab is discarded, which is precisely the
             * case that used to leave a permanent body in the arena.
             */
            const handleBeforeUnload = () => {
                if (ws && ws.readyState === 1) {
                    try {
                        ws.send(JSON.stringify({ type: 'GOING_AWAY', payload: { roomId: roomId } }));
                    } catch {
                        // Nothing to do: the close below is the part that matters.
                    }
                    ws.close();
                }
            };
            if (typeof window !== 'undefined') {
                window.addEventListener('beforeunload', handleBeforeUnload);
                window.addEventListener('pagehide', handleBeforeUnload);
            }

            const instance: Connection = {
                send(data: any, targetFrame?: number) {
                    if (!connected || !ws || ws.readyState !== 1) return;

                    // If data is already binary (Uint8Array/ArrayBuffer), send with binary marker + frame
                    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                        const binary = data instanceof Uint8Array ? data : new Uint8Array(data);
                        // Binary format: [marker:1][frame:4][data:...]
                        const wrapper = new Uint8Array(1 + 4 + binary.length);
                        const view = new DataView(wrapper.buffer);
                        wrapper[0] = 0x20;  // Binary input marker
                        view.setUint32(1, targetFrame ?? currentFrame, true);  // The frame this input is for
                        wrapper.set(binary, 5);
                        bytesOut += wrapper.length;
                        ws!.send(wrapper);
                        return;
                    }

                    // Otherwise send as JSON, the target frame alongside.
                    const msg = JSON.stringify({ type: 'SEND_INPUT', payload: { roomId: roomId, data, frame: targetFrame ?? currentFrame } });
                    bytesOut += msg.length;
                    ws!.send(msg);
                },
                sendSnapshot(snapshot: any, hash: string, seq?: number, frame?: number) {
                    if (!connected || !ws) return;

                    // If snapshot is binary (Uint8Array/ArrayBuffer), send with binary marker
                    if (snapshot instanceof Uint8Array || snapshot instanceof ArrayBuffer) {
                        const binary = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
                        const hashBytes = new TextEncoder().encode(hash || '');
                        // Binary format v3: [marker:1][seq:4][frame:4][hashLen:1][hash:hashLen][binary:...]
                        // This allows server to read seq/frame/hash without decoding the binary payload
                        const wrapper = new Uint8Array(1 + 4 + 4 + 1 + hashBytes.length + binary.length);
                        wrapper[0] = 0x23;  // Binary snapshot v3 marker (with hash)
                        const view = new DataView(wrapper.buffer);
                        view.setUint32(1, seq ?? 0, true);
                        view.setUint32(5, frame ?? 0, true);
                        wrapper[9] = hashBytes.length;
                        wrapper.set(hashBytes, 10);
                        wrapper.set(binary, 10 + hashBytes.length);
                        bytesOut += wrapper.length;
                        ws!.send(wrapper);
                        return;
                    }

                    // Otherwise send as JSON (legacy)
                    const msg = JSON.stringify({ type: 'SEND_SNAPSHOT', payload: { roomId: roomId, snapshot, hash } });
                    bytesOut += msg.length;
                    ws!.send(msg);
                },
                leaveRoom() {
                    if (connected && ws) {
                        // Send proper LEAVE_ROOM message to permanently exit the room
                        // This broadcasts a "leave" input to other clients
                        const msg = JSON.stringify({ type: 'LEAVE_ROOM', payload: { roomId: roomId } });
                        bytesOut += msg.length;
                        ws!.send(msg);
                    }
                    // Close the WebSocket after sending leave message
                    if (ws) ws!.close();
                },
                getClients() {
                    if (connected && ws && ws.readyState === 1) {
                        const msg = JSON.stringify({ type: 'GET_CLIENTS', payload: { roomId: roomId } });
                        bytesOut += msg.length;
                        ws!.send(msg);
                    }
                },
                close() {
                    if (ws) ws!.close();
                },
                get connected() { return connected; },
                get clientId() { return myClientId; },
                get node() { return nodeUrl ? (nodeUrl.match(/:(\d+)/)?.[1] || nodeUrl) : null; },
                /** False when a specific node was asked for and central assigned another. */
                get nodePreferenceHonored() { return nodePreferenceHonored; },
                get bandwidthIn() { return bandwidthIn; },
                get bandwidthOut() { return bandwidthOut; },
                get totalBytesIn() { return bytesIn; },
                get totalBytesOut() { return bytesOut; },
                get frame() { return currentFrame; },
                getLatency() { return '0'; },
                sendStateHash(frame: number, hash: number) {
                    if (!connected || !ws || ws.readyState !== 1) return;
                    // Format: [0x30][frame:4][stateHash:4] = 9 bytes
                    const buffer = new Uint8Array(9);
                    const view = new DataView(buffer.buffer);
                    buffer[0] = BinaryMessageType.STATE_HASH;
                    view.setUint32(1, frame, true);
                    view.setUint32(5, hash >>> 0, true);  // Ensure unsigned 32-bit
                    bytesOut += 9;
                    ws!.send(buffer);
                },
                sendPartitionData(frame: number, partitionId: number, data: Uint8Array) {
                    if (!connected || !ws || ws.readyState !== 1) return;
                    // Format: [0x31][frame:4][partitionId:1][len:2][data:N]
                    const buffer = new Uint8Array(8 + data.length);
                    const view = new DataView(buffer.buffer);
                    buffer[0] = BinaryMessageType.PARTITION_DATA;
                    view.setUint32(1, frame, true);
                    buffer[5] = partitionId;
                    view.setUint16(6, data.length, true);
                    buffer.set(data, 8);
                    bytesOut += buffer.length;
                    ws!.send(buffer);
                },
                get voiceReady() {
                    return voiceReady && connected;
                },
                sendVoice(x: number, y: number, z: number, data?: Uint8Array | null) {
                    if (!connected || !voiceReady || !ws || ws.readyState !== 1) return;
                    const body = data || new Uint8Array(0);
                    const packet = new Uint8Array(17 + body.length);
                    const view = new DataView(packet.buffer);
                    packet[0] = BinaryMessageType.VOICE;
                    view.setUint16(1, voiceSeq++ & 0xffff, true);
                    view.setFloat32(3, x, true);
                    view.setFloat32(7, y, true);
                    view.setFloat32(11, z, true);
                    view.setUint16(15, body.length, true);
                    packet.set(body, 17);
                    bytesOut += packet.length;
                    ws.send(packet);
                },
                requestResync() {
                    if (!connected || !ws || ws.readyState !== 1) return;
                    // Request full state resync from server (desync recovery)
                    const msg = JSON.stringify({ type: 'REQUEST_RESYNC', payload: { roomId: roomId } });
                    bytesOut += msg.length;
                    ws!.send(msg);
                    console.log('[arrr-network] Requested resync from server');
                },

                // Callbacks that can be set by the game engine
                onReliabilityUpdate: undefined,
                onMajorityHash: undefined,
                onResyncSnapshot: undefined
            };

            ws!.onopen = () => {
                bandwidthInterval = setInterval(() => {
                    bandwidthIn = bytesIn - lastBytesIn;
                    bandwidthOut = bytesOut - lastBytesOut;
                    lastBytesIn = bytesIn;
                    lastBytesOut = bytesOut;
                }, 1000);

                if (getStateHash) {
                    hashInterval = setInterval(() => {
                        if (!connected || !ws || ws!.readyState !== 1) return;
                        try {
                            const hash = getStateHash();
                            if (hash) {
                                const hashMsg = encodeSyncHash(roomId, hash, lastSyncSeq, lastSyncFrame);
                                bytesOut += hashMsg.byteLength;
                                ws!.send(hashMsg);
                            }
                        } catch (err) {
                            console.warn('[arrr-network] Error getting state hash:', err);
                        }
                    }, 1000);
                }

                // Include user metadata - server will generate the join input
                const joinMsg = JSON.stringify({ type: 'JOIN_ROOM', payload: { roomId: roomId, user } });
                bytesOut += joinMsg.length;
                ws!.send(joinMsg);
            };

            ws!.onerror = (e: any) => {
                clearConnectionTimeout();
                const errMsg = `Failed to connect to ${nodeUrl}: ${e.message || 'Unknown error'}`;
                onError(errMsg);
                if (!connected) reject(new Error(errMsg));
            };

            ws!.onclose = () => {
                clearConnectionTimeout();
                connected = false;
                voiceReady = false;
                if (bandwidthInterval) clearInterval(bandwidthInterval);
                if (hashInterval) clearInterval(hashInterval);
                // Clean up unload listeners
                if (typeof window !== 'undefined') {
                    window.removeEventListener('beforeunload', handleBeforeUnload);
                    window.removeEventListener('pagehide', handleBeforeUnload);
                }
                onDisconnect();
            };

            ws!.onmessage = async (e: any) => {
                let buffer: ArrayBuffer;
                try {
                    buffer = await toArrayBuffer(e.data);
                } catch (err) {
                    console.warn('[arrr-network] Failed to read message data:', err);
                    return;
                }

                bytesIn += buffer.byteLength;
                // Voice ahead of everything: the most frequent message in a
                // room where people talk, and none of the machinery below
                // applies to it.
                if (buffer.byteLength === 1 && new Uint8Array(buffer)[0] === BinaryMessageType.VOICE_READY) {
                    voiceReady = true;
                    return;
                }
                if (buffer.byteLength >= 18 && new Uint8Array(buffer)[0] === BinaryMessageType.VOICE_FROM) {
                    if (onVoice) {
                        const v = new DataView(buffer);
                        const idLen = v.getUint8(1);
                        let at = 2;
                        if (buffer.byteLength < at + idLen + 16) return;
                        const from = new TextDecoder().decode(new Uint8Array(buffer, at, idLen)); at += idLen;
                        const seq = v.getUint16(at, true); at += 2;
                        const x = v.getFloat32(at, true); at += 4;
                        const y = v.getFloat32(at, true); at += 4;
                        const z = v.getFloat32(at, true); at += 4;
                        const len = v.getUint16(at, true); at += 2;
                        if (buffer.byteLength < at + len) return;
                        callApp('a voice frame', () => onVoice(from, seq, x, y, z, new Uint8Array(buffer, at, len)));
                    }
                    return;
                }
                const msg = decodeBinaryMessage(buffer);
                // console.log("decoded msg: ", msg);
                if (!msg) return;

                switch (msg.type) {
                    case 'TICK': {
                        if (!connected) {
                            pendingTicks.push(msg);
                            break;
                        }
                        currentFrame = msg.frame!;
                        lastSyncFrame = msg.frame!;
                        const tickInputs = msg.inputs || msg.events || [];
                        if (tickInputs && tickInputs.length > 0) {
                            const maxSeq = Math.max(...tickInputs.map((e: any) => e.seq || 0));
                            if (maxSeq > lastSyncSeq) lastSyncSeq = maxSeq;
                        }
                        const newInputs = tickInputs.filter((e: any) => !deliveredSeqs.has(e.seq));
                        newInputs.forEach((e: any) => markDelivered(e.seq));
                        // Auto-register clientIds from join/leave inputs
                        if (newInputs.length > 0) {
                            processInputsForClientIds(newInputs);
                        }
                        if (onTick) {
                            // Guarded, because what is on the other side of this
                            // call is somebody else's simulation.
                            //
                            // An application that throws here - its own bug, an
                            // assertion, an input it did not expect - used to
                            // take the exception out of an async onmessage
                            // handler as an unhandled rejection, and these
                            // inputs were marked delivered a few lines above, so
                            // they are never offered again. The client silently
                            // goes without them and diverges from that frame on,
                            // while the engine reports nothing at all: their bug
                            // arrives looking like ours, with no error anywhere
                            // to say otherwise.
                            //
                            // The inputs stay marked - the server will not send
                            // them again and re-offering a seq would risk
                            // applying it twice - so what is recoverable here is
                            // not the frame but the knowledge that it was lost.
                            // Saying so turns a silent desync into a reported
                            // one, which the desync machinery can then act on.
                            // The inputs above are already marked delivered, so a throw
                            // here loses them for good: the server will not send them
                            // again and re-offering a sequence number risks applying it
                            // twice. What is recoverable is not the frame but the
                            // knowledge that it went missing.
                            callApp(`the tick for frame ${msg.frame}`, () =>
                                onTick(msg.frame!, newInputs, msg.snapshotFrame, msg.snapshotHash, msg.majorityHash));
                        }
                        break;
                    }
                    case 'ERROR': {
                        if (msg.message === 'Room not found') {
                            // Include user metadata - server will generate the join input
                            const createMsg = JSON.stringify({
                                type: 'CREATE_ROOM',
                                payload: { roomId: roomId, snapshot: initialSnapshot, user }
                            });
                            bytesOut += createMsg.length;
                            ws!.send(createMsg);
                        } else {
                            clearConnectionTimeout();
                            onError(msg.message!);
                            reject(new Error(msg.message));
                        }
                        break;
                    }
                    case 'ROOM_CREATED': {
                        connected = true;
                        clearConnectionTimeout();
                        currentFrame = 0;
                        // Server tells us our clientId - register it for hash lookup
                        if (msg.clientId) {
                            myClientId = msg.clientId;
                            registerClientId(msg.clientId);
                            console.log(`[arrr-network] Assigned clientId: ${msg.clientId}`);
                        }
                        // Server generates join input - don't send one from client
                        // A throw here used to skip connectionResolve below, so the
                        // application's connect() never settled: it waited forever for
                        // a connection that was already open, with nothing reported.
                        callApp('onConnect', () => onConnect(initialSnapshot, [], 0, nodeUrl!, tickRate, myClientId!));
                        if (connectionResolve) connectionResolve(instance);
                        break;
                    }
                    case 'INITIAL_STATE': {
                        // Use initialConnectionComplete (not connected) to determine if this is a resync
                        // ROOM_JOINED sets connected=true before INITIAL_STATE arrives,
                        // but initialConnectionComplete is only true AFTER first INITIAL_STATE is processed
                        const isResync = initialConnectionComplete;
                        console.log(`[arrr-network] Received INITIAL_STATE, ${isResync ? 'RESYNC' : 'connecting'}...`);

                        const { snapshot, frame, snapshotHash } = msg;
                        // Attach snapshotHash to snapshot object so engine can access it
                        if (snapshot && snapshotHash) {
                            snapshot.snapshotHash = snapshotHash;
                        }
                        const inputs = msg.inputs || msg.events || [];
                        currentFrame = frame!;
                        lastSyncFrame = frame!;
                        if (inputs && inputs.length > 0) {
                            const maxSeq = Math.max(...inputs.map((e: any) => e.seq || 0));
                            if (maxSeq > lastSyncSeq) lastSyncSeq = maxSeq;
                            // CRITICAL: Mark all INITIAL_STATE inputs as delivered
                            // to prevent duplicate processing when same inputs arrive via TICK
                            inputs.forEach((e: any) => markDelivered(e.seq));
                        }

                        // Auto-register clientIds from join inputs in history
                        if (inputs && inputs.length > 0) {
                            processInputsForClientIds(inputs);
                        }

                        if (isResync) {
                            // RESYNC: We were already connected, this is a response to requestResync()
                            // Call onResyncSnapshot callback with binary snapshot data AND inputs for catchup
                            if (instance.onResyncSnapshot && msg.binaryData) {
                                console.log(`[arrr-network] Calling onResyncSnapshot with ${msg.binaryData.length} bytes, frame=${frame}, inputs=${inputs?.length || 0}`);
                                callApp('onResyncSnapshot', () =>
                                    instance.onResyncSnapshot!(msg.binaryData!, frame!, inputs || []));
                            } else if (instance.onResyncSnapshot && snapshot) {
                                // Legacy: snapshot is JSON object, convert to binary for callback
                                const snapshotJson = JSON.stringify({ snapshot, snapshotHash });
                                const encoder = new TextEncoder();
                                const binaryData = encoder.encode(snapshotJson);
                                console.log(`[arrr-network] Calling onResyncSnapshot with JSON snapshot (${binaryData.length} bytes), frame=${frame}, inputs=${inputs?.length || 0}`);
                                // The repair itself. A throw here loses the snapshot the
                                // client asked for, so it stays diverged and asks again -
                                // which looks like a resync that does not work rather than
                                // an application that does not.
                                callApp('onResyncSnapshot', () =>
                                    instance.onResyncSnapshot!(binaryData, frame!, inputs || []));
                            } else {
                                console.warn('[arrr-network] RESYNC received but no onResyncSnapshot callback registered!');
                            }
                        } else {
                            // INITIAL CONNECTION: Standard flow
                            connected = true;
                            initialConnectionComplete = true;  // Mark initial connection as complete
                            clearConnectionTimeout();

                            // CRITICAL FIX: Register clientIds from snapshot's clientIdMap BEFORE processing inputs
                            // This ensures inputs can resolve hashed clientIds to full strings
                            // Without this, game inputs from clients whose join is in the snapshot would have
                            // unresolved hash_XXX clientIds, causing desync during catchup
                            if (snapshot?.clientIdMap?.toNum) {
                                for (const [clientId] of Object.entries(snapshot.clientIdMap.toNum)) {
                                    registerClientId(clientId);
                                }
                            }

                            // Re-resolve clientIds in inputs now that snapshot clientIds are registered
                            if (inputs && inputs.length > 0) {
                                for (const inp of inputs) {
                                    reResolveClientId(inp);
                                }
                            }

                            // Guarded for the same reason, and with more to lose: a
                            // throw here also skipped the held ticks replayed just
                            // below, so the client silently began life missing both its
                            // catch-up and the frames that arrived during it. Carrying
                            // on leaves a client that is wrong and visibly so, which
                            // the desync machinery can act on; not carrying on leaves
                            // an application waiting on a promise that never settles.
                            callApp('onConnect', () =>
                                onConnect(snapshot, inputs || [], frame!, nodeUrl, tickRate, myClientId!));

                            // Process pending ticks
                            // CRITICAL: Pending ticks were decoded before INITIAL_STATE registered clientIds,
                            // so their clientId fields may have fallback hash values. We need to re-resolve.
                            if (pendingTicks.length > 0) {
                                pendingTicks.sort((a, b) => a.frame! - b.frame!);
                                for (const tickMsg of pendingTicks) {
                                    const tickInputs = (tickMsg.inputs || tickMsg.events || []).filter((e: any) => !deliveredSeqs.has(e.seq));
                                    tickInputs.forEach((e: any) => markDelivered(e.seq));
                                    // Auto-register clientIds from pending ticks too
                                    if (tickInputs.length > 0) {
                                        processInputsForClientIds(tickInputs);
                                    }
                                    // Re-resolve clientIds now that join events have registered mappings
                                    for (const inp of tickInputs) {
                                        reResolveClientId(inp);
                                    }
                                    // Only frames the catch-up did not already cover.
                                    //
                                    // `frame` is where INITIAL_STATE left this client: the
                                    // snapshot plus the inputs sent with it, replayed. A held
                                    // tick at or before that frame has therefore already been
                                    // accounted for, and delivering it makes the client apply
                                    // the frame a second time - measured as a joiner whose
                                    // world matched the publisher's exactly at the moment it
                                    // restored and disagreed with the room one tick later.
                                    //
                                    // The `tickInputs.length > 0` disjunct that used to be
                                    // here defeated the frame check whenever the tick carried
                                    // any input not already marked delivered, which is
                                    // precisely the case that goes wrong: those inputs are
                                    // already in the snapshot, so applying them again is
                                    // applying them twice.
                                    if (onTick && tickMsg.frame! > frame!) {
                                        onTick(tickMsg.frame!, tickInputs, tickMsg.snapshotFrame, tickMsg.snapshotHash, tickMsg.majorityHash);
                                    }
                                }
                                pendingTicks = [];
                            }
                        }

                        if (connectionResolve) connectionResolve(instance);
                        break;
                    }
                    case 'ROOM_JOINED': {
                        // Server tells us our clientId - register it for hash lookup
                        connected = true;
                        if (msg.clientId) {
                            myClientId = msg.clientId;
                            registerClientId(msg.clientId);
                            console.log(`[arrr-network] Assigned clientId: ${msg.clientId}`);
                        }
                        break;
                    }
                    case 'SNAPSHOT_UPDATE': {
                        if (options.onSnapshot) options.onSnapshot(msg.snapshot, msg.snapshotHash!);
                        break;
                    }
                    case 'BINARY_SNAPSHOT': {
                        // Binary snapshot from another client - pass raw bytes to handler
                        if (options.onBinarySnapshot) options.onBinarySnapshot(msg.binaryData!);
                        break;
                    }
                    case 'ROOM_LEFT': {
                        console.log(`[arrr-network] Left room ${msg.roomId}`);
                        break;
                    }
                    case 'INPUT_SLACK': {
                        if (instance.onInputSlack) instance.onInputSlack(msg.frame!, msg.slack!);
                        break;
                    }
                    case 'CLIENT_LIST_UPDATE': {
                        // Learn every connection in the room, not just the ones
                        // whose join this client happened to witness.
                        //
                        // A tick identifies an input's sender by a hash of their
                        // clientId, and that only resolves to a name if the id
                        // has been registered. Registration happened on join
                        // events, so a client that arrived later never learned
                        // the ids of anyone already playing, and their inputs
                        // decoded to a placeholder like "hash_5feacbe4" forever.
                        //
                        // Measured against the running demos: 28% of all applied
                        // inputs carried an unresolvable sender - not a startup
                        // window, a permanent blind spot for everyone who joined
                        // after somebody else. It defeated input attribution for
                        // those senders, and there is a note further down in
                        // this file about unresolved hashes causing desyncs
                        // during catch-up, which is the same root.
                        for (const c of msg.clients || []) {
                            if (c && c.clientId) registerClientId(String(c.clientId));
                        }
                        if (options.onClientsUpdate) options.onClientsUpdate(msg.clients!);
                        break;
                    }
                }
            };
        });
    } catch (err: any) {
        throw new Error(`Failed to get node assignment: ${err.message}`);
    }
}

// Helper to get central service URL
function getCentralServiceUrl(centralServiceUrl?: string): string {
    return centralServiceUrl || 'https://cloud.arrr.fun';
}

// Room listing options
export interface ListRoomsOptions {
    centralServiceUrl?: string;
    limit?: number;
    offset?: number;
}

// Room listing result
export interface RoomInfo {
    id: string;
    clientCount: number;
    authorityNodeId: string;
    createdAt: string;
}

export interface ListRoomsResult {
    rooms: RoomInfo[];
    total: number;
    limit: number;
    offset: number;
}

/**
 * List rooms for an app with client counts
 * @param appId The application ID
 * @param options Optional configuration (centralServiceUrl, limit, offset)
 * @returns Promise with room list and pagination info
 */
export async function listRooms(appId: string, options: ListRoomsOptions = {}): Promise<ListRoomsResult> {
    const centralUrl = getCentralServiceUrl(options.centralServiceUrl);
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const url = `${centralUrl}/api/apps/${encodeURIComponent(appId)}/rooms/list?limit=${limit}&offset=${offset}`;

    const response = await fetch(url);
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Failed to list rooms: ${response.statusText}`);
    }

    return await response.json();
}

// Random room options
export interface GetRandomRoomOptions {
    centralServiceUrl?: string;
    minClients?: number;
    maxClients?: number;
}

// Random room result
export interface RandomRoomResult {
    room: {
        id: string;
        clientCount: number;
        authorityNodeId: string;
    };
}

/**
 * Get a random room for an app (for auto-matchmaking)
 * @param appId The application ID
 * @param options Optional configuration (centralServiceUrl, minClients, maxClients)
 * @returns Promise with a random room matching criteria, or null if none found
 */
export async function getRandomRoom(appId: string, options: GetRandomRoomOptions = {}): Promise<RandomRoomResult | null> {
    const centralUrl = getCentralServiceUrl(options.centralServiceUrl);
    const minClients = options.minClients ?? 0;
    const maxClients = options.maxClients ?? 999;

    const url = `${centralUrl}/api/apps/${encodeURIComponent(appId)}/rooms/random?minClients=${minClients}&maxClients=${maxClients}`;

    const response = await fetch(url);
    if (response.status === 404) {
        // No eligible rooms found
        return null;
    }
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(errorData.error || `Failed to get random room: ${response.statusText}`);
    }

    return await response.json();
}

export const arrr = connect;

// The browser bundles are built with esbuild's globalName, so whatever this
// module exports becomes window.arrrNetwork. Assigning window.arrrNetwork by
// hand here used to be overwritten by that global a moment later, which left
// every script-tag user without arrrNetwork.auth. Export it instead.
import { auth } from './auth.js';
export { auth };
import * as netcode from './netcode/index.js';
import * as lockstep from './lockstep/index.js';
export { netcode, lockstep };

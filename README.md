# arrr-network

Client SDK for the [ARRR network](https://arrr.fun) — a mesh
networking layer with WebSocket rooms, deterministic input ordering, state sync,
and cross-node replication.

This package is transport only: it gets your inputs into a room, in order, and
hands you back the ticks. Simulation is yours.

## Install

```bash
npm install arrr-network
```

Or, in a browser, use the prebuilt IIFE bundle, which exposes the SDK as the
global `arrrNetwork`:

```html
<script src="https://www.arrr.fun/sdk/arrr-network.iife.js"></script>
```

## Usage

```typescript
import { connect } from 'arrr-network';

const conn = await connect('my-room', {
  appId: 'my-app',            // Required - your application ID
  apiKey: 'arrr_…',           // Your app's API key, from the portal (see below)
  user: { id: 'player1' },

  onConnect: (snapshot, events, frame) => {
    console.log('Connected at frame', frame);
  },

  onTick: (frame, events) => {
    for (const event of events) {
      console.log(`Frame ${frame}:`, event.data);
    }
  }
});

conn.send({ move: { x: 1, y: 0 } });
```

By default the SDK asks the central service at `https://nodes.arrr.fun` which
node to dial. Point `centralServiceUrl` (or `nodeUrl`, to skip discovery) at your
own deployment to run against a self-hosted mesh.

`apiKey` is the application API key minted in the portal. It is sent as
`x-api-key` when the SDK asks central for a node. A service running with
`APP_REGISTRATION=key` refuses connections without one; in the default open
mode it is optional, though a key that is unknown or belongs to another app is
refused either way. It ships in your client, so treat it as attribution and a
revocation switch, not a secret - per-user identity is `joinToken` / `authToken`.

## API

| Export | Description |
|--------|-------------|
| `connect(roomId, options)` | Join a room; resolves to a `Connection` |
| `arrr` | Alias of `connect` |
| `listRooms(appId, options?)` | List an app's rooms with client counts |
| `getRandomRoom(appId, options?)` | Pick a room for auto-matchmaking |
| `auth` | Auth module (login, signup, session, providers) |
| `registerClientId(clientId)` | Register a client ID for hash lookup |
| `unregisterClientId(clientId)` | Drop a registered client ID |
| `hashClientId(clientId)` | Hash a client ID the way the wire format does |
| `encodeSyncHash(...)` / `decodeBinaryMessage(...)` | Binary protocol helpers |
| `encode(value)` / `decode(buffer)` | Codec used on the wire |

A `Connection` exposes `send`, `sendSnapshot`, `leaveRoom`, `close`,
`getClients`, and the `connected`, `clientId`, `frame`, `bandwidthIn`,
`bandwidthOut` properties.

Guides and examples are at [arrr.fun](https://arrr.fun). This repository is
published from a private monorepo where the SDK is developed alongside the
node and the cloud service; issues and pull requests are welcome here, and
accepted changes are applied there and appear in the next publish.

## Requirements

Node.js 18 or newer, or any browser with `WebSocket`. In Node the SDK uses `ws`;
in browsers that dependency is stubbed out in favour of the platform
`WebSocket`.

## License

MIT

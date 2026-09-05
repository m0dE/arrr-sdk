// Export arrr-network (the transport-only SDK)
export {
    connect,
    arrr,
    hashClientId,
    registerClientId,
    unregisterClientId,
    encodeSyncHash,
    decodeBinaryMessage,
    listRooms,
    getRandomRoom,
    type Connection,
    type ConnectOptions,
    type NetworkInput,
    type DecodedMessage,
    type ListRoomsOptions,
    type ListRoomsResult,
    type RoomInfo,
    type GetRandomRoomOptions,
    type RandomRoomResult
} from './arrr-network.js';

// Export auth module
export {
    auth,
    type AuthUser,
    type AuthError,
    type AuthProvider,
    type LoginOptions,
    type AuthInitOptions
} from './auth.js';

// Export codec for engine to use
export { encode, decode } from './codec/index.js';

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const STREAM_HOST = "eu-lobby.0xfrag.com";
export const STREAM_PORT = 4433;
export const DEFAULT_SERVER = "eu-lobby.0xfrag.com";

export async function connect(token, server, streamHost, streamPort) {
    return await invoke("connect", {
        token,
        server,
        streamHost,
        streamPort,
    });
}

export async function disconnect() {
    await invoke("disconnect");
}

export async function setInput(keys, yaw, pitch, fire, weaponSlot) {
    await invoke("set_input", { keys, yaw, pitch, fire, weaponSlot });
}

export async function sendChat(text) {
    await invoke("send_chat", { text });
}

export function onWorldState(cb) {
    return listen("world-state", (e) => cb(e.payload));
}

export function onServerEvent(cb) {
    return listen("server-event", (e) => cb(e.payload));
}

export function onTransportClosed(cb) {
    return listen("transport-closed", () => cb());
}

/**
 * Parse a world state payload from the Rust side (already JSON).
 * Provided for API compatibility with the browser client's parseWorldState.
 */
export function parseWorldState(data) {
    return data;
}

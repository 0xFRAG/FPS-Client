import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { open } from "@tauri-apps/plugin-shell";
import { LazyStore } from "@tauri-apps/plugin-store";

const API = "https://0xfrag.com";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let accounts = [];
let activeIndex = 0;
const store = new LazyStore("auth.json");

// Active JWT shorthand
function activeJwt() {
    return accounts[activeIndex]?.jwt ?? null;
}

// --- DOM ---

const $stepLogin = document.getElementById("step-login");
const $stepAccounts = document.getElementById("step-accounts");
const $stepAuthenticated = document.getElementById("step-authenticated");
const $accountList = document.getElementById("account-list");
const $displayUsername = document.getElementById("display-username");
const $displayUserId = document.getElementById("display-user-id");
const $displayUserWallet = document.getElementById("display-user-wallet");
const $status = document.getElementById("status");

// --- Helpers ---

function status(msg, isError = false) {
    $status.textContent = msg ? msg.toUpperCase() : "";
    $status.className = isError ? "status error" : "status";
}

function showStep(step) {
    $stepLogin.hidden = step !== "login";
    $stepAccounts.hidden = step !== "accounts";
    $stepAuthenticated.hidden = step !== "authenticated";
}

async function api(method, path, body = null, jwt = null) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
        const code = res.status;
        if (code === 401) throw new Error("Unauthorized");
        if (code === 404) throw new Error("Not found");
        throw new Error(`HTTP ${code}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// --- Persistence ---

async function saveAccounts() {
    await store.set("accounts", accounts);
    await store.set("activeIndex", activeIndex);
    await store.save();
}

async function loadAccounts() {
    accounts = (await store.get("accounts")) || [];
    activeIndex = (await store.get("activeIndex")) || 0;
    if (activeIndex >= accounts.length) activeIndex = 0;
}

// --- Account management ---

async function addAccount(jwt) {
    const me = await api("GET", "/api/auth/me", null, jwt);
    const entry = {
        jwt,
        username: me.username || null,
        wallet: me.wallet_address,
        id: me.id,
    };

    // Update existing account with same id, or append
    const existing = accounts.findIndex((a) => a.id === entry.id);
    if (existing !== -1) {
        accounts[existing] = entry;
        activeIndex = existing;
    } else {
        accounts.push(entry);
        activeIndex = accounts.length - 1;
    }

    await saveAccounts();
}

function removeAccount(index) {
    accounts.splice(index, 1);
    if (accounts.length === 0) {
        activeIndex = 0;
    } else if (activeIndex >= accounts.length) {
        activeIndex = accounts.length - 1;
    }
    return saveAccounts();
}

async function switchAccount(index) {
    activeIndex = index;
    try {
        status("Validating session...");
        const me = await api("GET", "/api/auth/me", null, accounts[index].jwt);
        // Refresh cached info
        accounts[index].username = me.username || null;
        accounts[index].wallet = me.wallet_address;
        await saveAccounts();
        showAuthenticated(me);
    } catch {
        status("Session expired — account removed", true);
        await removeAccount(index);
        renderAccountSelector();
    }
}

// --- Deep link URL parsing ---

function parseDeepLink(urlStr) {
    try {
        const url = new URL(urlStr);
        if (url.protocol === "xfrag:" && url.hostname === "callback") {
            return {
                token: url.searchParams.get("token"),
                state: url.searchParams.get("state"),
            };
        }
    } catch {
        // Fallback: manual string parsing
    }
    if (urlStr.startsWith("xfrag://callback")) {
        const qs = urlStr.split("?")[1];
        if (qs) {
            const params = new URLSearchParams(qs);
            return {
                token: params.get("token"),
                state: params.get("state"),
            };
        }
    }
    return null;
}

// --- Auth ---

async function loginViaBrowser() {
    const state = crypto.randomUUID();
    let unlisten = null;
    let timeout = null;

    try {
        status("Waiting for browser auth...");

        const authPromise = new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
                reject(new Error("Auth timed out (5 min)"));
            }, AUTH_TIMEOUT_MS);

            onOpenUrl((urls) => {
                for (const urlStr of urls) {
                    const parsed = parseDeepLink(urlStr);
                    if (!parsed) continue;

                    if (!parsed.token) {
                        reject(new Error("Callback missing token"));
                        return;
                    }
                    if (parsed.state !== state) {
                        reject(new Error("State mismatch — possible replay"));
                        return;
                    }

                    resolve(parsed.token);
                    return;
                }
            }).then((fn) => { unlisten = fn; });
        });

        await open(`${API}?state=${encodeURIComponent(state)}`);

        const token = await authPromise;
        await addAccount(token);
        showAuthenticated();
    } catch (e) {
        status(e.message || "Auth failed", true);
    } finally {
        if (timeout) clearTimeout(timeout);
        if (unlisten) unlisten();
    }
}

function showAuthenticated(me) {
    const acct = accounts[activeIndex];
    if (me) {
        $displayUsername.textContent = me.username || "\u2014";
        $displayUserId.textContent = me.id;
        $displayUserWallet.textContent = me.wallet_address;
    } else {
        $displayUsername.textContent = acct?.username || "\u2014";
        $displayUserId.textContent = acct?.id || "";
        $displayUserWallet.textContent = acct?.wallet || "";
    }
    showStep("authenticated");
    status("");
}

async function logout() {
    await removeAccount(activeIndex);
    if (accounts.length > 0) {
        renderAccountSelector();
    } else {
        showStep("login");
    }
    status("");
}

// --- Account selector UI ---

function truncateWallet(wallet) {
    if (!wallet || wallet.length <= 12) return wallet || "";
    return wallet.slice(0, 6) + "..." + wallet.slice(-4);
}

function renderAccountSelector() {
    $accountList.innerHTML = "";
    accounts.forEach((acct, i) => {
        const row = document.createElement("div");
        row.className = "account-item" + (i === activeIndex ? " active" : "");

        const info = document.createElement("div");
        info.className = "account-item-info";
        info.innerHTML =
            `<span class="account-item-name">${acct.username || "\u2014"}</span>` +
            `<span class="account-item-wallet">${truncateWallet(acct.wallet)}</span>`;
        info.addEventListener("click", () => switchAccount(i));

        const removeBtn = document.createElement("button");
        removeBtn.className = "account-item-remove";
        removeBtn.textContent = "\u00D7";
        removeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await removeAccount(i);
            if (accounts.length === 0) {
                showStep("login");
            } else {
                renderAccountSelector();
            }
        });

        row.appendChild(info);
        row.appendChild(removeBtn);
        $accountList.appendChild(row);
    });
    showStep("accounts");
}

// --- Handle deep links received at cold startup ---

async function handleStartupDeepLink() {
    try {
        const urls = await getCurrent();
        if (!urls) return false;
        for (const urlStr of urls) {
            const parsed = parseDeepLink(urlStr);
            if (parsed && parsed.token) {
                await addAccount(parsed.token);
                return true;
            }
        }
    } catch {
        // No startup deep link
    }
    return false;
}

// --- Events ---

document.getElementById("btn-login").addEventListener("click", loginViaBrowser);
document.getElementById("btn-add-account").addEventListener("click", loginViaBrowser);
document.getElementById("btn-logout").addEventListener("click", logout);
document.getElementById("btn-back").addEventListener("click", () => {
    renderAccountSelector();
    status("");
});
document.getElementById("btn-play").addEventListener("click", async () => {
    const jwt = activeJwt();
    const container = document.getElementById("game-container");
    try {
        status("Connecting to game server...");
        document.querySelector(".topbar").hidden = true;
        document.querySelector(".container").hidden = true;
        container.hidden = false;
        const { startGame } = await import("./game.js");
        const reason = await startGame(container, jwt);
        if (reason === "DUPLICATE") {
            status("Connection dropped due to duplicate sync session", true);
        } else {
            status("Disconnected from server");
        }
    } catch (e) {
        status(e.message || String(e), true);
    }
    document.querySelector(".topbar").hidden = false;
    document.querySelector(".container").hidden = false;
    container.hidden = true;
});

// --- Init ---

(async () => {
    try {
        await loadAccounts();

        // Migrate from old single-jwt format
        if (accounts.length === 0) {
            const oldJwt = await store.get("jwt");
            if (oldJwt) {
                try {
                    await addAccount(oldJwt);
                    await store.delete("jwt");
                    await store.save();
                } catch {
                    await store.delete("jwt");
                    await store.save();
                }
            }
        }

        // Check if app was cold-launched via a deep link
        const fromDeepLink = await handleStartupDeepLink();
        if (fromDeepLink) {
            showAuthenticated();
            return;
        }

        if (accounts.length === 0) {
            showStep("login");
        } else if (accounts.length === 1) {
            await switchAccount(0);
        } else {
            renderAccountSelector();
        }
    } catch {
        showStep("login");
    }
})();

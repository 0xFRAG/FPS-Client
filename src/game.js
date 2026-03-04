import * as THREE from "three";
import { createSharedGeometries, updateCharacterAnimation, disposeCharacter } from "./character.js";
import { MOVE_SPEED, GRAVITY, JUMP_VELOCITY, GROUND_SLIP, AIR_SLIP, TICK_DT, EYE_HEIGHT, JUMP_BUFFER_MS, MOUSE_SENSITIVITY, collides, raycastBlocks, rayHitPlayerAABB } from "./physics.js";
import { STREAM_HOST, STREAM_PORT, DEFAULT_SERVER, connect, disconnect, setInput, sendChat, onWorldState, onServerEvent, onTransportClosed } from "./network.js";
import { buildMap, buildLobbyHud } from "./map.js";
import { MAGAZINE_SIZE, MAX_RANGE, updateNameSprite, updatePlayers } from "./combat.js";
import { createChatUI, createHealthBar, createAmmoDisplay, createDeathOverlay, createWeaponWheel, createLoadingOverlay } from "./hud.js";

export async function startGame(container, token) {
    const playerNames = new Map();
    let chatFocused = false;
    let gameReady = false;

    // Build HUD elements
    const chatHud = createChatUI(container);
    const healthHud = createHealthBar(container);
    const ammoHud = createAmmoDisplay(container);
    const deathHud = createDeathOverlay(container);
    const wheelHud = createWeaponWheel(container);
    const loadingHud = createLoadingOverlay(container);

    // Player meshes
    const players = new Map();

    // Event message handler (roster, join, leave, chat)
    function handleEventMessage(msg) {
        if (connectionState !== 'connected' && msg.type !== "chat" && msg.type !== "roster") return;
        switch (msg.type) {
            case "roster":
                playerNames.clear();
                for (const p of msg.players) {
                    playerNames.set(p.player_id, { username: p.username });
                }
                for (const [id, mesh] of players) {
                    const info = playerNames.get(id);
                    if (info) updateNameSprite(mesh, info.username);
                }
                break;
            case "player_joined":
                playerNames.set(msg.player_id, { username: msg.username });
                chatHud.addChatLine(`${msg.username} joined`);
                if (players.has(msg.player_id)) {
                    updateNameSprite(players.get(msg.player_id), msg.username);
                }
                break;
            case "player_left": {
                const info = playerNames.get(msg.player_id);
                if (info) chatHud.addChatLine(`${info.username} left`);
                playerNames.delete(msg.player_id);
                const group = players.get(msg.player_id);
                if (group) {
                    disposeCharacter(group);
                    scene.remove(group);
                    players.delete(msg.player_id);
                }
                break;
            }
            case "chat": {
                const chatName = msg.username || playerNames.get(msg.player_id)?.username || "unknown";
                chatHud.addChatLine(`${chatName}: ${msg.text}`);
                break;
            }
        }
    }

    // --- Three.js setup ---

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    const camera = new THREE.PerspectiveCamera(
        90,
        container.clientWidth / container.clientHeight,
        0.1,
        1000
    );
    camera.rotation.order = "YXZ";

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    const sharedGeo = createSharedGeometries();

    const defaultSkin = new THREE.TextureLoader().load("default.png");
    defaultSkin.magFilter = THREE.NearestFilter;
    defaultSkin.minFilter = THREE.NearestFilter;
    defaultSkin.colorSpace = THREE.SRGBColorSpace;

    // --- Client-side prediction state ---

    const pred = {
        x: 0, y: 0, z: 0,
        vx: 0, vz: 0, vy: 0, onGround: true, jumpBuffer: 0,
        sx: 0, sy: 0, sz: 0, svy: 0,
    };

    let crouchOffset = 0;
    let currentMapData = null;
    let localPlayerId = 0;

    // --- Combat state ---
    let fire = false;
    let weaponSlot = 0;
    let localHealth = 100;
    let localAmmo = 0;
    let localDead = false;
    let localReloading = false;
    let localShooting = false;
    let isCompete = false;

    // --- First-person weapon model ---
    const gunGroup = new THREE.Group();
    gunGroup.position.set(0.25, -0.2, -0.4);
    gunGroup.visible = false;

    const slideMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x333333 });
    const slideGeo = new THREE.BoxGeometry(0.04, 0.03, 0.18);
    const slideMesh = new THREE.Mesh(slideGeo, slideMat);
    slideMesh.position.set(0, 0.015, 0);
    gunGroup.add(slideMesh);
    const frameGeo = new THREE.BoxGeometry(0.035, 0.025, 0.14);
    const frameMesh = new THREE.Mesh(frameGeo, frameMat);
    frameMesh.position.set(0, -0.01, 0.02);
    gunGroup.add(frameMesh);
    const gripGeo = new THREE.BoxGeometry(0.03, 0.08, 0.035);
    const gripMesh = new THREE.Mesh(gripGeo, frameMat);
    gripMesh.position.set(0, -0.05, 0.06);
    gripMesh.rotation.x = 0.15;
    gunGroup.add(gripMesh);
    camera.add(gunGroup);
    scene.add(camera);

    let recoilTimer = 0;
    let reloadAnimTimer = 0;

    const flashMat = new THREE.SpriteMaterial({ color: 0xffcc00, transparent: true, opacity: 0.9, depthTest: false });
    const muzzleFlash = new THREE.Sprite(flashMat);
    muzzleFlash.scale.set(0.06, 0.06, 0.06);
    muzzleFlash.position.set(0, 0.015, -0.09);
    muzzleFlash.visible = false;
    gunGroup.add(muzzleFlash);

    // Laser sight
    const laserCanvas = document.createElement("canvas");
    laserCanvas.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:500;";
    container.appendChild(laserCanvas);
    const laserCtx = laserCanvas.getContext("2d");
    function resizeLaserCanvas() {
        laserCanvas.width = window.innerWidth;
        laserCanvas.height = window.innerHeight;
        laserCanvas.style.width = window.innerWidth + "px";
        laserCanvas.style.height = window.innerHeight + "px";
    }
    resizeLaserCanvas();

    const laserDotCanvas = document.createElement("canvas");
    laserDotCanvas.width = 64;
    laserDotCanvas.height = 64;
    const laserDotCtx = laserDotCanvas.getContext("2d");
    const grad = laserDotCtx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.07, "rgba(220,255,220,1)");
    grad.addColorStop(0.15, "rgba(0,255,50,0.9)");
    grad.addColorStop(0.35, "rgba(0,220,0,0.4)");
    grad.addColorStop(0.6, "rgba(0,150,0,0.1)");
    grad.addColorStop(1, "rgba(0,60,0,0)");
    laserDotCtx.fillStyle = grad;
    laserDotCtx.fillRect(0, 0, 64, 64);
    const laserDotTex = new THREE.CanvasTexture(laserDotCanvas);
    const laserDotMat = new THREE.SpriteMaterial({
        map: laserDotTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const laserDot = new THREE.Sprite(laserDotMat);
    laserDot.visible = false;
    laserDot.frustumCulled = false;
    laserDot.renderOrder = 1000;
    scene.add(laserDot);

    let laserActive = false;

    // --- Init weapon wheel ---
    wheelHud.build(weaponSlot);

    // --- Pointer lock ---

    let yaw = 0;
    let pitch = 0;
    renderer.domElement.addEventListener("mousedown", (e) => {
        if (chatFocused) return;
        if (e.button === 0) {
            if (document.pointerLockElement !== renderer.domElement) {
                const p = renderer.domElement.requestPointerLock({ unadjustedMovement: true });
                if (p && p.catch) p.catch(() => {
                    const q = renderer.domElement.requestPointerLock();
                    if (q && q.catch) q.catch(() => {});
                });
                return;
            }
            fire = true;
            pushState();
        } else if (e.button === 2 && document.pointerLockElement === renderer.domElement) {
            laserActive = true;
        }
    });
    renderer.domElement.addEventListener("mouseup", (e) => {
        if (e.button === 0) {
            fire = false;
            pushState();
        } else if (e.button === 2) {
            laserActive = false;
        }
    });
    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    let pendingMouseDx = 0;
    let pendingMouseDy = 0;

    const onMouseMove = (e) => {
        if (document.pointerLockElement !== renderer.domElement) return;
        pendingMouseDx += e.movementX;
        pendingMouseDy += e.movementY;
    };

    // --- Input ---

    const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };

    let currentServerDomain = null;
    let serverCleanup = null;
    let connectionState = 'disconnected';

    function pushState() {
        // Build key bits for Tauri command
        let bits = 0;
        if (keys.w) bits |= 1;
        if (keys.a) bits |= 2;
        if (keys.s) bits |= 4;
        if (keys.d) bits |= 8;
        if (keys.space) bits |= 16;
        if (keys.shift) bits |= 32;
        setInput(bits, yaw, pitch, fire, weaponSlot).catch(() => {});
    }

    // --- /transfer command handler ---
    async function transferToServer(domain) {
        if (connectionState === 'transferring' || connectionState === 'connecting') {
            chatHud.addChatLine("Transfer already in progress...");
            return;
        }
        if (domain === currentServerDomain) {
            chatHud.addChatLine(`Already on ${domain}`);
            return;
        }

        connectionState = 'transferring';
        const previousDomain = currentServerDomain;
        chatHud.addChatLine(`Transferring to ${domain}...`);

        if (serverCleanup) {
            serverCleanup();
            serverCleanup = null;
        }

        for (const [, group] of players) {
            disposeCharacter(group);
            scene.remove(group);
        }
        players.clear();

        try {
            await connectToServer(domain);
            chatHud.addChatLine(`Connected to ${domain}`);
        } catch (err) {
            chatHud.addChatLine(`Transfer failed: ${err.message || err}`);
            if (previousDomain) {
                try {
                    await connectToServer(previousDomain);
                    chatHud.addChatLine(`Reconnected to ${previousDomain}`);
                } catch {
                    connectionState = 'disconnected';
                    chatHud.addChatLine("Reconnect failed. Please restart.");
                }
            } else {
                connectionState = 'disconnected';
            }
        }
    }

    const onKeyDown = (e) => {
        if (e.code === "Enter") {
            e.preventDefault();
            if (chatFocused) {
                const text = chatHud.input.value.trim();
                if (text) {
                    if (text.startsWith("/transfer ")) {
                        const domain = text.substring(10).trim();
                        if (domain) transferToServer(domain);
                    } else {
                        sendChat(text).catch(() => {});
                    }
                }
                chatHud.input.value = "";
                chatHud.input.style.display = "none";
                chatFocused = false;
            } else {
                chatHud.input.style.display = "block";
                chatHud.input.focus();
                chatFocused = true;
            }
            return;
        }
        if (e.code === "Escape" && chatFocused) {
            chatHud.input.value = "";
            chatHud.input.style.display = "none";
            chatFocused = false;
            return;
        }
        if (chatFocused) return;
        if (updateKey(keys, e.code, true)) { e.preventDefault(); pushState(); }
    };
    const onKeyUp = (e) => {
        if (chatFocused) return;
        if (updateKey(keys, e.code, false)) { e.preventDefault(); pushState(); }
    };

    const onWheel = (e) => {
        if (document.pointerLockElement !== renderer.domElement || chatFocused) return;
        e.preventDefault();
        if (e.deltaY > 0) {
            weaponSlot = weaponSlot === 0 ? 1 : 0;
        } else {
            weaponSlot = weaponSlot === 1 ? 0 : 1;
        }
        wheelHud.build(weaponSlot);
        wheelHud.show();
        pushState();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    // --- Resize ---

    const onResize = () => {
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
        resizeLaserCanvas();
    };
    window.addEventListener("resize", onResize);

    // --- Render loop ---

    let physicsOrigin = performance.now();
    let physicsTick = 0;
    let lastFrame = performance.now();
    let prevYaw = yaw;

    const interpFrom = { x: 0, y: 0, z: 0 };
    const interpTo = { x: 0, y: 0, z: 0 };

    let lobbyHud = null;

    let running = true;
    let onSessionEnd = null;

    (function animate() {
        if (!running) return;
        requestAnimationFrame(animate);
        const now = performance.now();
        const frameDt = Math.min((now - lastFrame) / 1000, 0.05);
        lastFrame = now;

        if (!currentMapData) {
            renderer.render(scene, camera);
            return;
        }

        const elapsedSec = (now - physicsOrigin) / 1000;
        const targetTick = Math.floor(elapsedSec * 60);
        let ticksToRun = targetTick - physicsTick;
        if (ticksToRun > 4) ticksToRun = 4;
        if (ticksToRun < 0) ticksToRun = 0;

        const MOUSE_CAP = 250;
        pendingMouseDx = Math.max(-MOUSE_CAP, Math.min(MOUSE_CAP, pendingMouseDx));
        pendingMouseDy = Math.max(-MOUSE_CAP, Math.min(MOUSE_CAP, pendingMouseDy));
        if (pendingMouseDx !== 0 || pendingMouseDy !== 0) {
            yaw -= pendingMouseDx * MOUSE_SENSITIVITY;
            pitch -= pendingMouseDy * MOUSE_SENSITIVITY;
            pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
            pushState();
        }
        pendingMouseDx = 0;
        pendingMouseDy = 0;

        const deltaYaw = yaw - prevYaw;
        if (Math.abs(deltaYaw) > 1e-6 && ticksToRun > 0) {
            const c = Math.cos(deltaYaw);
            const s = Math.sin(deltaYaw);
            const nvx = pred.vx * c - pred.vz * s;
            const nvz = pred.vx * s + pred.vz * c;
            pred.vx = nvx;
            pred.vz = nvz;
        }
        prevYaw = yaw;

        if (keys.space && ticksToRun > 0) {
            if (pred.onGround) {
                pred.vy = JUMP_VELOCITY;
                pred.onGround = false;
                pred.jumpBuffer = 0;
            } else {
                pred.jumpBuffer = now;
            }
        }

        let fwd = 0, strafe = 0;
        if (keys.w) fwd += 1;
        if (keys.s) fwd -= 1;
        if (keys.d) strafe += 1;
        if (keys.a) strafe -= 1;
        const len = Math.sqrt(fwd * fwd + strafe * strafe);
        const hasInput = len > 0;
        let wishDx = 0, wishDz = 0;
        if (hasInput) {
            const nfwd = fwd / len;
            const nstrafe = strafe / len;
            wishDx = -nfwd * Math.sin(yaw) + nstrafe * Math.cos(yaw);
            wishDz = -nfwd * Math.cos(yaw) - nstrafe * Math.sin(yaw);
        }

        if (ticksToRun > 0) {
            interpFrom.x = interpTo.x;
            interpFrom.y = interpTo.y;
            interpFrom.z = interpTo.z;
        }

        for (let t = 0; t < ticksToRun; t++) {
            if (hasInput) {
                pred.vx = pred.vx * GROUND_SLIP + wishDx * MOVE_SPEED * (1 - GROUND_SLIP);
                pred.vz = pred.vz * GROUND_SLIP + wishDz * MOVE_SPEED * (1 - GROUND_SLIP);
            }

            const newX = pred.x + pred.vx * TICK_DT;
            if (!collides(currentMapData, newX, pred.y, pred.z)) {
                pred.x = newX;
            } else {
                pred.vx = 0;
            }
            const newZ = pred.z + pred.vz * TICK_DT;
            if (!collides(currentMapData, pred.x, pred.y, newZ)) {
                pred.z = newZ;
            } else {
                pred.vz = 0;
            }

            if (!hasInput) {
                const slip = pred.onGround ? GROUND_SLIP : AIR_SLIP;
                pred.vx *= slip;
                pred.vz *= slip;
            }

            pred.vy -= GRAVITY * TICK_DT;
            const newY = pred.y + pred.vy * TICK_DT;
            if (!collides(currentMapData, pred.x, newY, pred.z)) {
                pred.y = newY;
                pred.onGround = false;
            } else {
                if (pred.vy < 0) pred.onGround = true;
                pred.vy = 0;
                if (pred.onGround && pred.jumpBuffer > 0 && now - pred.jumpBuffer < JUMP_BUFFER_MS) {
                    pred.vy = JUMP_VELOCITY;
                    pred.onGround = false;
                    pred.jumpBuffer = 0;
                }
            }
        }

        physicsTick = targetTick;

        const errX = pred.sx - pred.x;
        const errZ = pred.sz - pred.z;
        const errY = pred.sy - pred.y;
        const horizErr = Math.sqrt(errX * errX + errZ * errZ);
        const corrRate = 1 - Math.pow(0.5, frameDt / 0.25);

        if (horizErr > 0.8) {
            pred.x = pred.sx;
            pred.z = pred.sz;
        } else if (horizErr > 0.1) {
            pred.x += errX * corrRate;
            pred.z += errZ * corrRate;
        }

        if (Math.abs(errY) > 2.0) {
            pred.y = pred.sy;
            pred.vy = pred.svy;
            pred.onGround = pred.svy === 0 && errY < 0;
        } else if (Math.abs(errY) > 0.25) {
            pred.y += errY * corrRate;
            pred.vy += (pred.svy - pred.vy) * corrRate;
        }

        if (ticksToRun > 0) {
            interpTo.x = pred.x;
            interpTo.y = pred.y;
            interpTo.z = pred.z;
        }

        const smooth = 1 - Math.pow(0.5, frameDt / 0.03);
        for (const [, group] of players) {
            const d = group.userData;
            if (d.tx === undefined) continue;
            group.position.x += (d.tx - group.position.x) * smooth;
            group.position.y += (d.ty - group.position.y) * smooth;
            group.position.z += (d.tz - group.position.z) * smooth;

            let dr = d.tr - group.rotation.y;
            if (dr > Math.PI) dr -= 2 * Math.PI;
            if (dr < -Math.PI) dr += 2 * Math.PI;
            group.rotation.y += dr * smooth;

            d.animSpeed += (d.targetSpeed - d.animSpeed) * smooth;
            updateCharacterAnimation(group, frameDt);

            const nameSprite = group.getObjectByName("nameSprite");
            if (nameSprite) {
                nameSprite.lookAt(camera.position);
            }
        }

        if (lobbyHud) lobbyHud.rotation.y += 0.15 * frameDt;

        const alpha = (elapsedSec * 60) - targetTick;
        const renderX = interpFrom.x + (interpTo.x - interpFrom.x) * alpha;
        const renderY = interpFrom.y + (interpTo.y - interpFrom.y) * alpha;
        const renderZ = interpFrom.z + (interpTo.z - interpFrom.z) * alpha;

        const crouchTarget = keys.shift ? -0.3 : 0;
        const crouchSmooth = 1 - Math.pow(0.5, frameDt / 0.05);
        crouchOffset += (crouchTarget - crouchOffset) * crouchSmooth;

        camera.position.set(renderX, renderY + EYE_HEIGHT + crouchOffset, renderZ);
        camera.rotation.y = yaw;
        camera.rotation.x = pitch;

        // --- First-person weapon update ---
        gunGroup.visible = weaponSlot === 1;

        if (recoilTimer > 0) {
            recoilTimer -= frameDt;
            const t = Math.max(0, recoilTimer) / 0.1;
            gunGroup.rotation.x = -0.15 * t;
            gunGroup.position.y = -0.2 + 0.02 * t;
        } else {
            gunGroup.rotation.x = 0;
            gunGroup.position.y = -0.2;
        }

        if (reloadAnimTimer > 0) {
            reloadAnimTimer -= frameDt;
            const t = Math.max(0, reloadAnimTimer) / 2.0;
            gunGroup.position.y = -0.2 - 0.1 * t;
            slideMesh.position.z = 0.04 * t;
        }

        muzzleFlash.visible = localShooting;

        // --- Laser sight ---
        laserCtx.clearRect(0, 0, laserCanvas.width, laserCanvas.height);
        if (laserActive && weaponSlot === 1 && !localDead && currentMapData) {
            const camDir = new THREE.Vector3(0, 0, -1);
            camDir.applyQuaternion(camera.quaternion);
            const ox = camera.position.x, oy = camera.position.y, oz = camera.position.z;
            const ldx = camDir.x, ldy = camDir.y, ldz = camDir.z;

            let hitT = raycastBlocks(currentMapData, ox, oy, oz, ldx, ldy, ldz, MAX_RANGE);

            for (const [pid, group] of players) {
                const d = group.userData;
                if (d.tx === undefined) continue;
                const t = rayHitPlayerAABB(ox, oy, oz, ldx, ldy, ldz, d.tx, d.ty, d.tz);
                if (t !== null && t < hitT) hitT = t;
            }

            const hx = ox + ldx * hitT;
            const hy = oy + ldy * hitT;
            const hz = oz + ldz * hitT;

            const muzzleWorld = new THREE.Vector3();
            muzzleFlash.getWorldPosition(muzzleWorld);
            muzzleWorld.project(camera);
            const gx = (muzzleWorld.x + 1) / 2 * laserCanvas.width;
            const gy = (-muzzleWorld.y + 1) / 2 * laserCanvas.height;

            const hitVec = new THREE.Vector3(hx, hy, hz);
            hitVec.project(camera);
            const sx = (hitVec.x + 1) / 2 * laserCanvas.width;
            const sy = (-hitVec.y + 1) / 2 * laserCanvas.height;

            const beamGrad = laserCtx.createLinearGradient(gx, gy, sx, sy);
            beamGrad.addColorStop(0, "rgba(0,255,80,0.9)");
            beamGrad.addColorStop(1, "rgba(0,220,0,0.25)");
            laserCtx.save();
            laserCtx.shadowColor = "#00ff44";
            laserCtx.shadowBlur = 12;
            laserCtx.lineWidth = 2.5;
            laserCtx.strokeStyle = beamGrad;
            laserCtx.beginPath();
            laserCtx.moveTo(gx, gy);
            laserCtx.lineTo(sx, sy);
            laserCtx.stroke();
            laserCtx.restore();

            const nudge = 0.03;
            const dotScale = 0.1 + 0.015 * hitT;
            laserDot.scale.set(dotScale, dotScale, 1);
            laserDot.position.set(hx - ldx * nudge, hy - ldy * nudge, hz - ldz * nudge);
            laserDot.visible = true;
        } else {
            laserDot.visible = false;
        }

        // --- HUD updates ---
        if (isCompete) {
            healthHud.show();
            healthHud.update(localHealth);

            if (weaponSlot === 1) {
                ammoHud.show();
                ammoHud.update(localAmmo, MAGAZINE_SIZE, localReloading);
            } else {
                ammoHud.hide();
            }

            if (localDead) {
                deathHud.show();
            } else {
                deathHud.hide();
            }
        } else {
            healthHud.hide();
            ammoHud.hide();
            deathHud.hide();
        }

        renderer.render(scene, camera);
    })();

    // --- Per-server connection logic ---

    async function connectToServer(domain) {
        connectionState = 'connecting';
        loadingHud.show();

        pendingMouseDx = 0;
        pendingMouseDy = 0;

        const cleanupActions = [];

        try {
            // 1. Connect via Tauri command (Rust handles WT)
            const result = await connect(token, domain, STREAM_HOST, STREAM_PORT);
            cleanupActions.push(() => disconnect().catch(() => {}));

            localPlayerId = result.player_id;
            const mapData = result.map_json;
            currentMapData = mapData;
            currentServerDomain = domain;
            gameReady = true;
            isCompete = domain.includes("compete");

            // 2. Build map geometry
            const mapMeshes = buildMap(scene, mapData);
            cleanupActions.push(() => {
                for (const mesh of mapMeshes) {
                    scene.remove(mesh);
                    mesh.geometry.dispose();
                    if (mesh.material.map) mesh.material.map.dispose();
                    mesh.material.dispose();
                }
            });

            // 3. Build lobby HUD
            let hud = null;
            if (domain.includes("lobby")) {
                hud = buildLobbyHud(scene, { x: mapData.size.x / 2, z: mapData.size.z / 2 });
                lobbyHud = hud;
                cleanupActions.push(() => {
                    scene.remove(hud);
                    hud.traverse((child) => {
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            if (child.material.map) child.material.map.dispose();
                            child.material.dispose();
                        }
                    });
                    if (lobbyHud === hud) lobbyHud = null;
                });
            } else {
                lobbyHud = null;
            }

            // 4. Reset prediction to spawn
            const spawn = mapData.spawn_points[0];
            pred.x = spawn.x; pred.y = spawn.y; pred.z = spawn.z;
            pred.vx = 0; pred.vz = 0; pred.vy = 0;
            pred.onGround = true; pred.jumpBuffer = 0;
            pred.sx = spawn.x; pred.sy = spawn.y; pred.sz = spawn.z; pred.svy = 0;
            interpFrom.x = spawn.x; interpFrom.y = spawn.y; interpFrom.z = spawn.z;
            interpTo.x = spawn.x; interpTo.y = spawn.y; interpTo.z = spawn.z;

            localHealth = 100;
            localAmmo = isCompete ? MAGAZINE_SIZE : 0;
            localDead = false;
            localReloading = false;
            localShooting = false;
            fire = false;
            recoilTimer = 0;
            reloadAnimTimer = 0;

            physicsOrigin = performance.now();
            physicsTick = 0;

            camera.position.set(spawn.x, spawn.y + EYE_HEIGHT, spawn.z);

            // 5. Listen for world state updates from Rust
            const unlistenWS = await onWorldState((state) => {
                const snapshots = state.players;
                const cs = { health: localHealth, ammo: localAmmo, dead: localDead, reloading: localReloading, shooting: localShooting };
                updatePlayers(scene, players, snapshots, localPlayerId, pred, playerNames, sharedGeo, defaultSkin, cs);
                localHealth = cs.health;
                localAmmo = cs.ammo;
                localReloading = cs.reloading;

                if (cs.shooting && !localShooting) {
                    recoilTimer = 0.1;
                }
                localShooting = cs.shooting;

                if (cs.reloading && reloadAnimTimer <= 0) {
                    reloadAnimTimer = 2.0;
                }

                if (cs.dead && !localDead) {
                    localDead = true;
                } else if (!cs.dead && localDead) {
                    localDead = false;
                    pred.x = pred.sx;
                    pred.y = pred.sy;
                    pred.z = pred.sz;
                    pred.vx = 0; pred.vz = 0; pred.vy = 0;
                    interpFrom.x = pred.sx; interpFrom.y = pred.sy; interpFrom.z = pred.sz;
                    interpTo.x = pred.sx; interpTo.y = pred.sy; interpTo.z = pred.sz;
                }
            });
            cleanupActions.push(() => unlistenWS());

            // 6. Listen for server events (roster, join, leave, chat)
            const unlistenEvent = await onServerEvent(handleEventMessage);
            cleanupActions.push(() => unlistenEvent());

            // 7. Listen for transport close
            const unlistenClose = await onTransportClosed(() => {
                if (currentServerDomain === domain && connectionState === 'connected') {
                    if (serverCleanup) {
                        serverCleanup();
                        serverCleanup = null;
                    }
                    connectionState = 'disconnected';
                    if (onSessionEnd) onSessionEnd();
                }
            });
            cleanupActions.push(() => {
                unlistenClose();
                currentMapData = null;
            });

            // Push initial input state
            pushState();

            // 8. Store cleanup
            serverCleanup = () => {
                for (let i = cleanupActions.length - 1; i >= 0; i--) {
                    cleanupActions[i]();
                }
            };

            loadingHud.hide();
            connectionState = 'connected';
        } catch (err) {
            for (let i = cleanupActions.length - 1; i >= 0; i--) {
                try { cleanupActions[i](); } catch {}
            }
            loadingHud.hide();
            connectionState = 'disconnected';
            throw err;
        }
    }

    // --- Initial connection ---
    await connectToServer(DEFAULT_SERVER);

    // Block until session ends
    await new Promise((resolve) => {
        if (connectionState === 'disconnected') {
            resolve();
        } else {
            onSessionEnd = resolve;
        }
    });

    running = false;
    if (serverCleanup) serverCleanup();
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    renderer.domElement.removeEventListener("wheel", onWheel);
    window.removeEventListener("resize", onResize);
    if (document.pointerLockElement === renderer.domElement) {
        document.exitPointerLock();
    }
    container.removeChild(renderer.domElement);
    chatHud.dispose();
    healthHud.dispose();
    ammoHud.dispose();
    deathHud.dispose();
    wheelHud.dispose();
    loadingHud.dispose();
    for (const [, group] of players) {
        disposeCharacter(group);
    }
    if (laserCanvas.parentNode) laserCanvas.remove();
    laserDotTex.dispose();
    laserDotMat.dispose();
    slideGeo.dispose();
    slideMat.dispose();
    frameGeo.dispose();
    frameMat.dispose();
    gripGeo.dispose();
    flashMat.dispose();
    sharedGeo.head.dispose();
    sharedGeo.torso.dispose();
    sharedGeo.arm.dispose();
    sharedGeo.upperLeg.dispose();
    sharedGeo.lowerLeg.dispose();
    renderer.dispose();
}

function updateKey(keys, code, pressed) {
    switch (code) {
        case "KeyW": keys.w = pressed; return true;
        case "KeyA": keys.a = pressed; return true;
        case "KeyS": keys.s = pressed; return true;
        case "KeyD": keys.d = pressed; return true;
        case "Space": keys.space = pressed; return true;
        case "ShiftLeft": case "ShiftRight": keys.shift = pressed; return true;
        default: return false;
    }
}

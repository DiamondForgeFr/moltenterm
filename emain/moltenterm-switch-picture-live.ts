// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The switch picture (#2375) on real views: the rules are in moltenterm-switch-picture.ts. This file takes the capture of
// a view being left (Electron's capturePage, encoded once the switch has landed), runs the scripts in the views, holds
// the leaver's keys while its overlay shows, and listens to the intent the sidebar's dots give.

import { ObjectService } from "@/app/store/services";
import type { WaveTabView } from "./emain-tabview";
import type { WaveBrowserWindow } from "./emain-window";
import { getWaveWindowByWebContentsId } from "./emain-window";
import { isFlatFrame } from "./moltenterm-carpet-thumb-store";
import { onAppIpc } from "./moltenterm-privileged-ipc";
import {
    PictureChannel,
    prunePictures,
    SwitchCoverGraceMs,
    SwitchEncodeDelayMs,
    encodeWaitMs,
    LayoutSwitchMark,
    mountedBlocksScript,
    takesLayout,
    PanelsMountMaxMs,
    quietUntilAfter,
    SwitchEncodeQueueMax,
    SwitchPicture,
    SwitchPictureLimits,
    SwitchPictureMinGapMs,
    SwitchPictureStore,
    SwitchTarget,
    SwitchView,
    swallowsKey,
    WaitingState,
    waitingCaptionKey,
    waitPanelsMounted,
    withDeadline,
    WindowSwitchPicture,
} from "./moltenterm-switch-picture";
import { mt } from "./moltenterm-i18n";
import { tabViewWorkspace } from "./moltenterm-tabview-budget";
import { windowTabViews } from "./moltenterm-tabview-host";
import { letViewThrough, restoreViewBackground, viewLooksTranslucent } from "./moltenterm-window-look";

export const SwitchIntentChannel = "moltenterm-switch-intent";

// The pending state's own channel: the shim below stands in for the view on screen while a picture does.
const PendingChannel = "moltenterm-view-pending";

// How long the view being held for the picture waits for its cover (a wedged renderer must not hold the switch).
const CoverWaitMs = 80;

// switch-layout/layout-frames.ts answers this in the page.
const OnScreenScript = "window.__mtSwitchLayoutOnScreen && window.__mtSwitchLayoutOnScreen(), 0";
const RefusedScript = "window.__mtSwitchLayoutRefused && window.__mtSwitchLayoutRefused(), 0";

const store = new SwitchPictureStore();
const windowSwitches = new WeakMap<object, WindowSwitchPicture>();
const adapters = new WeakMap<WaveTabView, LiveSwitchView>();
const heldViews = new WeakSet<WaveTabView>();
const keyHooked = new WeakSet<WaveTabView>();
const encodeQueue: PendingEncode[] = [];
const capturing = new Set<string>();
let encodeTimer: ReturnType<typeof setTimeout> = null;
let quietUntil = 0;

// MOLTENTERM_SWITCHPICTURE=0 restores the previous switch (no picture, no cover), for a build under test.
function enabled(): boolean {
    return process.env.MOLTENTERM_SWITCHPICTURE !== "0";
}

class LiveSwitchView implements SwitchView {
    constructor(readonly view: WaveTabView) {}

    get id(): string {
        return this.view.waveTabId;
    }

    isLive(): boolean {
        return !this.view.isDestroyed && !this.view.webContents.isDestroyed();
    }

    sendPicture(picture: SwitchPicture) {
        this.view.webContents.send(PictureChannel, picture.mime, picture.bytes);
    }

    run(script: string): Promise<unknown> {
        return Promise.resolve().then(() => this.view.webContents.executeJavaScript(script));
    }
}

function adapterOf(view: WaveTabView): LiveSwitchView {
    let adapter = adapters.get(view);
    if (adapter == null) {
        adapter = new LiveSwitchView(view);
        adapters.set(view, adapter);
    }
    return adapter;
}

function windowSwitch(win: WaveBrowserWindow): WindowSwitchPicture {
    let sw = windowSwitches.get(win);
    if (sw != null) {
        return sw;
    }
    sw = new WindowSwitchPicture({
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        log: (msg) => console.log(msg),
        enabled,
        store,
        translucent: (v) => viewLooksTranslucent((v as LiveSwitchView).view),
        letThrough: (v) => letViewThrough(win, (v as LiveSwitchView).view),
        restoreLook: (v) => restoreViewBackground(win, (v as LiveSwitchView).view),
        windowSize: () => {
            const b = win.getContentBounds();
            return { width: b.width, height: b.height };
        },
        captureLeaver: (v, tabId, workspaceId) => captureView((v as LiveSwitchView).view, tabId, workspaceId),
        viewOfTab: (tabId) => {
            const view = windowTabViews(win.waveWindowId).get(tabId);
            return view == null ? null : adapterOf(view);
        },
        holdKeys: (v, hold) => holdKeys((v as LiveSwitchView).view, hold),
        expectedBlocks: async (tabId) => {
            const tab = (await ObjectService.GetObject("tab:" + tabId)) as Tab;
            return tab?.blockids?.length ?? 0;
        },
    });
    windowSwitches.set(win, sw);
    return sw;
}

// The picture of a view being left, taken now and encoded once the switch has landed. A view that is not on screen, or
// whose frame is one flat colour (a view the system stopped drawing), leaves no picture: a blank one would be worse
// than none. A look that lets the desktop through (the default one) keeps its alpha, in a PNG.
function captureView(view: WaveTabView, tabId: string, workspaceId: string) {
    if (view.isDestroyed || view.webContents.isDestroyed() || !view.isOnScreen() || !view.getVisible()) {
        return;
    }
    // A view left again within moments (a quick back and forth) keeps the picture it has: the encode is the one costly step.
    const kept = store.forTab(tabId, Date.now());
    if (kept != null && Date.now() - kept.at < SwitchPictureMinGapMs) {
        return;
    }
    // The intent (a hover on a dot) has already taken it: the click that follows must not read the frame back again while
    // the target reinitializes, the readback is the one step of the leaver that slows the target down.
    if (capturing.has(tabId) || encodeQueue.some((p) => p.tabId === tabId)) {
        return;
    }
    const bounds = view.getBounds();
    const takenAt = Date.now();
    const translucent = viewLooksTranslucent(view);
    capturing.add(tabId);
    Promise.resolve()
        .then(() => view.webContents.capturePage())
        .then((image) => {
            capturing.delete(tabId);
            if (image.isEmpty()) {
                console.log("[#2375] the capture of a view was empty, no picture kept", tabId);
                return;
            }
            queueEncode({ image, tabId, workspaceId, width: bounds.width, height: bounds.height, at: takenAt, translucent });
        })
        .catch((): void => {
            capturing.delete(tabId);
        });
}

type PendingEncode = {
    image: Electron.NativeImage;
    tabId: string;
    workspaceId: string;
    width: number;
    height: number;
    at: number;
    translucent: boolean;
};

// One encode at a time, a pause between two, and at most two waiting (each holds a whole bitmap): a burst of switches
// keeps the pictures of its last views and never a main process busy for long.
function queueEncode(next: PendingEncode) {
    const rest = encodeQueue.filter((p) => p.tabId !== next.tabId);
    rest.push(next);
    while (rest.length > SwitchEncodeQueueMax) {
        rest.shift();
    }
    encodeQueue.length = 0;
    encodeQueue.push(...rest);
    scheduleEncode();
}

function noteSwitchActivity() {
    quietUntil = quietUntilAfter(Date.now(), quietUntil);
}

function scheduleEncode(delay = SwitchEncodeDelayMs) {
    if (encodeTimer != null || encodeQueue.length === 0) {
        return;
    }
    encodeTimer = setTimeout(() => {
        encodeTimer = null;
        const wait = encodeWaitMs(Date.now(), quietUntil);
        if (wait > 0) {
            scheduleEncode(wait);
            return;
        }
        const p = encodeQueue.shift();
        if (p != null) {
            encodePicture(p.image, p.tabId, p.workspaceId, p.width, p.height, p.at, p.translucent);
        }
        scheduleEncode();
    }, delay);
}

function encodePicture(
    image: Electron.NativeImage,
    tabId: string,
    workspaceId: string,
    width: number,
    height: number,
    at: number,
    translucent: boolean
) {
    try {
        const started = Date.now();
        const size = image.getSize();
        const maxWidth = translucent ? SwitchPictureLimits.maxTranslucentWidthPx : SwitchPictureLimits.maxWidthPx;
        const scaled = size.width > maxWidth ? image.resize({ width: maxWidth, quality: "good" }) : image;
        if (isFlatFrame(scaled.toBitmap(), scaled.getSize())) {
            console.log("[#2375] the capture of a view was one flat colour, no picture kept", tabId);
            return;
        }
        // A view that lets the desktop through keeps its alpha: a PNG. An opaque one is a JPEG, which is far cheaper.
        const bytes = translucent ? scaled.toPNG() : scaled.toJPEG(SwitchPictureLimits.jpegQuality);
        store.put({
            tabId,
            workspaceId,
            width,
            height,
            at,
            translucent,
            mime: translucent ? "image/png" : "image/jpeg",
            bytes,
        });
        // sizes only: a picture is never logged
        console.log(
            `[#2375] picture kept for ${tabId}: ${width}x${height}, ${translucent ? "png" : "jpeg"} ${Math.round(bytes.length / 1024)} KB, encoded in ${Date.now() - started} ms (${store.size} kept)`
        );
        pruneDeletedSwitchPictures();
    } catch (e) {
        console.log("[#2375] a view's picture could not be kept", tabId, String((e as Error)?.message ?? e));
    }
}

function holdKeys(view: WaveTabView, hold: boolean) {
    if (hold) {
        heldViews.add(view);
    } else {
        heldViews.delete(view);
    }
    if (!hold || keyHooked.has(view) || view.webContents.isDestroyed()) {
        return;
    }
    keyHooked.add(view);
    view.webContents.on("before-input-event", (event, input) => {
        if (heldViews.has(view) && (input.type === "keyDown" || input.type === "keyUp") && swallowsKey(input)) {
            event.preventDefault();
        }
    });
}

// --- what the window's actions call

// A failure in the picture never breaks a switch: the switch goes on without its picture.
function guarded<T>(what: string, fallback: T, fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        console.log(`[#2375] ${what} failed, the switch goes on without its picture`, String((e as Error)?.message ?? e));
        return fallback;
    }
}

// A sidebar switch whose view left faded into the target's remembered layout (#2407) says so just before it asks the
// switch: that switch shows no picture (takesLayout).
const layoutSwitches = new WeakMap<object, LayoutSwitchMark>();

// A sidebar switch this window did not make (the workspace is shown by another window, which only got the focus; it
// opened in a new window; the developer kept the workspace left; the switch failed): the view that asked is still on
// screen, faded into the target's layout, and gets its content back at once (#2407).
export function answerSidebarSwitch(win: WaveBrowserWindow, workspaceId: string, askingWebContentsId: number) {
    if (win == null || win.isDestroyed()) {
        return;
    }
    layoutSwitches.delete(win);
    const view = win.activeTabView;
    if (win.workspaceId === workspaceId || view == null || view.isDestroyed || view.webContents.isDestroyed()) {
        return;
    }
    if (view.webContents.id !== askingWebContentsId) {
        return;
    }
    console.log(`[#2407] switch to ${workspaceId} not made in this window: the view that asked gets its content back`);
    view.webContents.executeJavaScript(RefusedScript).catch((): void => null);
}

export function beginSwitchPicture(win: WaveBrowserWindow, target: SwitchTarget): boolean {
    noteSwitchActivity();
    const marked = layoutSwitches.get(win);
    layoutSwitches.delete(win);
    if (takesLayout(marked, target, Date.now())) {
        // A picture left over from an intent on a dot goes: the screen shows the layout.
        cancelSwitchPicture(win);
        console.log(`[#2407] switch to ${target.workspaceId} shows its remembered layout, no picture`);
        return false;
    }
    return guarded("showing the picture", false, () => {
        const leaver = win.activeTabView;
        if (leaver == null) {
            return false;
        }
        return windowSwitch(win).begin(adapterOf(leaver), leaver.waveTabId, tabViewWorkspace(leaver), target);
    });
}

export function switchPictureActive(win: WaveBrowserWindow): boolean {
    return windowSwitches.get(win)?.isActive() === true;
}

export function cancelSwitchPicture(win: WaveBrowserWindow) {
    guarded("taking the picture away", undefined, () => windowSwitches.get(win)?.cancel());
}

// A view whose page decoded its picture before the click wears it before its reinit starts: the frames it draws
// meanwhile, and the first one on screen, hold nothing but the picture. Put on after the reinit, the picture reaches the
// screen a frame or two after the view does. A few milliseconds (the page is idle, the view hidden), spent before the
// reinit is asked.
export async function wearAhead(win: WaveBrowserWindow, view: WaveTabView): Promise<boolean> {
    const sw = windowSwitches.get(win);
    const target = adapterOf(view);
    if (sw == null || !sw.isActive() || !sw.isPreparedAhead(target, view.waveTabId)) {
        return false;
    }
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CoverWaitMs);
    });
    try {
        return await Promise.race([sw.cover(target, view.waveTabId).then((ok) => ok && sw.attach(target)), timeout]);
    } catch (e) {
        console.log("[#2375] putting the picture on the target failed", String((e as Error)?.message ?? e));
        return false;
    } finally {
        clearTimeout(timer);
    }
}

// The view is about to be shown: it asks its page for the picture. Never waits long on a view that does not answer.
export async function coverArrivingView(win: WaveBrowserWindow, view: WaveTabView) {
    const sw = windowSwitches.get(win);
    if (sw == null || !sw.isActive()) {
        return;
    }
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CoverWaitMs);
    });
    try {
        await Promise.race([sw.cover(adapterOf(view), view.waveTabId), timeout]);
    } catch (e) {
        console.log("[#2375] putting the picture on the target failed", String((e as Error)?.message ?? e));
    } finally {
        clearTimeout(timer);
    }
}

// The target's reinit is done: a picture still decoding is waited for a few milliseconds at most, then given up, so the
// target is never shown later because of its picture, and no cover goes on a view the user is already using. A picture
// ready goes on now, unless the view already wears it.
export async function coverGrace(win: WaveBrowserWindow, view: WaveTabView, wearing: Promise<void>) {
    const sw = windowSwitches.get(win);
    if (sw == null || !sw.isActive()) {
        return;
    }
    let timer: ReturnType<typeof setTimeout> = null;
    const grace = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SwitchCoverGraceMs);
    });
    try {
        const done = await Promise.race([wearing.then(() => true), grace]);
        if (!done) {
            console.log("[#2375] the picture was not ready on the target in time, the target is shown without it");
            guarded("giving the cover up", undefined, () => sw.giveUpCover(adapterOf(view)));
            return;
        }
        await sw.attach(adapterOf(view));
    } finally {
        clearTimeout(timer);
    }
}

// A new view that wears no picture (none was kept, or the window was resized since: a stretched picture is never
// shown) comes on screen once its panels are mounted, so it never appears half-drawn: the view being left stays until
// then, a few hundred milliseconds at most (#2390). A view wearing its picture is shown at once, the picture covers
// the panels still mounting.
export async function awaitArrivingPanels(win: WaveBrowserWindow, view: WaveTabView, maxMs: number): Promise<void> {
    if (!enabled() || maxMs <= 0 || windowSwitches.get(win)?.wears(adapterOf(view)) === true) {
        return;
    }
    const started = Date.now();
    const limit = Math.min(PanelsMountMaxMs, maxMs);
    const timers = {
        set: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    // One deadline for the whole wait, the backend's answer and every probe included: a renderer or a backend that
    // locks up never holds the switch, the view is shown anyway.
    const mounted = await withDeadline(
        (async () => {
            const expected = await guardedAsync(async () => {
                const tab = (await ObjectService.GetObject("tab:" + view.waveTabId)) as Tab;
                return tab?.blockids?.length ?? 0;
            }, 0);
            return waitPanelsMounted(
                () =>
                    view.isDestroyed || view.webContents.isDestroyed()
                        ? Promise.resolve(-1)
                        : (view.webContents.executeJavaScript(mountedBlocksScript()) as Promise<number>),
                expected,
                () => Date.now(),
                (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
                limit - (Date.now() - started)
            );
        })(),
        limit,
        false,
        timers.set,
        timers.clear
    );
    console.log(
        `[#2390] new view without a picture shown ${mounted ? "with its panels mounted" : "before all its panels mounted"}, ${Date.now() - started} ms after its first render`
    );
}

async function guardedAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

// The view is on screen: its picture dissolves once its panels have painted, and the remembered layout it wears, if
// any (#2407), lets each panel's frame go as that panel is ready. A view parked off screen is "visible" to its own page,
// which therefore cannot tell this moment by itself.
export function finishArrivingView(win: WaveBrowserWindow, view: WaveTabView) {
    if (!view.isDestroyed && !view.webContents.isDestroyed()) {
        view.webContents.executeJavaScript(OnScreenScript).catch((): void => null);
    }
    const sw = windowSwitches.get(win);
    if (sw == null) {
        return;
    }
    guarded("dissolving the picture", undefined, () => sw.arrived(adapterOf(view), view.waveTabId).catch((): void => null));
}

export function dropSwitchPictureOfTab(tabId: string) {
    store.dropTab(tabId);
}

export function dropSwitchPicturesOfWorkspace(workspaceId: string) {
    store.dropWorkspace(workspaceId);
}

// A tab can be closed by the window, the backend, an agent or `wsh`: the pictures' tabs are asked of the backend each
// time a picture is kept and each time the views of deleted tabs are swept (#448), and the ones it lost go.
export function pruneDeletedSwitchPictures() {
    prunePictures(store, async (tabIds) => {
        const tabs = await ObjectService.GetObjects(tabIds.map((id) => "tab:" + id));
        return new Set((tabs ?? []).filter((tab) => tab != null).map((tab) => tab.oid));
    }).catch((): void => null);
}

// The pending state over a picture: the waiting indicator goes on the picture, never on the view hidden under it. A
// failure leaves the picture and shows on the view, where its Reload lives.
export type PendingShim = {
    isDestroyed: boolean;
    webContents: { send(channel: string, ...args: any[]): void; isDestroyed(): boolean };
};

export function switchWaitingView(win: WaveBrowserWindow): PendingShim {
    const sw = windowSwitches.get(win);
    if (sw == null || !sw.isActive()) {
        return null;
    }
    return {
        isDestroyed: false,
        webContents: {
            isDestroyed: () => false,
            send: (channel: string, state: { phase: string; workspaceName: string } | null) => {
                if (channel !== PendingChannel) {
                    return;
                }
                if (state == null) {
                    sw.showWaiting(null);
                    return;
                }
                if (state.phase === "failed" || state.phase === "stopped") {
                    sw.cancel();
                    win.activeTabView?.webContents.send(PendingChannel, state);
                    return;
                }
                const waiting: WaitingState = {
                    phase: state.phase,
                    name: state.workspaceName ?? "",
                    caption: mt(waitingCaptionKey(state.phase)),
                };
                sw.showWaiting(waiting);
            },
        },
    };
}

// --- intent

function parseTarget(value: unknown): SwitchTarget {
    if (value == null || typeof value !== "object") {
        return null;
    }
    const v = value as Record<string, unknown>;
    const target: SwitchTarget = {};
    if (typeof v.workspaceId === "string" && v.workspaceId !== "") {
        target.workspaceId = v.workspaceId;
    }
    if (typeof v.tabId === "string" && v.tabId !== "") {
        target.tabId = v.tabId;
    }
    return target.workspaceId != null || target.tabId != null ? target : null;
}

let initialized = false;

// The sidebar's dots (a dwell, a focus, a press) prepare the picture before the click. The workspace shortcut prepares
// nothing ahead: its modifier alone is typing (⌥ types { } [ ] | ~ on a French keyboard, terminals take Alt as Meta), and
// its target is known only once its digit is handled, which is the action itself.
export function initSwitchPicture() {
    if (initialized) {
        return;
    }
    initialized = true;
    onAppIpc(SwitchIntentChannel, (event, value: unknown) => {
        const win = getWaveWindowByWebContentsId(event.sender.id);
        const target = parseTarget(value);
        const view = win?.activeTabView;
        if (win == null || target == null || view == null || view.webContents.id !== event.sender.id) {
            return;
        }
        if ((value as Record<string, unknown>).layout === true && target.workspaceId != null) {
            layoutSwitches.set(win, { workspaceId: target.workspaceId, at: Date.now() });
            return;
        }
        noteSwitchActivity();
        windowSwitch(win).arm(adapterOf(view), target, tabViewWorkspace(view));
    });
}


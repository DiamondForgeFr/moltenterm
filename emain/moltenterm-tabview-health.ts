// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A cached tab view shown again after a long time off-screen can stay black (#223, #199): its renderer is alive and
// answers wave-init, but no frame of it is displayed. Chromium evicts the saved frame of a view it believes unseen
// (FrameEvictionManager culls after about five minutes), and moving the view back on screen does not always make
// Chromium ask the renderer for a new one (electron/electron#42378). A real visibility cycle (WasHidden, then
// WasShown) does: the renderer draws a full frame and the eviction bookkeeping is reset. So a view that sat off-screen
// for a while gets that cycle as it is shown, and every reused view is then probed; one that still does not render is
// cycled again, then rebuilt.

// Below Chromium's five-minute culling, so every view that may have lost its frame gets the cycle.
export const MoltentermLongHiddenMs = 60 * 1000;
// The first frames of a reused view arrive within a frame or two of wave-ready; this leaves room for a busy machine.
export const MoltentermPaintSettleMs = 150;
// A probe that does not answer (wedged renderer) counts as a view that does not render.
export const MoltentermProbeTimeoutMs = 1500;

// What the renderer reports once shown: whether it believes it is visible, and how many animation frames ran.
export type ShownViewProbe = {
    visible: boolean;
    frames: number;
};

export type TabViewPaintTarget = {
    isLive(): boolean;
    hiddenForMs(): number;
    probe(): Promise<ShownViewProbe>;
    cycleVisibility(): void;
    rebuild(): Promise<void>;
    log(msg: string): void;
};

export type PaintCheckResult = "rendering" | "refreshed" | "repainted" | "rebuilt" | "skipped";

// Runs in the renderer: animation frames only run for a page the compositor considers shown.
export const ShownViewProbeScript = `new Promise((resolve) => {
    let frames = 0;
    const done = () => resolve({ visible: document.visibilityState === "visible", frames });
    const tick = () => {
        frames++;
        if (frames >= 2) {
            done();
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(done, 500);
})`;

export function isRendering(probe: ShownViewProbe): boolean {
    return probe != null && probe.visible && probe.frames > 0;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeWithTimeout(
    target: TabViewPaintTarget,
    timeoutMs = MoltentermProbeTimeoutMs
): Promise<ShownViewProbe> {
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<ShownViewProbe>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
        return await Promise.race([target.probe().catch((): ShownViewProbe => null), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export async function ensureTabViewPainted(
    target: TabViewPaintTarget,
    settleMs = MoltentermPaintSettleMs,
    timeoutMs = MoltentermProbeTimeoutMs
): Promise<PaintCheckResult> {
    if (!target.isLive()) {
        return "skipped";
    }
    const refreshed = target.hiddenForMs() >= MoltentermLongHiddenMs;
    if (refreshed) {
        target.cycleVisibility();
    }
    await delay(settleMs);
    if (!target.isLive()) {
        return "skipped";
    }
    if (isRendering(await probeWithTimeout(target, timeoutMs))) {
        return refreshed ? "refreshed" : "rendering";
    }
    if (!target.isLive()) {
        return "skipped";
    }
    target.log("shown tab view does not render, cycling its visibility");
    target.cycleVisibility();
    await delay(settleMs);
    if (!target.isLive()) {
        return "skipped";
    }
    if (isRendering(await probeWithTimeout(target, timeoutMs))) {
        return "repainted";
    }
    if (!target.isLive()) {
        return "skipped";
    }
    target.log("shown tab view still does not render, rebuilding it");
    await target.rebuild();
    return "rebuilt";
}

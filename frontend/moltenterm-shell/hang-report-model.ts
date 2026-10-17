// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pure side of the renderer's hang report (#849): which long tasks are logged, how one reads in waveapp.log, and
// the diagnostics text the "did not respond" notification copies. hang-report.ts wires it to the page.

// A task this long froze the window for the user; shorter ones are a performance matter, not a hang.
export const LongTaskLogMs = 2000;
// At most one long-task line per this period, so a page stuck in a loop of long tasks does not flood the log.
export const LongTaskLogEveryMs = 10000;
export const LongTasksKept = 20;

export class LongTaskLimiter {
    lastLogged = -Infinity;
    skipped = 0;

    // The number of long tasks left out since the last line, or null when this one is left out too.
    admit(now: number): number {
        if (now - this.lastLogged < LongTaskLogEveryMs) {
            this.skipped++;
            return null;
        }
        const skipped = this.skipped;
        this.lastLogged = now;
        this.skipped = 0;
        return skipped;
    }
}

// The fields of a long-animation-frame script entry (Chromium) the line names.
export type LongTaskScript = {
    duration?: number;
    invoker?: string;
    invokerType?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
};

export type LongTaskFacts = {
    kind: string;
    durationMs: number;
    scripts: LongTaskScript[];
    lastRpc: string;
    lastService: string;
    panel: string;
    skipped: number;
};

function fileOf(url: string): string {
    if (!url) {
        return "";
    }
    const clean = url.split("?")[0];
    return clean.slice(clean.lastIndexOf("/") + 1);
}

export function topScript(scripts: LongTaskScript[]): string {
    const top = [...(scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
    if (top == null) {
        return "";
    }
    const where = [top.sourceFunctionName, fileOf(top.sourceURL)].filter((s) => s).join(" in ");
    const who = top.invoker || top.invokerType || "script";
    return `${who}${where ? ` (${where})` : ""} ${Math.round(top.duration ?? 0)} ms`;
}

export function longTaskLine(facts: LongTaskFacts): string {
    const parts = [`hang: long ${facts.kind} ${Math.round(facts.durationMs)} ms`];
    const script = topScript(facts.scripts);
    if (script) {
        parts.push(`script: ${script}`);
    }
    parts.push(`last rpc: ${facts.lastRpc}`, `last service call: ${facts.lastService}`, `panel: ${facts.panel}`);
    if (facts.skipped > 0) {
        parts.push(`${facts.skipped} more long tasks not logged`);
    }
    return parts.join("; ");
}

export type MainHangDiagnostics = { version: string; buildtime: number; uptimesec: number; events: string[] };

export type DiagnosticsInput = {
    hangMs: number;
    hangAt: number;
    main: MainHangDiagnostics;
    rendererEvents: string[];
    userAgent: string;
};

// Plain text, English: it goes into bug reports, as the log does.
export function diagnosticsText(input: DiagnosticsInput): string {
    const lines = [
        "MoltenTerm hang diagnostics",
        `window unresponsive: ${Math.round(input.hangMs)} ms from ${new Date(input.hangAt).toISOString()}`,
        `version: ${input.main?.version ?? "unknown"} (build ${input.main?.buildtime ?? "unknown"})`,
        `Electron main uptime: ${input.main?.uptimesec ?? "unknown"} s`,
        `user agent: ${input.userAgent}`,
        "",
        "Electron main events:",
        ...(input.main?.events?.length ? input.main.events : ["(none)"]),
        "",
        "Renderer long tasks:",
        ...(input.rendererEvents.length ? input.rendererEvents : ["(none)"]),
    ];
    return lines.join("\n");
}

export function hangSeconds(ms: number): number {
    return Math.max(1, Math.round(ms / 1000));
}

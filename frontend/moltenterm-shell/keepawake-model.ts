// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's keep-awake as the windows see it (FR-SHELL-023, DS-SHELL-062; indicator parts of FR-SHELL-022,
// DS-SHELL-063): the sleep policy, the coffees of the rail, the blocks the shims reported. wavesrv decides
// (pkg/molten/keepawake); this file holds the rules the views need, apart from the components so they can be tested.

export const KeepAwakeRoute = "molten:keepawake";
export const KeepAwakeEvent = "molten:keepawake";
export const KeepAwakeStateCommand = "keepawakestate";
export const KeepAwakeCoffeeCommand = "keepawakecoffee";
export const KeepAwakeOverrideCommand = "keepawakeoverride";
// The ask-once notification's actions run this gesture with the chosen policy.
export const SleepPolicyGesture = "molten:sleeppolicy";
export const SleepPolicySetting = "power:sleeppolicy";

export type SleepPolicy = "allow" | "untilworkends" | "letsleep";

// must match Coffee in pkg/molten/keepawake/keepawake.go
export type KeepAwakeCoffee = {
    workspaceid: string;
    workspacename?: string;
    since: number;
    working: boolean;
    endsat?: number;
};

// must match Attempt in pkg/molten/keepawake/keepawake.go
export type KeepAwakeAttempt = {
    id: string;
    blockid: string;
    workspaceid?: string;
    workspacename?: string;
    tabname?: string;
    tool: string;
    args?: string[];
    pid: number;
    parentpid?: number;
    parentname?: string;
    since: number;
    outcome: "allowed" | "neutralised";
};

// must match Override in pkg/molten/keepawake/keepawake.go
export type KeepAwakeOverride = {
    blockid: string;
    workspaceid?: string;
    workspacename?: string;
    tabname?: string;
    policy: "allow" | "letsleep";
};

// must match State in pkg/molten/keepawake/keepawake.go
export type KeepAwakeState = {
    version: number;
    hold: boolean;
    policy: string;
    policyholding?: boolean;
    policyworking?: boolean;
    policyendsat?: number;
    coffees: KeepAwakeCoffee[];
    attempts: KeepAwakeAttempt[];
    overrides: KeepAwakeOverride[];
};

export const EmptyKeepAwakeState: KeepAwakeState = {
    version: -1,
    hold: false,
    policy: "",
    coffees: [],
    attempts: [],
    overrides: [],
};

// The newer state wins: events and the first read may cross.
export function applyKeepAwakeState(current: KeepAwakeState, next: KeepAwakeState): KeepAwakeState {
    if (next == null || typeof next.version !== "number" || next.version < current.version) {
        return current;
    }
    return {
        ...next,
        coffees: next.coffees ?? [],
        attempts: next.attempts ?? [],
        overrides: next.overrides ?? [],
    };
}

// The coffee bud exists where MoltenTerm can keep the system awake and the shims run: macOS and Linux (DS-SHELL-062).
export function coffeeSupported(platform: string): boolean {
    return platform === "darwin" || platform === "linux";
}

export function computerName(platform: string): string {
    return platform === "darwin" ? "the Mac" : "the computer";
}

export function coffeeOf(state: KeepAwakeState, workspaceId: string): KeepAwakeCoffee {
    return state.coffees.find((c) => c.workspaceid === workspaceId) ?? null;
}

export function railCoffeeLabel(name: string, on: boolean, platform: string): string {
    if (on) {
        return `Stop keeping ${computerName(platform)} awake for ${name}`;
    }
    return `Keep ${computerName(platform)} awake while ${name} works`;
}

// m:ss, never below 0:00.
export function formatCountdown(endsAt: number, now: number): string {
    const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = left % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// The condition of a coffee, in a few words: "until its work ends" while work runs, the time left in its grace
// otherwise (DS-SHELL-063).
export function coffeeCondition(coffee: KeepAwakeCoffee, now: number): string {
    if (coffee.working || !coffee.endsat) {
        return "until its work ends";
    }
    return `ending in ${formatCountdown(coffee.endsat, now)}`;
}

// The coffee bud's tooltip while on (DS-SHELL-062), and the one line the rail item adds.
export function coffeeTooltip(coffee: KeepAwakeCoffee, name: string, platform: string, now: number): string {
    const base = `Keeping ${computerName(platform)} awake until the work in ${name} ends`;
    if (coffee.working || !coffee.endsat) {
        return base;
    }
    return `${base}\nNothing runs there now: ending in ${formatCountdown(coffee.endsat, now)}`;
}

export function attemptAlive(attempt: KeepAwakeAttempt): boolean {
    return attempt.outcome === "allowed";
}

// The status bar's count: MoltenTerm's own block once, whatever the number of coffees, plus each session whose
// reported block was let through (FR-SHELL-022-AC7). A neutralised attempt blocks nothing.
export function keepAwakeCount(state: KeepAwakeState): number {
    const sessions = new Set(state.attempts.filter(attemptAlive).map((a) => a.blockid));
    return (state.hold ? 1 : 0) + sessions.size;
}

export type KeepAwakeSession = {
    blockid: string;
    label: string;
    attempts: KeepAwakeAttempt[];
    override: KeepAwakeOverride;
};

function sessionLabel(tabname: string, workspacename: string): string {
    const parts = [tabname, workspacename].filter((p) => p);
    return parts.length > 0 ? parts.join(" · ") : "A terminal";
}

// The sessions the list shows: those with a reported block, then those with an override and no block now.
export function keepAwakeSessions(state: KeepAwakeState): KeepAwakeSession[] {
    const sessions = new Map<string, KeepAwakeSession>();
    for (const attempt of state.attempts) {
        let session = sessions.get(attempt.blockid);
        if (session == null) {
            session = {
                blockid: attempt.blockid,
                label: sessionLabel(attempt.tabname, attempt.workspacename),
                attempts: [],
                override: null,
            };
            sessions.set(attempt.blockid, session);
        }
        session.attempts.push(attempt);
    }
    for (const override of state.overrides) {
        let session = sessions.get(override.blockid);
        if (session == null) {
            session = {
                blockid: override.blockid,
                label: sessionLabel(override.tabname, override.workspacename),
                attempts: [],
                override,
            };
            sessions.set(override.blockid, session);
        }
        session.override = override;
    }
    return [...sessions.values()];
}

export type SleepPolicyChoice = { policy: SleepPolicy; label: string; detail: string };

export function sleepPolicyChoices(platform: string): SleepPolicyChoice[] {
    const it = computerName(platform);
    return [
        { policy: "allow", label: "Allow", detail: "Terminals' blocks go through." },
        {
            policy: "untilworkends",
            label: "Until work ends",
            detail:
                `MoltenTerm keeps ${it} awake while work runs (an agent working, its subagents included; a foreground ` +
                "command that is not an idle shell; a Mission Control run), and 2 minutes more. An agent waiting " +
                "for input is not work.",
        },
        {
            policy: "letsleep",
            label: "Let it sleep",
            detail: `Terminals' blocks are stopped; ${it} sleeps as planned and the work goes on after wake.`,
        },
    ];
}

export function cleanSleepPolicy(value: string): SleepPolicy {
    if (value === "allow" || value === "untilworkends" || value === "letsleep") {
        return value;
    }
    return null;
}

export function describeAttempt(attempt: KeepAwakeAttempt): string {
    const args = (attempt.args ?? []).join(" ");
    return args ? `${attempt.tool} ${args}` : attempt.tool;
}

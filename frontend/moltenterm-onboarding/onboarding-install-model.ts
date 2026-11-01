// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Install on a card of the pour (FR-ONB-007 AC-5, #1667): wavesrv runs the agent's catalog command
// (pkg/molten/onboarding/clinstall.go) and the card follows it. The window sends the agent's id, never a command.
// Pure, so the rules are tested without a window.

import type { ServerText } from "../moltenterm-shell/i18n/server-text";

// must match pkg/molten/onboarding/clinstall.go
export const CliInstallCommand = "onboardingcliinstall";
export const CliInstallStatusCommand = "onboardingcliinstallstatus";
export const CliInstallInputCommand = "onboardingcliinstallinput";
export const CliInstallCancelCommand = "onboardingcliinstallcancel";
// must match pkg/molten/onboarding/agentpage.go: the Library's Uninstall (#1699), followed with the commands above
export const CliUninstallCommand = "onboardingcliuninstall";

// The terminal's escape sequences: titles (OSC), colours and cursor moves (CSI), and the short ones.
const Esc = "\\u001b";
const Bel = "\\u0007";
const OscSequence = new RegExp(`${Esc}\\][^${Bel}${Esc}]*(${Bel}|${Esc}\\\\)`, "g");
const CsiSequence = new RegExp(`${Esc}\\[[0-?]*[ -/]*[@-~]`, "g");
const EscSequence = new RegExp(`${Esc}[@-_]`, "g");

export type CliInstallState = "" | "running" | "succeeded" | "failed" | "canceled";

export type CliInstallStatus = {
    id: string;
    kind?: "install" | "uninstall";
    command?: string;
    state?: CliInstallState;
    output?: string;
    exitcode?: number;
    error?: string;
    errortext?: ServerText;
    // the installer printed a question and waits for an answer
    waiting?: boolean;
};

// What the card shows: the install running, done and found (Ready), or one of the ways it did not work.
export type InstallPhase = "idle" | "running" | "ready" | "failed" | "notfound" | "canceled";

export function installPhase(status: CliInstallStatus, found: boolean): InstallPhase {
    if (found) {
        return "ready";
    }
    switch (status?.state) {
        case "running":
            return "running";
        case "failed":
            return "failed";
        case "canceled":
            return "canceled";
        case "succeeded":
            return "notfound";
    }
    return "idle";
}

export function isRunning(status: CliInstallStatus): boolean {
    return status?.state === "running";
}

// The terminal's output as plain text: colours and cursor moves go, a line redrawn with a carriage return (a progress
// bar) keeps its last state.
export function cleanInstallOutput(raw: string): string {
    if (!raw) {
        return "";
    }
    const text = raw.replace(OscSequence, "").replace(CsiSequence, "").replace(EscSequence, "").replace(/\r\n/g, "\n");
    return text
        .split("\n")
        .map((line) => {
            const parts = line.split("\r").filter((part) => part !== "");
            return parts.length === 0 ? "" : parts[parts.length - 1];
        })
        .join("\n");
}

// The last line the installer printed, the question when it waits.
export function lastLine(output: string): string {
    const lines = cleanInstallOutput(output).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() !== "") {
            return lines[i].trim();
        }
    }
    return "";
}

// An answer to a password question is typed hidden.
export function isSecretQuestion(output: string): boolean {
    return /pass(word|phrase|code)|mot de passe|\bpin\b/i.test(lastLine(output));
}

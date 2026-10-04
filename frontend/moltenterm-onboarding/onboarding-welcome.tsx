// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The welcome page, the panel's first (FR-ONB-001): what MoltenTerm is in four lines, the licence and the privacy
// commitment. Everything is bundled: no remote font, image or request until the user clicks a link (NFR-ONB-002).

import Logo from "@/app/asset/logo.svg";
import { MoltentermRepoUrl, MoltentermTagline } from "@/util/moltenterm-identity";
import { cn } from "@/util/util";
import { MoltenWave } from "../moltenterm-shell/molten-button";

export const MoltentermLicenseUrl = `${MoltentermRepoUrl}/blob/main/LICENSE`;
export const MoltentermPrivacyUrl = `${MoltentermRepoUrl}/blob/main/PRIVACY.md`;

const Points: { icon: string; title: string; text: React.ReactNode }[] = [
    {
        icon: "terminal",
        title: "Bring your own agent.",
        text: "MoltenTerm ships no AI. Claude Code, Codex, Gemini CLI or any CLI agent runs in it, with your own account.",
    },
    {
        icon: "wand-magic-sparkles",
        title: "Reshaped by your agent.",
        text: (
            <>
                Ask it with <code className="font-mono text-[12px] text-primary">/morph</code> for a panel, a command or
                a layout: it writes a mod, MoltenTerm loads it,{" "}
                <code className="font-mono text-[12px] text-primary">molten undo</code> takes it back.
            </>
        ),
    },
    {
        icon: "clock-rotate-left",
        title: "Sessions that survive.",
        text: "Terminals and agents keep running when MoltenTerm quits or updates.",
    },
    {
        icon: "lock",
        title: "Nothing leaves your machine.",
        text: "MoltenTerm sends no usage data. No account, no telemetry.",
    },
];

const linkClassName = "cursor-pointer text-secondary underline decoration-border underline-offset-2 hover:text-primary";

export function OnboardingWelcome({
    busy,
    onStart,
    onSkip,
}: {
    busy: boolean;
    onStart: () => void;
    onSkip: () => void;
}) {
    return (
        <div className="mx-auto flex w-full max-w-[480px] flex-col gap-6">
            <div className="flex flex-col gap-3">
                <div className="h-8 w-10 [&>svg]:h-full [&>svg]:w-full">
                    <Logo />
                </div>
                <div className="flex flex-col gap-1">
                    <h1 className="text-[22px] leading-7 font-semibold text-primary">Welcome to MoltenTerm</h1>
                    <p className="text-[14px] text-secondary">{MoltentermTagline}</p>
                </div>
            </div>
            <ul className="flex flex-col gap-4">
                {Points.map((point) => (
                    <li key={point.icon} className="flex gap-3">
                        <i
                            className={cn("fa-solid fa-fw mt-[3px] text-[14px] text-accent", `fa-${point.icon}`)}
                            aria-hidden
                        />
                        <p className="text-[13px] leading-5 text-secondary">
                            <span className="font-semibold text-primary">{point.title}</span> {point.text}
                        </p>
                    </li>
                ))}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    disabled={busy}
                    onClick={onStart}
                    className={cn("molten-btn rounded px-4 py-2 text-[13px] font-semibold", busy && "opacity-60")}
                >
                    Set up MoltenTerm
                    <MoltenWave />
                </button>
                <span className="text-xs text-muted">3 short steps</span>
                <button
                    type="button"
                    disabled={busy}
                    onClick={onSkip}
                    className="molten-btn-ghost ml-auto cursor-pointer rounded px-3 py-2 text-[13px] text-secondary hover:text-primary"
                >
                    Skip setup
                </button>
            </div>
            <footer className="flex flex-col gap-1 border-t border-border pt-4 text-xs text-muted">
                <p>Open source under the Apache License 2.0, built on Wave Terminal.</p>
                <p className="flex gap-3">
                    <a href={MoltentermLicenseUrl} target="_blank" rel="noopener" className={linkClassName}>
                        Licence
                    </a>
                    <a href={MoltentermPrivacyUrl} target="_blank" rel="noopener" className={linkClassName}>
                        Privacy
                    </a>
                </p>
            </footer>
        </div>
    );
}

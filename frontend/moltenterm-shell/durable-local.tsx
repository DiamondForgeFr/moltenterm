// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the shield on a local terminal's header says (#107). Local terminals are durable by default in MoltenTerm
// (#72), so Wave's texts, written for SSH sessions and Wave restarts, do not describe them.

import { recordTEvent } from "@/app/store/global";
import type { TermViewModel } from "@/app/view/term/term-model";
import { fireAndForget } from "@/util/util";
import { createContext } from "react";

// True inside the flyover of a local terminal: Wave's "Learn More" link opens Wave's documentation, so it is hidden.
export const DurableLocalContext = createContext(false);

function Title({ iconClass, children }: { iconClass: string; children: React.ReactNode }) {
    return (
        <div className="font-semibold text-sm flex items-center gap-2 text-secondary">
            <i className={iconClass} />
            {children}
        </div>
    );
}

export function LocalDurableAttachedContent() {
    return (
        <div className="flex flex-col gap-2 max-w-[280px]">
            <Title iconClass="fa-sharp fa-solid fa-shield text-sky-500">Durable session</Title>
            <div className="text-xs text-secondary leading-relaxed">
                This shell keeps running when you quit or update MoltenTerm, with its programs and history, and comes
                back here at the next start.
            </div>
        </div>
    );
}

export function LocalDurableDetachedContent() {
    return (
        <div className="flex flex-col gap-2 max-w-[280px]">
            <Title iconClass="fa-sharp fa-solid fa-shield text-sky-300">Durable session (detached)</Title>
            <div className="text-xs text-secondary leading-relaxed">
                The shell is still running; MoltenTerm reattaches this panel to it automatically.
            </div>
        </div>
    );
}

export function LocalStandardSessionContent({ viewModel, onClose }: { viewModel: TermViewModel; onClose: () => void }) {
    const handleRestartAsDurable = () => {
        recordTEvent("action:termdurable", { "action:type": "restartdurable" });
        onClose();
        fireAndForget(() => viewModel.restartSessionWithDurability(true));
    };
    return (
        <div className="flex flex-col gap-2 max-w-[280px]">
            <Title iconClass="fa-sharp fa-regular fa-shield text-muted">Standard session</Title>
            <div className="text-xs text-secondary leading-relaxed">
                This shell ends when MoltenTerm quits. A durable session keeps it running, with its programs and
                history, when you quit or update MoltenTerm.
            </div>
            <button
                className="bg-zinc-700 text-foreground rounded px-3 py-1.5 text-xs font-medium hover:bg-zinc-600 transition-colors cursor-pointer flex items-center justify-center gap-2 mt-1"
                onClick={handleRestartAsDurable}
            >
                <i className="fa-solid fa-shield text-sky-500" />
                Restart as durable
            </button>
        </div>
    );
}

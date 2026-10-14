// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the shield on a local terminal's header says (#107). Local terminals are durable by default in MoltenTerm
// (#72), so Wave's texts, written for SSH sessions and Wave restarts, do not describe them.

import { recordTEvent } from "@/app/store/global";
import type { TermViewModel } from "@/app/view/term/term-model";
import { fireAndForget } from "@/util/util";
import { createContext } from "react";
import { useT } from "./i18n/i18n";

// True inside the flyover of a local terminal: Wave's "Learn More" link opens Wave's documentation, so it is hidden.
export const DurableLocalContext = createContext(false);

function Title({ iconClass, children }: { iconClass: string; children: React.ReactNode }) {
    return (
        <div className="font-semibold text-13 leading-5 flex items-center gap-2 text-secondary">
            <i className={iconClass} />
            {children}
        </div>
    );
}

export function LocalDurableAttachedContent() {
    const t = useT();
    return (
        <div className="flex flex-col gap-2 max-w-[280px]">
            <Title iconClass="fa-sharp fa-solid fa-shield text-secondary">{t("shell.durable.title")}</Title>
            <div className="text-12 text-secondary leading-relaxed">{t("shell.durable.attached")}</div>
        </div>
    );
}

export function LocalDurableDetachedContent() {
    const t = useT();
    return (
        <div className="flex flex-col gap-2 max-w-[280px]">
            <Title iconClass="fa-sharp fa-solid fa-shield text-muted">{t("shell.durable.detachedTitle")}</Title>
            <div className="text-12 text-secondary leading-relaxed">{t("shell.durable.detached")}</div>
        </div>
    );
}

export function LocalStandardSessionContent({ viewModel, onClose }: { viewModel: TermViewModel; onClose: () => void }) {
    const t = useT();
    const handleRestartAsDurable = () => {
        recordTEvent("action:termdurable", { "action:type": "restartdurable" });
        onClose();
        fireAndForget(() => viewModel.restartSessionWithDurability(true));
    };
    return (
        <div className="flex flex-col gap-2 max-w-[280px]">
            <Title iconClass="fa-sharp fa-regular fa-shield text-muted">{t("shell.durable.standardTitle")}</Title>
            <div className="text-12 text-secondary leading-relaxed">{t("shell.durable.standard")}</div>
            <button
                className="molten-btn-secondary mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-6 px-3 py-1.5 text-12 font-medium"
                onClick={handleRestartAsDurable}
            >
                <i className="fa-solid fa-shield" />
                {t("shell.durable.restartAsDurable")}
            </button>
        </div>
    );
}

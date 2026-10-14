// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The trust prompt (FR-MORPH-004). `molten mod enable` asks the calling tab, which shows what the mod declares and
// waits for the user. Mods are not sandboxed in v0 (DS-MORPH-005), so this answer is what stands between a mod and
// the user's rights. Only the answer comes back to molten, which records it.

import { Modal } from "@/app/modals/modal";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { t, useLocale } from "../moltenterm-shell/i18n/i18n";
import { MoltenAgentPart } from "./molten-manifest";

export const MoltenTrustTimeoutMs = 5 * 60 * 1000;

export type MoltenTrustAnswer = "trusted" | "declined" | "timeout";

export type MoltenTrustRequest = {
    id: string;
    name: string;
    version: string;
    description: string;
    capabilities: string[];
    path: string;
    // The Claude Code part the mod carries (FR-MORPH-010), and whether only that part is asked about: the mod was
    // trusted before it had one.
    claudeCodePart?: MoltenAgentPart;
    partsOnly?: boolean;
};

export function moltenClaudeCodePartWarning(): string {
    return t("molten.trust.partWarning");
}

// The words of the prompt, apart from the dialog, so that each case can be checked.
export function moltenTrustWording(req: MoltenTrustRequest): { title: string; intro: string; okLabel: string } {
    if (req.partsOnly && req.claudeCodePart != null) {
        return {
            title: t("molten.trust.partTitle", { name: req.name }),
            intro: t("molten.trust.partIntro"),
            okLabel: t("molten.trust.partOk"),
        };
    }
    let intro = t("molten.trust.intro");
    if (req.claudeCodePart != null) {
        intro += " " + moltenClaudeCodePartWarning();
    }
    return {
        title: t("molten.trust.title", { name: req.name }),
        intro: intro + " " + t("molten.trust.introEnd"),
        okLabel: t("molten.trust.ok"),
    };
}

type PendingTrust = {
    request: MoltenTrustRequest;
    settle: (answer: MoltenTrustAnswer) => void;
};

export class MoltenTrustModel {
    private static instance: MoltenTrustModel = null;

    currentAtom = atom<PendingTrust>(null) as PrimitiveAtom<PendingTrust>;
    waiting: PendingTrust[] = [];

    private constructor() {}

    static getInstance(): MoltenTrustModel {
        if (!MoltenTrustModel.instance) {
            MoltenTrustModel.instance = new MoltenTrustModel();
        }
        return MoltenTrustModel.instance;
    }

    static resetInstance(): void {
        MoltenTrustModel.instance = null;
    }

    // One prompt at a time: a second request waits behind the first, and its time runs while it waits.
    ask(request: MoltenTrustRequest, timeoutMs = MoltenTrustTimeoutMs): Promise<MoltenTrustAnswer> {
        return new Promise((resolve) => {
            let settled = false;
            const pending: PendingTrust = {
                request,
                settle: (answer) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    this.finish(pending);
                    resolve(answer);
                },
            };
            const timer = setTimeout(() => pending.settle("timeout"), timeoutMs);
            this.waiting.push(pending);
            this.showNext();
        });
    }

    answer(answer: MoltenTrustAnswer): void {
        globalStore.get(this.currentAtom)?.settle(answer);
    }

    showNext(): void {
        if (globalStore.get(this.currentAtom) != null) {
            return;
        }
        const next = this.waiting.shift();
        if (next != null) {
            globalStore.set(this.currentAtom, next);
        }
    }

    finish(pending: PendingTrust): void {
        this.waiting = this.waiting.filter((p) => p !== pending);
        if (globalStore.get(this.currentAtom) === pending) {
            globalStore.set(this.currentAtom, null);
        }
        this.showNext();
    }
}

function TrustField({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex gap-3">
            <div className="w-28 shrink-0 text-secondary">{label}</div>
            <div className="min-w-0 flex-1 break-words">{children}</div>
        </div>
    );
}

export function MoltenTrustDialog() {
    const model = MoltenTrustModel.getInstance();
    const pending = useAtomValue(model.currentAtom, { store: globalStore });
    // The prompt's words come from t(): rendering again on a language change keeps them current.
    useLocale();
    useEffect(() => {
        if (pending == null) {
            return;
        }
        // Capture phase: Escape must decline here before Wave's own key handling sees it.
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            model.answer("declined");
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
    }, [pending, model]);
    if (pending == null) {
        return null;
    }
    const req = pending.request;
    const wording = moltenTrustWording(req);
    const part = req.claudeCodePart;
    return (
        <Modal
            className="molten-trust"
            okLabel={wording.okLabel}
            cancelLabel={t("molten.trust.cancel")}
            onOk={() => model.answer("trusted")}
            onCancel={() => model.answer("declined")}
            onClose={() => model.answer("declined")}
        >
            <div className="flex max-w-[560px] flex-col gap-3 text-sm">
                <div className="text-lg font-semibold">{wording.title}</div>
                <div className="text-secondary">{wording.intro}</div>
                <div className="flex flex-col gap-1">
                    <TrustField label={t("molten.trust.fieldMod")}>
                        {req.id} {req.version}
                    </TrustField>
                    <TrustField label={t("molten.trust.fieldDescription")}>{req.description || "—"}</TrustField>
                    <TrustField label={t("molten.trust.fieldCapabilities")}>
                        {req.capabilities.length > 0 ? req.capabilities.join(", ") : t("molten.trust.noCapabilities")}
                    </TrustField>
                    <TrustField label={t("molten.trust.fieldFolder")}>
                        <span className="font-mono text-xs">{req.path}</span>
                    </TrustField>
                    {part != null ? (
                        <TrustField label={t("molten.trust.fieldPart")}>
                            <span className="font-mono text-xs">{part.folder}</span>
                            {t("molten.trust.partWrittenFor", { version: part.targetVersion })}
                        </TrustField>
                    ) : null}
                </div>
                <div className="text-secondary">{t("molten.trust.footer", { id: req.id })}</div>
            </div>
        </Modal>
    );
}

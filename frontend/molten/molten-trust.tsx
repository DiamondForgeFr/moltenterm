// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The trust prompt (FR-MORPH-004). `molten mod enable` asks the calling tab, which shows what the mod declares and
// waits for the user. Mods are not sandboxed in v0 (DS-MORPH-005), so this answer is what stands between a mod and
// the user's rights. Only the answer comes back to molten, which records it.

import { Modal } from "@/app/modals/modal";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
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

export const MoltenClaudeCodePartWarning =
    "It also carries a Claude Code part that runs inside Claude Code, in every Claude Code session you start in a " +
    "MoltenTerm terminal, with your rights: it can change what Claude Code shows and does, read files and run commands.";

// The words of the prompt, apart from the dialog, so that each case can be checked.
export function moltenTrustWording(req: MoltenTrustRequest): { title: string; intro: string; okLabel: string } {
    if (req.partsOnly && req.claudeCodePart != null) {
        return {
            title: `Trust the Claude Code part of “${req.name}”?`,
            intro:
                "A coding agent asked to enable this mod, which you trusted before it had a Claude Code part. The part " +
                "runs inside Claude Code, in every Claude Code session you start in a MoltenTerm terminal, with your " +
                "rights: it can change what Claude Code shows and does, read files and run commands. Declining keeps " +
                "the rest of the mod running.",
            okLabel: "Trust the part",
        };
    }
    let intro =
        "A coding agent asked to enable this mod. It runs inside MoltenTerm with your rights: it can read and change " +
        "your files and run commands.";
    if (req.claudeCodePart != null) {
        intro += " " + MoltenClaudeCodePartWarning;
    }
    return {
        title: `Trust the mod “${req.name}”?`,
        intro: intro + " Trust it only if you know where it comes from.",
        okLabel: "Trust and enable",
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
            cancelLabel="Don't trust"
            onOk={() => model.answer("trusted")}
            onCancel={() => model.answer("declined")}
            onClose={() => model.answer("declined")}
        >
            <div className="flex max-w-[560px] flex-col gap-3 text-sm">
                <div className="text-lg font-semibold">{wording.title}</div>
                <div className="text-secondary">{wording.intro}</div>
                <div className="flex flex-col gap-1">
                    <TrustField label="Mod">
                        {req.id} {req.version}
                    </TrustField>
                    <TrustField label="Description">{req.description || "—"}</TrustField>
                    <TrustField label="Capabilities">
                        {req.capabilities.length > 0 ? req.capabilities.join(", ") : "none declared"}
                    </TrustField>
                    <TrustField label="Folder">
                        <span className="font-mono text-xs">{req.path}</span>
                    </TrustField>
                    {part != null ? (
                        <TrustField label="Claude Code part">
                            <span className="font-mono text-xs">{part.folder}</span>, written for Claude Code{" "}
                            {part.targetVersion}
                        </TrustField>
                    ) : null}
                </div>
                <div className="text-secondary">
                    The agent can keep editing it without asking again. Undo with molten mod untrust {req.id}.
                </div>
            </div>
        </Modal>
    );
}

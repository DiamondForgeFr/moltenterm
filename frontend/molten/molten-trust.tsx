// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The trust prompt (FR-MORPH-004). `molten mod enable` asks the calling tab, which shows what the mod declares and
// waits for the user. Mods are not sandboxed in v0 (DS-MORPH-005), so this answer is what stands between a mod and
// the user's rights. Only the answer comes back to molten, which records it.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { DialogFrame } from "../moltenterm-shell/dialog-frame";
import { t, TFunction, useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { tildePath } from "../moltenterm-shell/sessions/sessions-model";
import { BlockRows, SectionBlock } from "../moltenterm-shell/suite/suite";
import { suiteIcon } from "../moltenterm-shell/suite/suite-icons";
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

function asksPartOnly(req: MoltenTrustRequest): boolean {
    return req.partsOnly === true && req.claudeCodePart != null;
}

export type MoltenTrustWording = {
    title: string;
    risk: string;
    // What declining leaves running, said only when the mod itself is already trusted.
    declineNote: string;
    okLabel: string;
};

// The words of the prompt, apart from the dialog, so that each case can be checked.
export function moltenTrustWording(req: MoltenTrustRequest, tr: TFunction = t): MoltenTrustWording {
    if (asksPartOnly(req)) {
        return {
            title: tr("molten.trust.partTitle", { name: req.name }),
            risk: tr("molten.trust.partRisk"),
            declineNote: tr("molten.trust.declineKeeps"),
            okLabel: tr("molten.trust.partOk"),
        };
    }
    return {
        title: tr("molten.trust.title", { name: req.name }),
        risk: tr("molten.trust.risk"),
        declineNote: "",
        okLabel: tr("molten.trust.ok"),
    };
}

export type MoltenTrustFact = {
    kind: "run" | "part";
    lead: string;
    detail: string;
};

// What the mod can do with the user's rights, one fact per place it runs. A mod trusted before it had a Claude Code
// part is asked about the part alone: the user already answered for the rest.
export function moltenTrustFacts(req: MoltenTrustRequest, tr: TFunction = t): MoltenTrustFact[] {
    const facts: MoltenTrustFact[] = [];
    if (!asksPartOnly(req)) {
        facts.push({
            kind: "run",
            lead: tr("molten.trust.canRun"),
            detail: tr("molten.trust.canRunDetail"),
        });
    }
    if (req.claudeCodePart != null) {
        facts.push({
            kind: "part",
            lead: tr("molten.trust.canPart"),
            detail: tr("molten.trust.canPartDetail"),
        });
    }
    return facts;
}

export function moltenModInitial(req: MoltenTrustRequest): string {
    const source = (req.name || req.id || "").trim();
    return Array.from(source)[0]?.toUpperCase() ?? "?";
}

type PendingTrust = {
    request: MoltenTrustRequest;
    // Tells two prompts for the same mod apart, so that the second opens with its details closed.
    seq: number;
    settle: (answer: MoltenTrustAnswer) => void;
};

export class MoltenTrustModel {
    private static instance: MoltenTrustModel = null;

    currentAtom = atom<PendingTrust>(null) as PrimitiveAtom<PendingTrust>;
    waiting: PendingTrust[] = [];
    lastSeq = 0;

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
            this.lastSeq += 1;
            const pending: PendingTrust = {
                request,
                seq: this.lastSeq,
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

const FocusRing =
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)";
const DeclineButton = cn(
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary",
    FocusRing
);
const TrustButton = cn("molten-btn cursor-pointer rounded-4 px-4 py-1.5 text-12", FocusRing);
const ChipClass = "rounded-4 border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-11 text-secondary";

function Identity({ req }: { req: MoltenTrustRequest }) {
    const t = useT();
    return (
        <div className="flex items-start gap-3" data-role="molten-trust-identity">
            <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-4 border border-border bg-surface-2 text-13 font-semibold text-accent"
                aria-hidden
            >
                {moltenModInitial(req)}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-13 font-semibold text-primary" title={req.name}>
                        {req.name}
                    </span>
                    {req.version ? (
                        <span className={cn(ChipClass, "shrink-0 py-0")}>
                            {t("molten.trust.versionChip", { version: req.version })}
                        </span>
                    ) : null}
                </div>
                {req.description ? (
                    <div className="line-clamp-2 text-12 text-secondary [overflow-wrap:anywhere]">
                        {req.description}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function FactRow({ fact }: { fact: MoltenTrustFact }) {
    const concept = fact.kind === "part" ? "agent" : "shell";
    const Icon = suiteIcon(concept);
    return (
        <div className="flex items-start gap-3 px-4 py-2.5" data-fact={fact.kind}>
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-secondary" aria-hidden />
            <div className="flex min-w-0 flex-col gap-0.5">
                <div className="text-12 font-medium text-primary">{fact.lead}</div>
                <div className="text-11 text-secondary">{fact.detail}</div>
            </div>
        </div>
    );
}

function CapabilitiesRow({ capabilities }: { capabilities: string[] }) {
    const t = useT();
    const Icon = suiteIcon("verification");
    return (
        <div className="flex items-start gap-3 px-4 py-2.5" data-fact="capabilities">
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-secondary" aria-hidden />
            <div className="flex min-w-0 flex-col gap-1.5">
                <div className="text-12 font-medium text-primary">{t("molten.trust.capabilities")}</div>
                <div className="flex flex-wrap gap-1.5">
                    {capabilities.length > 0 ? (
                        capabilities.map((c) => (
                            <span key={c} className={ChipClass}>
                                {c}
                            </span>
                        ))
                    ) : (
                        <span className="rounded-4 border border-dashed border-border px-1.5 py-0.5 text-11 text-muted">
                            {t("molten.trust.noCapabilities")}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

function homeFolder(): string {
    try {
        return getApi()?.getHomeDir?.() ?? "";
    } catch {
        return "";
    }
}

export function MoltenTrustDetails({ req, defaultOpen }: { req: MoltenTrustRequest; defaultOpen?: boolean }) {
    const t = useT();
    const [open, setOpen] = useState(defaultOpen === true);
    const bodyId = useId();
    const part = req.claudeCodePart;
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <div className="flex flex-col gap-2" data-role="molten-trust-details">
            <button
                type="button"
                className={cn(
                    "flex w-fit cursor-pointer items-center gap-1 text-11 text-secondary hover:text-primary",
                    FocusRing
                )}
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                onClick={() => setOpen(!open)}
            >
                <Chevron className="h-3.5 w-3.5" aria-hidden />
                {t("molten.trust.details")}
            </button>
            {open ? (
                <dl id={bodyId} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-11">
                    <dt className="text-muted">{t("molten.trust.detailsFolder")}</dt>
                    <dd className="flex min-w-0 flex-col items-start gap-0.5">
                        <span className="font-mono break-all text-secondary select-text" title={req.path}>
                            {tildePath(req.path, homeFolder())}
                        </span>
                        <button
                            type="button"
                            className={cn("cursor-pointer text-accent hover:underline", FocusRing)}
                            onClick={() => getApi().revealNativePath(req.path)}
                        >
                            {t("molten.trust.showInFolder")}
                        </button>
                    </dd>
                    {part != null ? (
                        <>
                            <dt className="text-muted">{t("molten.trust.detailsPart")}</dt>
                            <dd className="flex min-w-0 flex-col gap-0.5">
                                <span className="font-mono break-all text-secondary select-text">{part.folder}</span>
                                <span className="text-muted">
                                    {t("molten.trust.detailsPartTarget", { version: part.targetVersion })}
                                </span>
                            </dd>
                        </>
                    ) : null}
                </dl>
            ) : null}
        </div>
    );
}

function TrustPrompt({
    request: req,
    onAnswer,
}: {
    request: MoltenTrustRequest;
    onAnswer: (answer: MoltenTrustAnswer) => void;
}) {
    const t = useT();
    const declineRef = useRef<HTMLButtonElement>(null);
    // The safe choice holds the focus, so that Enter keeps the mod off.
    useLayoutEffect(() => {
        declineRef.current?.focus();
    }, []);
    const wording = moltenTrustWording(req, t);
    const facts = moltenTrustFacts(req, t);
    const Warning = suiteIcon("danger");
    return (
        <DialogFrame
            role="molten-mod-trust"
            title={wording.title}
            subtitle={t("molten.trust.askedBy")}
            widthClass="w-[520px]"
            suite
            onEscape={() => onAnswer("declined")}
            buttons={
                <>
                    <button
                        ref={declineRef}
                        type="button"
                        className={DeclineButton}
                        data-answer="declined"
                        onClick={() => onAnswer("declined")}
                    >
                        {t("molten.trust.cancel")}
                    </button>
                    <button
                        type="button"
                        className={TrustButton}
                        data-answer="trusted"
                        onClick={() => onAnswer("trusted")}
                    >
                        {wording.okLabel}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-4 pt-3">
                <Identity req={req} />
                <div className="flex flex-col gap-1">
                    <p className="flex items-start gap-2 text-12 text-primary" data-role="molten-trust-risk">
                        <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                        <span>{wording.risk}</span>
                    </p>
                    {wording.declineNote ? <p className="pl-[22px] text-11 text-muted">{wording.declineNote}</p> : null}
                </div>
                <SectionBlock title={t("molten.trust.canTitle")} icon={suiteIcon("mods")}>
                    <BlockRows>
                        {facts.map((fact) => (
                            <FactRow key={fact.kind} fact={fact} />
                        ))}
                        <CapabilitiesRow capabilities={req.capabilities} />
                    </BlockRows>
                </SectionBlock>
                <MoltenTrustDetails req={req} />
                <div className="flex flex-col gap-1 text-11 text-muted" data-role="molten-trust-revoke">
                    <p>{t("molten.trust.keepsEditing")}</p>
                    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        <span>{t("molten.trust.revoke")}</span>
                        <code className={cn(ChipClass, "break-all select-text")}>molten mod untrust {req.id}</code>
                    </p>
                </div>
            </div>
        </DialogFrame>
    );
}

export function MoltenTrustDialog() {
    const model = MoltenTrustModel.getInstance();
    const pending = useAtomValue(model.currentAtom, { store: globalStore });
    if (pending == null) {
        return null;
    }
    return <TrustPrompt key={pending.seq} request={pending.request} onAnswer={(answer) => model.answer(answer)} />;
}

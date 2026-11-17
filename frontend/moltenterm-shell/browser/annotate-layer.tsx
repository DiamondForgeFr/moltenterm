// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The annotate mode of the web page panel (FR-BRW-017, DS-BRW-024, #2327). The page freezes into its capture; the
// developer draws a rectangle, a comment field opens beside it with the focus in it, Enter validates and the next zone
// can be drawn at once. A tray shows the count and leads to the review: what will be sent, to whom and why, and the
// click that sends it. Nothing leaves before that click. The rules of the zones, the keys and the agent proposed are in
// annotate-model.ts; wavesrv writes the report (pkg/molten/mission/annotate.go).

import { atoms } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgentNameLocks } from "../agent-name-locks-store";
import { AgentStates } from "../agent-state-store";
import { useT, useTCount } from "../i18n/i18n";
import { errorPhrase, type Phrase, phrase, useWordPhrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { ReviewsModel } from "../reviews/reviews-store";
import { upcomingGet } from "../reviews/reviews-upcoming-client";
import { useWorkspaceReviews } from "../reviews/reviews-workspace";
import { DominoLoader } from "../suite/suite";
import { readWorkspaceProject } from "../workspace-project";
import { callAnnotate, capturePage, settlePaint } from "./annotate-client";
import {
    addZone,
    annotateRequest,
    type AnnotateResult,
    type AnnotateState,
    type AnnotateTarget,
    annotateTargetOf,
    cancelEdit,
    clearAll,
    commentKeyAction,
    commitComment,
    editZone,
    emptyState,
    eraseZone,
    fieldPlacement,
    gestureOf,
    layerKeyAction,
    MaxCommentChars,
    MaxZones,
    type Point,
    type Recipient,
    setComment,
    type Size,
    type Zone,
    zoneNumber,
} from "./annotate-model";
import { composeAnnotatedImage } from "./annotate-paint";
import type { AnnotateSession } from "./annotate-session";
import { useTestContext } from "./test-context";

const FieldSize: Size = { w: 288, h: 156 };

function pct(n: number): string {
    return `${(n * 100).toFixed(3)}%`;
}

function hostOf(address: string): string {
    try {
        return new URL(address).host;
    } catch {
        return address;
    }
}

export function NumberBadge({ n }: { n: number }) {
    return (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--mt-action)] text-11 font-semibold text-white">
            {n}
        </span>
    );
}

// The zone as drawn on the frozen page: its frame, its number and its comment. A click or Enter edits it, Delete
// erases it.
export function ZoneMark({
    zone,
    n,
    active,
    onEdit,
    onErase,
}: {
    zone: Zone;
    n: number;
    active: boolean;
    onEdit: () => void;
    onErase: () => void;
}) {
    const t = useT();
    const label = zone.comment.trim()
        ? t("browser.annotate.zone.labelWith", { n, comment: zone.comment.trim() })
        : t("browser.annotate.zone.label", { n });
    return (
        <div
            role="button"
            tabIndex={0}
            aria-label={label}
            title={zone.comment.trim() || undefined}
            data-testid="browser-annotate-zone"
            data-n={n}
            className="absolute cursor-pointer border-2 border-[var(--mt-action)]"
            style={{
                left: pct(zone.x),
                top: pct(zone.y),
                width: pct(zone.w),
                height: pct(zone.h),
                backgroundColor: `color-mix(in srgb, var(--mt-action) ${active ? 26 : 12}%, transparent)`,
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onEdit();
                } else if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    e.stopPropagation();
                    onErase();
                }
            }}
        >
            <span className="absolute -top-2.5 -left-2.5 flex max-w-[16rem] items-center gap-1.5">
                <NumberBadge n={n} />
                {zone.comment.trim() ? (
                    <span className="min-w-0 truncate rounded-4 bg-surface-3 px-1.5 py-0.5 text-11 text-primary shadow-e2">
                        {zone.comment.trim()}
                    </span>
                ) : null}
            </span>
        </div>
    );
}

// The comment field beside a zone, with the focus in it as soon as the mouse is released.
export function CommentField({
    zone,
    n,
    stage,
    onChange,
    onCommit,
    onCancel,
    onErase,
}: {
    zone: Zone;
    n: number;
    stage: Size;
    onChange: (comment: string) => void;
    onCommit: () => void;
    onCancel: () => void;
    onErase: () => void;
}) {
    const t = useT();
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const field = ref.current;
        field?.focus();
        field?.setSelectionRange(field.value.length, field.value.length);
    }, [zone.id]);
    const at = fieldPlacement(zone, stage, FieldSize);
    return (
        <div
            className="absolute z-30 flex flex-col gap-1.5 rounded-6 border border-border bg-surface-3 p-2 shadow-e2"
            style={{ left: at.x, top: at.y, width: FieldSize.w }}
            data-testid="browser-annotate-field"
        >
            <div className="flex items-center gap-1.5">
                <NumberBadge n={n} />
                <span className="min-w-0 flex-1 truncate text-11 font-medium text-secondary">
                    {t("browser.annotate.field.title", { n })}
                </span>
                <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-4 text-muted hover:bg-hover hover:text-primary"
                    title={t("browser.annotate.field.erase")}
                    aria-label={t("browser.annotate.field.erase")}
                    onClick={onErase}
                    data-testid="browser-annotate-erase"
                >
                    <i className="fa fa-solid fa-trash-can text-11" aria-hidden />
                </button>
            </div>
            <textarea
                ref={ref}
                rows={3}
                value={zone.comment}
                maxLength={MaxCommentChars}
                placeholder={t("browser.annotate.field.placeholder")}
                aria-label={t("browser.annotate.field.title", { n })}
                className="w-full resize-none rounded-4 border border-border bg-surface-2 px-2 py-1.5 text-12 leading-4 text-primary outline-none focus:border-[var(--mt-action)]"
                data-testid="browser-annotate-comment"
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    const action = commentKeyAction({
                        key: e.key,
                        shiftKey: e.shiftKey,
                        isComposing: e.nativeEvent.isComposing,
                    });
                    if (action == null || action === "newline") {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    if (action === "commit") {
                        onCommit();
                    } else {
                        onCancel();
                    }
                }}
            />
            <p className="text-11 leading-4 text-muted">{t("browser.annotate.field.hint")}</p>
        </div>
    );
}

export function Tray({
    count,
    leaveAsk,
    onClear,
    onReview,
    onClose,
    onDiscard,
    onKeep,
}: {
    count: number;
    leaveAsk: boolean;
    onClear: () => void;
    onReview: () => void;
    onClose: () => void;
    onDiscard: () => void;
    onKeep: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    return (
        <div
            className="absolute bottom-3 left-1/2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-6 border border-border bg-surface-3 px-3 py-2 text-12 shadow-e2"
            data-testid="browser-annotate-tray"
            role="toolbar"
            aria-label={t("browser.annotate.layerLabel")}
        >
            {leaveAsk ? (
                <>
                    <span className="text-primary">{tc("browser.annotate.tray.leaveAsk", count)}</span>
                    <button
                        type="button"
                        className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-3 py-1.5 text-12"
                        onClick={onDiscard}
                        data-testid="browser-annotate-discard"
                    >
                        {t("browser.annotate.tray.discard")}
                        <MoltenWave />
                    </button>
                    <button
                        type="button"
                        className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                        onClick={onKeep}
                    >
                        {t("browser.annotate.tray.keep")}
                    </button>
                </>
            ) : (
                <>
                    {count === 0 ? (
                        <span className="text-secondary" data-testid="browser-annotate-hint">
                            {t("browser.annotate.hint")}
                        </span>
                    ) : (
                        <span className="font-medium text-primary" data-testid="browser-annotate-count">
                            {tc("browser.annotate.tray.zones", count)}
                        </span>
                    )}
                    {count >= MaxZones ? (
                        <span className="text-11 text-muted">
                            {t("browser.annotate.tray.full", { count: MaxZones })}
                        </span>
                    ) : null}
                    {count > 0 ? (
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 px-2 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={onClear}
                            data-testid="browser-annotate-clear"
                        >
                            {t("browser.annotate.tray.clear")}
                        </button>
                    ) : null}
                    {count > 0 ? (
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            onClick={onReview}
                            data-testid="browser-annotate-review"
                        >
                            {t("browser.annotate.tray.review")}
                            <MoltenWave />
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-4 text-muted hover:bg-hover hover:text-primary"
                        title={t("browser.annotate.close")}
                        aria-label={t("browser.annotate.close")}
                        onClick={onClose}
                        data-testid="browser-annotate-close"
                    >
                        <i className="fa fa-solid fa-xmark text-12" aria-hidden />
                    </button>
                </>
            )}
        </div>
    );
}

export type Outcome =
    | { kind: "sent"; result: AnnotateResult }
    | { kind: "copied" }
    | { kind: "gone"; name: string }
    | { kind: "failed"; text: Phrase };

export type ReviewViewProps = {
    target: AnnotateTarget;
    recipients: Recipient[];
    chosen: Recipient;
    image: string;
    imageFailed: boolean;
    report: { text?: string; error?: Phrase };
    busy: "send" | "copy" | null;
    outcome: Outcome;
    onPick: (blockId: string) => void;
    onSend: () => void;
    onCopy: () => void;
    onBack: () => void;
    onDone: () => void;
};

function whyText(t: (key: string, vars?: Record<string, string | number>) => string, r: Recipient, branch: string) {
    return t(`browser.annotate.why.${r.why}`, { branch });
}

// What will be sent: the recipient and why, the page, the annotated image and the report as wavesrv writes it.
export function ReviewView(props: ReviewViewProps) {
    const t = useT();
    const word = useWordPhrase();
    const { target, chosen, recipients, outcome, busy } = props;
    const sent = outcome?.kind === "sent";
    return (
        <aside
            className="absolute inset-y-2 right-2 z-40 flex w-[26rem] max-w-[calc(100%-1rem)] flex-col rounded-6 border border-border bg-surface-3 shadow-e2"
            role="dialog"
            aria-label={t("browser.annotate.review.title")}
            data-testid="browser-annotate-review-panel"
        >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <h3 className="min-w-0 flex-1 truncate text-13 font-semibold text-primary">
                    {t("browser.annotate.review.title")}
                </h3>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-12">
                <section className="flex flex-col gap-1.5" aria-label={t("browser.annotate.review.to")}>
                    <h4 className="text-11 font-semibold text-muted">{t("browser.annotate.review.to")}</h4>
                    {chosen != null ? (
                        <p className="leading-4 text-secondary" data-testid="browser-annotate-chosen">
                            <span className="font-semibold text-primary">{chosen.name}</span>
                            {" · "}
                            {whyText(t, chosen, target.branch)}
                        </p>
                    ) : (
                        <p className="leading-4 text-secondary" data-testid="browser-annotate-noagent">
                            {t("browser.annotate.review.noAgent")}
                        </p>
                    )}
                    {chosen?.lead ? (
                        <p className="text-11 leading-4 text-muted">
                            {t("browser.annotate.review.leadNote", { name: chosen.name })}
                        </p>
                    ) : null}
                    {recipients.length > 1 ? (
                        <div
                            role="radiogroup"
                            aria-label={t("browser.annotate.review.pick")}
                            className="flex flex-col gap-0.5"
                            data-testid="browser-annotate-recipients"
                        >
                            {recipients.map((r) => {
                                const on = r.blockId === chosen?.blockId;
                                return (
                                    <button
                                        key={r.blockId}
                                        type="button"
                                        role="radio"
                                        aria-checked={on}
                                        disabled={sent}
                                        className={cn(
                                            "flex min-w-0 cursor-pointer items-baseline gap-1.5 rounded-4 px-2 py-1.5 text-left hover:bg-hover",
                                            on && "mt-selected-action bg-hover"
                                        )}
                                        onClick={() => props.onPick(r.blockId)}
                                        data-testid="browser-annotate-recipient"
                                    >
                                        <span className="shrink-0 font-medium text-primary">{r.name}</span>
                                        <span className="min-w-0 truncate text-11 text-secondary">
                                            {whyText(t, r, target.branch)}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                </section>
                <section className="flex flex-col gap-1.5" aria-label={t("browser.annotate.review.page")}>
                    <h4 className="text-11 font-semibold text-muted">{t("browser.annotate.review.page")}</h4>
                    <p className="font-mono leading-4 [overflow-wrap:anywhere] text-primary">{target.address}</p>
                    {target.branch ? (
                        <p className="inline-flex items-center gap-1 font-mono text-11 text-secondary">
                            <i className="fa fa-solid fa-code-branch text-10 text-muted" aria-hidden />
                            {target.branch}
                        </p>
                    ) : null}
                </section>
                <section className="flex flex-col gap-1.5" aria-label={t("browser.annotate.review.image")}>
                    <h4 className="text-11 font-semibold text-muted">{t("browser.annotate.review.image")}</h4>
                    {props.image ? (
                        <img
                            src={props.image}
                            alt={t("browser.annotate.review.image")}
                            className="w-full rounded-4 border border-border"
                            data-testid="browser-annotate-image"
                        />
                    ) : props.imageFailed ? null : (
                        <DominoLoader label={t("browser.annotate.review.loading")} />
                    )}
                </section>
                <section className="flex flex-col gap-1.5" aria-label={t("browser.annotate.review.report")}>
                    <h4 className="text-11 font-semibold text-muted">{t("browser.annotate.review.report")}</h4>
                    {props.report.text != null ? (
                        <pre
                            className="max-h-60 overflow-auto rounded-4 border border-border bg-surface-2 p-2 font-mono text-11 leading-4 whitespace-pre-wrap text-primary [overflow-wrap:anywhere]"
                            data-testid="browser-annotate-report"
                        >
                            {props.report.text}
                        </pre>
                    ) : props.report.error != null ? (
                        <p className="text-11 leading-4 text-[var(--mt-state-warning)]">
                            {t("browser.annotate.review.failed", { error: word(props.report.error) })}
                        </p>
                    ) : (
                        <DominoLoader label={t("browser.annotate.review.loading")} />
                    )}
                    <p className="text-11 leading-4 text-muted">{t("browser.annotate.review.reportNote")}</p>
                </section>
            </div>
            <footer className="flex flex-col gap-2 border-t border-border px-3 py-2">
                {outcome != null ? <OutcomeNote outcome={outcome} /> : null}
                <div className="flex flex-wrap items-center gap-2">
                    {sent ? (
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            onClick={props.onDone}
                            data-testid="browser-annotate-done"
                        >
                            {t("browser.annotate.sent.done")}
                            <MoltenWave />
                        </button>
                    ) : (
                        <>
                            {chosen != null ? (
                                <button
                                    type="button"
                                    className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                                    disabled={busy != null || props.image === "" || props.report.text == null}
                                    onClick={props.onSend}
                                    data-testid="browser-annotate-send"
                                >
                                    {busy === "send"
                                        ? t("browser.annotate.review.sending")
                                        : t("browser.annotate.review.send", { name: chosen.name })}
                                    <MoltenWave />
                                </button>
                            ) : null}
                            <button
                                type="button"
                                className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                                disabled={busy != null || props.image === "" || props.report.text == null}
                                onClick={props.onCopy}
                                data-testid="browser-annotate-copy"
                            >
                                {t("browser.annotate.review.copy")}
                            </button>
                            <button
                                type="button"
                                className="cursor-pointer rounded-4 px-2 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                                onClick={props.onBack}
                                data-testid="browser-annotate-back"
                            >
                                {t("browser.annotate.review.back")}
                            </button>
                        </>
                    )}
                </div>
            </footer>
        </aside>
    );
}

function OutcomeNote({ outcome }: { outcome: Outcome }) {
    const t = useT();
    const word = useWordPhrase();
    let text = "";
    let bad = false;
    switch (outcome.kind) {
        case "sent": {
            const to = outcome.result.to ?? "";
            const how = outcome.result.delivery ?? "delivered";
            text = `${t(`browser.annotate.sent.${how}`, { name: to })} ${t("browser.annotate.sent.kept")}`;
            break;
        }
        case "copied":
            text = t("browser.annotate.review.copied");
            break;
        case "gone":
            text = t("browser.annotate.gone", { name: outcome.name });
            bad = true;
            break;
        default:
            text = word(outcome.text);
            bad = true;
    }
    return (
        <p
            role="status"
            className={cn("text-11 leading-4", bad ? "text-[var(--mt-state-warning)]" : "text-secondary")}
            data-testid="browser-annotate-outcome"
        >
            {text}
        </p>
    );
}

// The agent's choice, the image and the report are asked while the review is open; a send, a copy or a different
// agent never reuses an answer of another one.
function Review({
    target,
    zones,
    captureUrl,
    onBack,
    onDone,
}: {
    target: AnnotateTarget;
    zones: Zone[];
    captureUrl: string;
    onBack: () => void;
    onDone: () => void;
}) {
    const t = useT();
    const [chosenId, setChosenId] = useState("");
    const [image, setImage] = useState<string>("");
    const [imageFailed, setImageFailed] = useState(false);
    const [report, setReport] = useState<{ text?: string; error?: Phrase }>({});
    const [busy, setBusy] = useState<"send" | "copy">(null);
    const [outcome, setOutcome] = useState<Outcome>(null);
    const chosen = target.recipients.find((r) => r.blockId === chosenId) ?? target.recipients[0] ?? null;
    const zonesKey = JSON.stringify(zones.map((z) => [z.x, z.y, z.w, z.h, z.comment.trim()]));
    useEffect(() => {
        let live = true;
        setImage("");
        setImageFailed(false);
        fireAndForget(async () => {
            try {
                const composed = await composeAnnotatedImage(captureUrl, zones);
                if (live) {
                    setImage(composed.dataUrl);
                }
            } catch {
                if (live) {
                    setImageFailed(true);
                }
            }
        });
        return () => {
            live = false;
        };
    }, [captureUrl, zonesKey]);
    const lead = !!chosen?.lead;
    useEffect(() => {
        let live = true;
        setReport({});
        fireAndForget(async () => {
            try {
                const answer = await callAnnotate(
                    annotateRequest("preview", target, zones, { to: chosen ?? undefined })
                );
                if (live) {
                    setReport({ text: answer.text ?? "" });
                }
            } catch (e) {
                if (live) {
                    setReport({ error: errorPhrase(e) });
                }
            }
        });
        return () => {
            live = false;
        };
    }, [zonesKey, lead, target.address, target.branch, target.root]);
    const title = t("browser.annotate.materialTitle", { where: target.branch || hostOf(target.address) });
    const run = (kind: "send" | "copy") => {
        if (busy != null || image === "" || (kind === "send" && chosen == null)) {
            return;
        }
        setBusy(kind);
        setOutcome(null);
        fireAndForget(async () => {
            try {
                const result = await callAnnotate(
                    annotateRequest(kind, target, zones, { title, image, to: chosen ?? undefined })
                );
                if (result.status === "noagent") {
                    setOutcome({ kind: "gone", name: chosen?.name ?? "" });
                } else if (result.status === "copied") {
                    await navigator.clipboard.writeText(result.text ?? "");
                    setOutcome({ kind: "copied" });
                } else {
                    setOutcome({ kind: "sent", result });
                }
            } catch (e) {
                const key = kind === "send" ? "browser.annotate.sendFailed" : "browser.annotate.review.copyFailed";
                setOutcome({ kind: "failed", text: phrase(key, { error: errorPhrase(e) }) });
            } finally {
                setBusy(null);
            }
        });
    };
    return (
        <ReviewView
            target={target}
            recipients={target.recipients}
            chosen={chosen}
            image={image}
            imageFailed={imageFailed}
            report={report}
            busy={busy}
            outcome={outcome}
            onPick={(blockId) => {
                setChosenId(blockId);
                setOutcome(null);
            }}
            onSend={() => run("send")}
            onCopy={() => run("copy")}
            onBack={onBack}
            onDone={onDone}
        />
    );
}

// Where the zones would go from this page: the checkout it is served from and the project's agents, as the version
// card reads them.
function useAnnotateTarget(url: string): AnnotateTarget {
    const workspace = useAtomValue(atoms.workspace);
    const workspaceDir = readWorkspaceProject(workspace).repo;
    const { answer } = useTestContext(url, workspaceDir);
    const projects = useWorkspaceReviews();
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const locks = useAtomValue(AgentNameLocks.getInstance().locksAtom);
    const sameProject = !!answer?.sameproject;
    const upcomingKnown = projects.find((p) => p.dir === workspaceDir)?.ctx.upcoming != null;
    useEffect(() => {
        // The agents on the branches come with the upcoming work, which the sidebar asks only while PRs are listed.
        if (workspaceDir && sameProject && !upcomingKnown) {
            upcomingGet(workspaceDir).catch(() => {});
        }
    }, [workspaceDir, sameProject, upcomingKnown]);
    return useMemo(
        () => annotateTargetOf({ url, answer, workspaceDir, projects, asks, states, locks }),
        [url, answer, workspaceDir, projects, asks, states, locks]
    );
}

function AnnotateLayer({
    open,
    activeTabId,
    onClose,
}: {
    open: { tabId: string; url: string };
    activeTabId: string;
    onClose: () => void;
}) {
    const t = useT();
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const [capture, setCapture] = useState<string>(null);
    const [state, setState] = useState<AnnotateState>(emptyState);
    const [stage, setStage] = useState<Size>({ w: 0, h: 0 });
    const [drag, setDrag] = useState<{ start: Point; now: Point }>(null);
    const [review, setReview] = useState(false);
    const [leaveAsk, setLeaveAsk] = useState(false);
    const target = useAnnotateTarget(open.url);
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            await settlePaint();
            const rect = rootRef.current?.getBoundingClientRect();
            let url = "";
            try {
                url = rect != null ? await capturePage(rect) : "";
            } catch {
                url = "";
            }
            if (live) {
                setCapture(url);
            }
        });
        return () => {
            live = false;
        };
    }, []);
    useEffect(() => {
        if (capture) {
            rootRef.current?.focus();
        }
    }, [capture]);
    useEffect(() => {
        if (activeTabId !== open.tabId) {
            onClose();
        }
    }, [activeTabId, open.tabId]);
    useEffect(() => {
        const el = stageRef.current;
        if (el == null) {
            return;
        }
        const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [capture]);
    const pointOf = (e: React.PointerEvent): Point => {
        const rect = stageRef.current.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const editing = state.editing != null ? state.zones.find((z) => z.id === state.editing.id) : null;
    const leave = () => (state.zones.length > 0 ? setLeaveAsk(true) : onClose());
    return (
        <div
            ref={rootRef}
            tabIndex={-1}
            className={cn("absolute inset-0 z-20 outline-none select-none", capture == null && "pointer-events-none")}
            aria-label={t("browser.annotate.layerLabel")}
            data-testid="browser-annotate"
            onKeyDown={(e) => {
                const action = layerKeyAction(e.key, { review, leaveAsk, zones: state.zones.length });
                if (action == null) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                if (action === "back") {
                    setReview(false);
                } else if (action === "keep") {
                    setLeaveAsk(false);
                } else if (action === "ask-leave") {
                    setLeaveAsk(true);
                } else {
                    onClose();
                }
            }}
        >
            {capture ? (
                <>
                    <img
                        src={capture}
                        alt=""
                        draggable={false}
                        className="pointer-events-none absolute inset-0 h-full w-full object-fill"
                    />
                    <div
                        className="pointer-events-none absolute inset-0 border-2 border-[var(--mt-action)]"
                        aria-hidden
                    />
                    <div
                        ref={stageRef}
                        className="absolute inset-0 cursor-crosshair touch-none"
                        data-testid="browser-annotate-stage"
                        onPointerDown={(e) => {
                            if (e.button !== 0 || review) {
                                return;
                            }
                            setLeaveAsk(false);
                            setState((s) => (s.editing != null ? cancelEdit(s, s.editing.id) : s));
                            try {
                                e.currentTarget.setPointerCapture(e.pointerId);
                            } catch {
                                // The pointer was released already: the drag still follows the moves the stage gets.
                            }
                            const p = pointOf(e);
                            setDrag({ start: p, now: p });
                        }}
                        onPointerMove={(e) => {
                            if (drag != null) {
                                setDrag({ ...drag, now: pointOf(e) });
                            }
                        }}
                        onPointerUp={(e) => {
                            if (drag == null) {
                                return;
                            }
                            const gesture = gestureOf(drag.start, pointOf(e), stage, state.zones);
                            setDrag(null);
                            if (gesture.kind === "draw") {
                                setState((s) => addZone(s, gesture.rect));
                            } else if (gesture.kind === "edit") {
                                setState((s) => editZone(s, gesture.id));
                            }
                        }}
                        onPointerCancel={() => setDrag(null)}
                    >
                        {state.zones.map((zone, i) => (
                            <ZoneMark
                                key={zone.id}
                                zone={zone}
                                n={i + 1}
                                active={state.editing?.id === zone.id}
                                onEdit={() => setState((s) => editZone(s, zone.id))}
                                onErase={() => setState((s) => eraseZone(s, zone.id))}
                            />
                        ))}
                        {drag != null ? (
                            <div
                                className="pointer-events-none absolute border-2 border-dashed border-[var(--mt-action)]"
                                style={{
                                    left: Math.min(drag.start.x, drag.now.x),
                                    top: Math.min(drag.start.y, drag.now.y),
                                    width: Math.abs(drag.now.x - drag.start.x),
                                    height: Math.abs(drag.now.y - drag.start.y),
                                }}
                            />
                        ) : null}
                    </div>
                    {editing != null && !review ? (
                        <CommentField
                            zone={editing}
                            n={zoneNumber(state, editing.id)}
                            stage={stage}
                            onChange={(comment) => setState((s) => setComment(s, editing.id, comment))}
                            onCommit={() => {
                                setState((s) => commitComment(s, editing.id));
                                rootRef.current?.focus();
                            }}
                            onCancel={() => {
                                setState((s) => cancelEdit(s, editing.id));
                                rootRef.current?.focus();
                            }}
                            onErase={() => {
                                setState((s) => eraseZone(s, editing.id));
                                rootRef.current?.focus();
                            }}
                        />
                    ) : null}
                    {review ? (
                        <Review
                            target={target}
                            zones={state.zones}
                            captureUrl={capture}
                            onBack={() => setReview(false)}
                            onDone={onClose}
                        />
                    ) : (
                        <Tray
                            count={state.zones.length}
                            leaveAsk={leaveAsk}
                            onClear={() => setState((s) => clearAll(s))}
                            onReview={() => {
                                setState((s) => (s.editing != null ? cancelEdit(s, s.editing.id) : s));
                                setReview(true);
                            }}
                            onClose={leave}
                            onDiscard={onClose}
                            onKeep={() => {
                                setLeaveAsk(false);
                                rootRef.current?.focus();
                            }}
                        />
                    )}
                </>
            ) : capture === "" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-surface-2">
                    <div className="flex max-w-sm flex-col items-center gap-3 rounded-6 border border-border bg-surface-3 p-4 text-center text-12 shadow-e2">
                        <p className="leading-4 text-primary">{t("browser.annotate.captureFailed")}</p>
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={onClose}
                        >
                            {t("browser.annotate.close")}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}

// Mounted by the web page panel over its pages: nothing shows until the mode starts.
export function AnnotateHost({ session, activeTabId }: { session: AnnotateSession; activeTabId: string }) {
    const open = useAtomValue(session.openAtom);
    if (open == null) {
        return null;
    }
    return <AnnotateLayer key={open.nonce} open={open} activeTabId={activeTabId} onClose={() => session.close()} />;
}

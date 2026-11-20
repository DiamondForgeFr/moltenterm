// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The review of what will be sent (FR-BRW-017 AC14, AC26, #2327, #2422): the recipient and why, the page, the overview
// and each comment with the image taken of its place, the report as wavesrv writes it, and the click that sends it. The
// images were taken when the review was asked for (annotate-capture.ts); nothing leaves before the click.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { errorPhrase, type Phrase, phrase, useWordPhrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import type { Captured } from "./annotate-capture";
import { callAnnotate, copyTextLater } from "./annotate-client";
import { LinkChips, RefThumbs } from "./annotate-layer-parts";
import {
    addressKey,
    annotateRequest,
    type AnnotateResult,
    type AnnotateTarget,
    linkChip,
    type Recipient,
    refTitleTemplate,
    resolveRecipient,
    sameAddress,
    type Zone,
} from "./annotate-model";
import { NumberBadge, pageLabel, ToolIcons } from "./annotate-toolbar";
import { MaxOverviewScreens } from "./annotate-wire";

// The websocket carries 10 MB: a report with more characters than this is not sent (the images are scaled to fit it, a
// report of many large reference images may not).
export const MaxRequestChars = 9_600_000;

export type Outcome =
    | { kind: "sent"; result: AnnotateResult }
    | { kind: "copied" }
    | { kind: "gone"; name: string }
    | { kind: "refused"; name: string; reason: "workspace" | "project" }
    | { kind: "failed"; text: Phrase };

export type ReviewViewProps = {
    target: AnnotateTarget;
    // The zones as they will be sent: each comment's text, image, links and reference images are shown with the report.
    zones: Zone[];
    recipients: Recipient[];
    chosen: Recipient;
    // The first name of an agent the developer picked that has since gone: nothing is chosen in its place.
    lost: string;
    captured: Captured;
    // links: each zone's links as the brief lists them (wavesrv's answer), so that the review's chips are the brief's.
    report: { text?: string; links?: string[][]; error?: Phrase };
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

// What will be sent: the recipient and why, the page, the images and the report as wavesrv writes it.
export function ReviewView(props: ReviewViewProps) {
    const t = useT();
    const word = useWordPhrase();
    const { target, chosen, recipients, outcome, busy, captured } = props;
    const sent = outcome?.kind === "sent";
    const ready = busy == null && props.report.text != null;
    return (
        <aside
            className="pointer-events-auto absolute inset-y-2 right-2 z-40 flex w-[26rem] max-w-[calc(100%-1rem)] flex-col rounded-4 border border-border bg-surface-3 shadow-e2"
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
                    {props.lost ? (
                        <p
                            className="leading-4 text-[var(--mt-state-warning)]"
                            role="status"
                            data-testid="browser-annotate-lost"
                        >
                            {t("browser.annotate.gone", { name: props.lost })}
                        </p>
                    ) : null}
                    {chosen != null ? (
                        <p className="leading-4 text-secondary" data-testid="browser-annotate-chosen">
                            <span className="font-semibold text-primary">{chosen.name}</span>
                            {" · "}
                            {whyText(t, chosen, target.branch)}
                        </p>
                    ) : recipients.length === 0 ? (
                        <p className="leading-4 text-secondary" data-testid="browser-annotate-noagent">
                            {t("browser.annotate.review.noAgent")}
                        </p>
                    ) : null}
                    {chosen?.lead ? (
                        <p className="text-11 leading-4 text-muted">
                            {t("browser.annotate.review.leadNote", { name: chosen.name })}
                        </p>
                    ) : null}
                    {recipients.length > 1 || (chosen == null && recipients.length > 0) ? (
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
                <section className="flex flex-col gap-1.5" aria-label={t("browser.annotate.review.overview")}>
                    <h4 className="text-11 font-semibold text-muted">{t("browser.annotate.review.overview")}</h4>
                    {captured.overview ? (
                        <img
                            src={captured.overview}
                            alt={t("browser.annotate.review.overview")}
                            className="max-h-72 w-full rounded-4 border border-border object-contain object-top"
                            data-testid="browser-annotate-overview"
                        />
                    ) : (
                        <p className="text-11 leading-4 text-muted" data-testid="browser-annotate-no-overview">
                            {captured.noOverview === "" || captured.noOverview === "none"
                                ? t("browser.annotate.review.noOverview.failed")
                                : t(`browser.annotate.review.noOverview.${captured.noOverview}`, {
                                      screens: MaxOverviewScreens,
                                  })}
                        </p>
                    )}
                </section>
                <section className="flex flex-col gap-2" aria-label={t("browser.annotate.tray.review")}>
                    {props.zones.map((zone, i) => {
                        const links = (props.report.links?.[i] ?? []).map(linkChip);
                        const crop = captured.crops[zone.id];
                        const here = sameAddress(zone.address, target.address);
                        const Icon = ToolIcons[zone.kind];
                        return (
                            <article
                                key={zone.id}
                                className="flex flex-col gap-1.5 rounded-4 border border-border p-2"
                                data-testid="browser-annotate-review-zone"
                            >
                                <header className="flex items-center gap-1.5">
                                    <NumberBadge n={i + 1} />
                                    <Icon size={12} strokeWidth={2} aria-hidden className="shrink-0 text-muted" />
                                    <span className="min-w-0 flex-1 truncate text-11 font-medium text-secondary">
                                        {t("browser.annotate.review.zone", { n: i + 1 })}
                                        {here
                                            ? ""
                                            : ` · ${t("browser.annotate.review.onPage", { page: pageLabel(zone.address) })}`}
                                    </span>
                                </header>
                                {zone.comment.trim() ? (
                                    <p className="leading-4 whitespace-pre-wrap [overflow-wrap:anywhere] text-primary">
                                        {zone.comment.trim()}
                                    </p>
                                ) : null}
                                {crop ? (
                                    <img
                                        src={crop}
                                        alt={t("browser.annotate.review.capture")}
                                        className="w-full rounded-4 border border-border"
                                        data-testid="browser-annotate-crop"
                                    />
                                ) : (
                                    <p className="text-11 leading-4 text-muted" data-testid="browser-annotate-no-crop">
                                        {here
                                            ? t("browser.annotate.review.noImage.failed")
                                            : t("browser.annotate.review.noImage.elsewhere")}
                                    </p>
                                )}
                                <RefThumbs refs={zone.refs} />
                                <LinkChips links={links} />
                            </article>
                        );
                    })}
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
                                    disabled={!ready}
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
                                disabled={!ready}
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
        case "refused":
            text = t(`browser.annotate.refused.${outcome.reason}`, { name: outcome.name });
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

function hostOf(address: string): string {
    try {
        return new URL(address).host;
    } catch {
        return address;
    }
}

// The agent's choice and the report are asked while the review is open; a send, a copy or a different agent never
// reuses an answer of another one. The images are those taken when the review was asked for.
export function Review({
    target,
    zones,
    captured,
    onBack,
    onDone,
}: {
    target: AnnotateTarget;
    zones: Zone[];
    captured: Captured;
    onBack: () => void;
    onDone: () => void;
}) {
    const t = useT();
    const [picked, setPicked] = useState<{ blockId: string; name: string }>(null);
    const [report, setReport] = useState<{ text?: string; links?: string[][]; error?: Phrase }>({});
    const [busy, setBusy] = useState<"send" | "copy">(null);
    const [outcome, setOutcome] = useState<Outcome>(null);
    const { chosen, lost } = resolveRecipient(target.recipients, picked);
    const zonesKey = JSON.stringify(zones.map((z) => [z.id, z.comment.trim(), z.refs.length, z.address]));
    const lead = !!chosen?.lead;
    useEffect(() => {
        let live = true;
        setReport({});
        fireAndForget(async () => {
            try {
                const answer = await callAnnotate(
                    annotateRequest("preview", target, zones, {
                        to: chosen ?? undefined,
                        overview: captured.overview,
                        captures: captured.crops,
                    })
                );
                if (live) {
                    setReport({ text: answer.text ?? "", links: answer.links ?? [] });
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
    }, [zonesKey, lead, target.address, target.branch, target.root, captured]);
    const refTitle = refTitleTemplate(t);
    const captureTitle = t("browser.annotate.captureTitle", { zone: "{zone}" });
    const title = t("browser.annotate.materialTitle", { where: target.branch || hostOf(addressKey(target.address)) });
    const run = (kind: "send" | "copy") => {
        if (busy != null || (kind === "send" && chosen == null)) {
            return;
        }
        const request = annotateRequest(kind, target, zones, {
            title,
            refTitle,
            captureTitle,
            overview: captured.overview,
            captures: captured.crops,
            to: chosen ?? undefined,
        });
        if (JSON.stringify(request).length > MaxRequestChars) {
            setOutcome({ kind: "failed", text: phrase("browser.annotate.review.tooLarge") });
            return;
        }
        setBusy(kind);
        setOutcome(null);
        fireAndForget(async () => {
            try {
                const answer = callAnnotate(request);
                if (kind === "copy") {
                    // Started now, inside the click: the clipboard is written when the report is there.
                    await copyTextLater(answer.then((result) => result.text ?? ""));
                    setOutcome({ kind: "copied" });
                    return;
                }
                const result = await answer;
                if (result.status === "noagent") {
                    setOutcome({ kind: "gone", name: chosen?.name ?? "" });
                } else if (result.status === "refused") {
                    setOutcome({ kind: "refused", name: chosen?.name ?? "", reason: result.reason });
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
            zones={zones}
            recipients={target.recipients}
            chosen={chosen}
            lost={lost}
            captured={captured}
            report={report}
            busy={busy}
            outcome={outcome}
            onPick={(blockId) => {
                const r = target.recipients.find((x) => x.blockId === blockId);
                setPicked(r != null ? { blockId, name: r.name } : null);
                setOutcome(null);
            }}
            onSend={() => run("send")}
            onCopy={() => run("copy")}
            onBack={onBack}
            onDone={onDone}
        />
    );
}

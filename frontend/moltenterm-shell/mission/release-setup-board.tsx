// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The setup's agent board in the panel (FR-MC-045, #1163): the window publishes what the developer sees, follows the
// board live, and shows each proposal of the terminal's agent as a card the developer accepts or declines. Every
// change happens before the developer's eyes through the app's molten motion (molten-motion.ts).

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { flowClass, useFlowList } from "../molten-motion";
import { MissionRouteId } from "./mission-client";
import {
    acceptedKeys,
    BoardApplied,
    BoardContext,
    BoardItem,
    BoardState,
    changeSentence,
    contextSignature,
} from "./release-setup-board-model";

// must match pkg/molten/mission/setupboard.go
export const SetupBoardEvent = "molten:pipelinesetup:board";
export const SetupBoardOpenCommand = "moltenmissionsetupboardopen";
export const SetupBoardCloseCommand = "moltenmissionsetupboardclose";
export const SetupBoardStateCommand = "moltenmissionsetupboardstate";
export const SetupBoardDecideCommand = "moltenmissionsetupboarddecide";
export const SetupBoardApplyCommand = "moltenmissionsetupboardapply";
export const SetupBoardCopyCommand = "moltenmissionsetupboardcopy";

const BoardTimeoutMs = 15000;

function boardCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout: BoardTimeoutMs });
}

export function setupBoardOpen(context: BoardContext): Promise<BoardState> {
    return boardCall(SetupBoardOpenCommand, context);
}

export function setupBoardClose(dir: string): Promise<BoardState> {
    return boardCall(SetupBoardCloseCommand, { dir });
}

export function setupBoardDecide(dir: string, key: string, accept: boolean): Promise<BoardState> {
    return boardCall(SetupBoardDecideCommand, { dir, key, accept });
}

export function setupBoardCopy(dir: string, key: string): Promise<BoardState> {
    return boardCall(SetupBoardCopyCommand, { dir, key });
}

export function setupBoardApply(dir: string, text: string): Promise<BoardApplied> {
    return boardCall(SetupBoardApplyCommand, { dir, text });
}

export type SetupBoard = {
    state: BoardState;
    error: string;
    busy: string;
    // Publishes what the developer sees; the same context twice is sent once.
    publish: (context: BoardContext) => void;
    decide: (key: string, accept: boolean) => void;
    // "Apply to the other version too".
    copy: (key: string) => void;
};

function newer(prev: BoardState, next: BoardState): boolean {
    if (next == null) {
        return false;
    }
    if (prev == null || !next.open || !prev.open) {
        return true;
    }
    return next.seq >= prev.seq;
}

// useSetupBoard opens the board while the setup panel shows dir, follows it live, and closes it when the panel goes:
// nothing the agent proposed outlives the setup.
export function useSetupBoard(dir: string): SetupBoard {
    const [state, setState] = useState<BoardState>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState<string>(null);
    const sent = useRef("");
    const take = (next: BoardState) => setState((prev) => (newer(prev, next) ? next : prev));
    useEffect(() => {
        if (!dir) {
            return;
        }
        sent.current = "";
        setState(null);
        const unsubscribe = waveEventSubscribeSingle({
            eventType: SetupBoardEvent as WaveEventName,
            scope: dir,
            handler: (event) => take(event.data as BoardState),
        });
        return () => {
            unsubscribe();
            fireAndForget(async () => {
                try {
                    await setupBoardClose(dir);
                } catch (e) {
                    console.log("setup board close:", e?.message ?? e);
                }
            });
        };
    }, [dir]);
    const publish = (context: BoardContext) => {
        const signature = contextSignature(context);
        if (!dir || context.dir !== dir || signature === sent.current) {
            return;
        }
        sent.current = signature;
        fireAndForget(async () => {
            try {
                take(await setupBoardOpen(context));
            } catch (e) {
                sent.current = "";
                console.log("setup board open:", e?.message ?? e);
            }
        });
    };
    const decide = (key: string, accept: boolean) =>
        fireAndForget(async () => {
            setBusy(key);
            setError(null);
            try {
                take(await setupBoardDecide(dir, key, accept));
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(null);
            }
        });
    const copy = (key: string) =>
        fireAndForget(async () => {
            setBusy(key);
            setError(null);
            try {
                take(await setupBoardCopy(dir, key));
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(null);
            }
        });
    return { state, error, busy, publish, decide, copy };
}

// useBoardText: the base draft with the accepted changes on it, null while none is accepted (the base is the text).
export function useBoardText(dir: string, base: string, state: BoardState): BoardApplied {
    const [applied, setApplied] = useState<BoardApplied>(null);
    const keys = acceptedKeys(state).join(",");
    useEffect(() => {
        if (!dir || !base || keys === "") {
            setApplied(null);
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const answer = await setupBoardApply(dir, base);
                if (!cancelled) {
                    setApplied(answer);
                }
            } catch (e) {
                console.log("setup board apply:", e?.message ?? e);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, base, keys]);
    return keys === "" ? null : applied;
}

function ByLine({ by }: { by?: string }) {
    const t = useT();
    return (
        <span className="text-11 font-medium text-accent" data-testid="board-by">
            {by ? t("mc.setup.board.proposedBy", { name: by }) : t("mc.setup.board.proposedByAgent")}
        </span>
    );
}

const SecondaryButton =
    "cursor-pointer rounded-4 border border-border px-2.5 py-1 text-11 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const PrimaryButton =
    "molten-btn cursor-pointer rounded-4 px-2.5 py-1 text-11 disabled:cursor-default disabled:opacity-50";

function ChangeCard({ item, busy, onDecide }: { item: BoardItem; busy: boolean; onDecide: (accept: boolean) => void }) {
    const t = useT();
    const sentence = changeSentence(item);
    const c = item.change;
    const where = c?.channel ? t(`mc.setup.plain.changes.in.${c.channel}`) : "";
    return (
        <div
            className="flex flex-col gap-1.5 rounded-4 border border-accent/50 bg-accent/5 px-3 py-2"
            data-testid={`board-card-${item.key}`}
            data-kind="change"
        >
            <ByLine by={item.by} />
            <div className="text-12 font-medium text-primary" data-testid="board-card-what">
                {t(sentence.key, sentence.vars)}
                {where ? <span className="font-normal text-muted"> · {where}</span> : null}
            </div>
            {item.why ? (
                <p className="text-12 text-secondary" data-testid="board-card-why">
                    {item.why}
                </p>
            ) : null}
            {c?.oldtext || c?.newtext ? (
                <details className="text-11">
                    <summary className="cursor-pointer text-muted">{t("mc.setup.board.details")}</summary>
                    <div className="mt-1 flex flex-col gap-1">
                        {c.oldtext ? (
                            <div>
                                <span className="text-muted">{t("mc.setup.board.before")}</span>
                                <pre className="font-mono whitespace-pre-wrap text-muted wrap-anywhere">
                                    {c.oldtext}
                                </pre>
                            </div>
                        ) : null}
                        {c.newtext ? (
                            <div>
                                <span className="text-muted">{t("mc.setup.board.after")}</span>
                                <pre className="font-mono whitespace-pre-wrap text-primary wrap-anywhere">
                                    {c.newtext}
                                </pre>
                            </div>
                        ) : null}
                    </div>
                </details>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                    type="button"
                    className={PrimaryButton}
                    disabled={busy}
                    onClick={() => onDecide(true)}
                    data-testid="board-accept"
                >
                    {t("mc.setup.board.accept")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    className={SecondaryButton}
                    disabled={busy}
                    onClick={() => onDecide(false)}
                    data-testid="board-decline"
                >
                    {t("mc.setup.board.decline")}
                </button>
            </div>
        </div>
    );
}

function FlagCard({
    item,
    busy,
    onDecide,
    stepNumber,
}: {
    item: BoardItem;
    busy: boolean;
    onDecide: (accept: boolean) => void;
    stepNumber?: (ref: string) => number;
}) {
    const t = useT();
    const n = item.step ? stepNumber?.(item.step) : null;
    return (
        <div
            className="flex flex-col gap-1.5 rounded-4 border border-border px-3 py-2"
            data-testid={`board-card-${item.key}`}
            data-kind="flag"
        >
            <span className="flex flex-wrap items-center gap-2">
                <ByLine by={item.by} />
                <span className="text-11 text-warning">{t("mc.setup.board.flag.title")}</span>
                {n ? <span className="text-11 text-muted">{t("mc.setup.board.stepRef", { n })}</span> : null}
            </span>
            <p className="text-12 text-primary" data-testid="board-card-point">
                {item.point}
            </p>
            {item.answer ? (
                <p className="text-12 text-secondary" data-testid="board-card-answer">
                    {t("mc.setup.board.flag.answer", { answer: item.answer })}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                    type="button"
                    className={SecondaryButton}
                    disabled={busy}
                    onClick={() => onDecide(true)}
                    data-testid="board-keep"
                >
                    {item.answer ? t("mc.setup.board.flag.keep") : t("mc.setup.board.flag.noted")}
                </button>
                <button
                    type="button"
                    className={SecondaryButton}
                    disabled={busy}
                    onClick={() => onDecide(false)}
                    data-testid="board-dismiss"
                >
                    {t("mc.setup.board.flag.dismiss")}
                </button>
            </div>
        </div>
    );
}

const itemKey = (item: BoardItem) => item.key;

// BoardCards: the open proposals and flags, each growing into place as it arrives and melting out once decided or
// withdrawn.
export function BoardCards({
    items,
    board,
    className,
    testId,
    stepNumber,
}: {
    items: BoardItem[];
    board: SetupBoard;
    className?: string;
    testId?: string;
    // The number the screen shows for a flag's step ("public/tag").
    stepNumber?: (ref: string) => number;
}) {
    const rows = useFlowList(items, itemKey);
    if (rows.length === 0) {
        return null;
    }
    return (
        <div className={cn("flex flex-col", className)} data-testid={testId ?? "board-cards"}>
            {rows.map((row) => (
                <div key={row.key} className={cn("pb-2", flowClass(row.phase))} data-phase={row.phase}>
                    <div>
                        {row.item.kind === "flag" ? (
                            <FlagCard
                                item={row.item}
                                stepNumber={stepNumber}
                                busy={board.busy === row.key || row.phase === "exit"}
                                onDecide={(accept) => board.decide(row.key, accept)}
                            />
                        ) : (
                            <ChangeCard
                                item={row.item}
                                busy={board.busy === row.key || row.phase === "exit"}
                                onDecide={(accept) => board.decide(row.key, accept)}
                            />
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}

// The board's own block, for the screens that have no channel blocks to hold the cards: the general items, or all.
export function BoardSection({ board, items }: { board: SetupBoard; items: BoardItem[] }) {
    const t = useT();
    const shown = useMemo(() => items ?? [], [items]);
    if (shown.length === 0 && !board.error) {
        return null;
    }
    return (
        <div className="flex flex-col gap-1.5" data-testid="board-section">
            <div className="flex flex-col gap-0.5">
                <span className="text-11 font-medium text-secondary uppercase">{t("mc.setup.board.title")}</span>
                <span className="text-11 text-muted">{t("mc.setup.board.hint")}</span>
            </div>
            {board.error ? (
                <p className="text-12 text-danger" role="alert" data-testid="board-error">
                    {board.error}
                </p>
            ) : null}
            <BoardCards items={shown} board={board} />
        </div>
    );
}

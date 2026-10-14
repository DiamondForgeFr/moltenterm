// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The one path of the review actions that type into the PR's session (#638): Ask the AI, Discuss and the translation
// request of Publish review. A session one of them just started has an agent that is not ready for a typed prompt
// yet: wavesrv types nothing and answers starting (pkg/molten/reviewsession/ready.go), and the action is sent again
// until the agent takes it. When the session ends first, nothing is sent and the developer is told.

import { t } from "../i18n/i18n";

// What an action sends: the key of its messages under review.ready (each language words it on its own).
export type ReadyWhat = "question" | "comment" | "translation";

// Long enough for wavesrv's own grace (30 s from the session's start), after which it never answers starting.
export const ReadyDeadlineMs = 45_000;
export const ReadyRetryMs = 1_000;

// What every review action's answer says of a starting agent.
export type ReadyAnswer = { starting?: boolean; message?: string };

export type SendWhenReadyOptions = {
    // what: the thing sent, for the messages.
    what: ReadyWhat;
    // alive: the session the action was sent to still runs.
    alive: () => boolean;
    // onWaiting is called each time the agent answers it is starting.
    onWaiting?: (message: string) => void;
    retryMs?: number;
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
};

export type SendWhenReadyOutcome<T> = { result: T; dropped?: undefined } | { result?: undefined; dropped: string };

function sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function endedMessage(what: ReadyWhat): string {
    return t(`review.ready.ended.${what}`);
}

export function notReadyMessage(what: ReadyWhat): string {
    return t(`review.ready.notReady.${what}`, { seconds: Math.round(ReadyDeadlineMs / 1000) });
}

// sendWhenReady sends, then sends again while the session's agent is starting; the agent's first other answer is
// the outcome. dropped: the session ended, or the agent never got ready, before it took it.
export async function sendWhenReady<T extends ReadyAnswer>(
    send: () => Promise<T>,
    opts: SendWhenReadyOptions
): Promise<SendWhenReadyOutcome<T>> {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? sleepMs;
    const deadline = now() + (opts.deadlineMs ?? ReadyDeadlineMs);
    let result = await send();
    while (result?.starting) {
        opts.onWaiting?.(result.message ?? "");
        if (now() >= deadline) {
            return { dropped: notReadyMessage(opts.what) };
        }
        await sleep(opts.retryMs ?? ReadyRetryMs);
        if (!opts.alive()) {
            return { dropped: endedMessage(opts.what) };
        }
        result = await send();
    }
    return { result };
}

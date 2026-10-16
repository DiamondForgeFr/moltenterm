// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as client from "../../frontend/moltenterm-shell/mission/mission-client";
import { polls, requests, subscriptions } from "./mission-hooks-mocks";

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let latest: any;
let frames: any[] = [];
function Probe({ dir, bump = "" }: { dir: string; bump?: string }) {
    const snapshot = client.useMissionSnapshot(dir);
    const runs = client.useMissionRuns(dir);
    const ci = client.useCiState(dir);
    const release = client.useReleaseSession(dir);
    const facts = client.useReleaseFacts(dir, bump);
    latest = { dir, snapshot, runs, ci, release, facts };
    frames.push(latest);
    return <pre>{JSON.stringify(latest)}</pre>;
}

function check(condition: unknown, message: string) {
    if (!condition) throw new Error(message + "\n" + host.innerText);
}
const change = async (dir: string, bump = "") => {
    await act(async () =>
        root.render(
            <StrictMode>
                <Probe dir={dir} bump={bump} />
            </StrictMode>
        )
    );
};
const take = (command: string, dir: string) => {
    const pending = requests.filter((r) => r.command === command && r.dir === dir && !r.settled);
    const request = pending.at(-1);
    check(request, `missing request ${command} ${dir}`);
    request.settled = true;
    return request;
};
const resolve = async (request: ReturnType<typeof take>, value: any) => {
    await act(async () => request.resolve(value));
};
const reject = async (request: ReturnType<typeof take>) => {
    await act(async () => request.reject(new Error("obsolete")));
};
const event = async (eventType: string, dir: string, data: any) => {
    await act(async () =>
        subscriptions
            .filter((s) => !s.stopped && s.eventType === eventType && s.scope === dir)
            .forEach((s) => s.handler({ data }))
    );
};
const snap = (dir: string, marker: string) => ({ dir, marker });
const run = (dir: string, id: string, startedat: number, state = "running") => ({ dir, id, startedat, state });
const ciRun = (dir: string, id: string, status = "running") => ({ dir, id, startedat: 1, status, jobs: [] });

export async function runMissionChecks() {
    const passed: string[] = [];
    await change("A");
    const oldSnapshot = take(client.MissionGetCommand, "A");
    const oldRuns = take(client.MissionRunsCommand, "A");
    const oldCi = take(client.MissionCiStateCommand, "A");
    const oldRelease = take(client.MissionReleaseCommand, "A");
    const oldFacts = take(client.MissionReleaseFactsCommand, "A");
    const oldRefresh = latest.snapshot.refresh;
    await resolve(oldSnapshot, snap("A", "cached"));
    await act(async () => latest.snapshot.refresh());
    const oldSnapshotError = take(client.MissionRefreshCommand, "A");
    await act(async () => latest.snapshot.refresh());
    const oldSnapshotSuccess = take(client.MissionRefreshCommand, "A");
    frames = [];
    await change("B");
    check(
        frames.every(
            (f) =>
                f.snapshot.snapshot == null &&
                f.runs.length === 0 &&
                f.ci.state == null &&
                f.release.session == null &&
                f.facts.facts == null
        ),
        "first B render leaks A values"
    );
    await resolve(take(client.MissionGetCommand, "B"), snap("B", "fresh"));
    await resolve(take(client.MissionCiStateCommand, "B"), { runs: [], branches: [], current: "B" });
    await resolve(take(client.MissionReleaseCommand, "B"), { tag: "B" });
    await resolve(take(client.MissionReleaseFactsCommand, "B"), { tag: "B" });
    await resolve(oldRuns, [run("A", "obsolete", 1)]);
    await resolve(oldCi, { runs: [], branches: [], current: "A" });
    await reject(oldRelease);
    await resolve(oldFacts, { tag: "A" });
    await resolve(oldSnapshotSuccess, snap("A", "obsolete"));
    await reject(oldSnapshotError);
    check(
        latest.snapshot.snapshot.marker === "fresh" &&
            latest.ci.state.current === "B" &&
            latest.release.session.tag === "B" &&
            latest.facts.facts.tag === "B" &&
            latest.runs.length === 0,
        "obsolete A completion changed B"
    );
    const beforeOldRefresh = requests.length;
    oldRefresh();
    check(requests.length === beforeOldRefresh, "obsolete refresh started work");
    passed.push("project changes mask values before effects and reject obsolete success/failure");

    await change("C");
    const initial = take(client.MissionGetCommand, "C");
    await event(client.MissionUpdateEvent, "C", snap("C", "event"));
    await resolve(initial, snap("C", "old"));
    check(latest.snapshot.snapshot.marker === "event", "initial read overwrote event");
    await act(async () => latest.snapshot.refresh());
    const firstRefresh = take(client.MissionRefreshCommand, "C");
    await act(async () => latest.snapshot.refresh());
    const secondRefresh = take(client.MissionRefreshCommand, "C");
    await resolve(secondRefresh, snap("C", "latest"));
    await reject(firstRefresh);
    check(latest.snapshot.snapshot.marker === "latest" && latest.snapshot.error == null, "older refresh error won");
    await act(async () => latest.snapshot.refresh());
    const failed = take(client.MissionRefreshCommand, "C");
    await reject(failed);
    check(
        latest.snapshot.error === "obsolete" && latest.snapshot.snapshot.marker === "latest",
        "cached snapshot lost on error"
    );
    await event(client.MissionUpdateEvent, "C", snap("C", "recovered"));
    check(latest.snapshot.error == null, "event did not clear obsolete error");
    passed.push("snapshot events, overlapping refreshes, cached data and error recovery");

    await event(client.MissionRunEvent, "C", { ...run("C", "updated", 2, "success"), closed: true });
    await event(client.MissionRunEvent, "C", run("C", "event-only", 3));
    await resolve(take(client.MissionRunsCommand, "C"), [run("C", "history", 1), run("C", "updated", 2)]);
    check(
        latest.runs.map((r: any) => r.id).join() === "event-only,updated,history" && latest.runs[1].closed,
        "runs history/event merge lost records"
    );
    passed.push("run events merge with initial history without losing terminal or hidden state");

    const initialCi = take(client.MissionCiStateCommand, "C");
    await event(client.MissionCiEvent, "C", ciRun("C", "run"));
    await resolve(initialCi, { runs: [], branches: [{ name: "main" }], current: "C" });
    check(
        latest.ci.state.running === "run" && latest.ci.state.branches[0].name === "main",
        "CI event before initial state lost"
    );
    await act(async () => latest.ci.reload());
    const olderCi = take(client.MissionCiStateCommand, "C");
    await event(client.MissionCiEvent, "C", ciRun("C", "run", "success"));
    const newerCi = take(client.MissionCiStateCommand, "C");
    await resolve(newerCi, { runs: [ciRun("C", "run", "success")], branches: [], current: "new" });
    await resolve(olderCi, { runs: [ciRun("C", "run")], running: "run", branches: [], current: "old" });
    check(latest.ci.state.current === "new" && !latest.ci.state.running, "old CI result resurrected running state");
    passed.push("CI buffering and terminal-event reload ordering");

    await act(async () => latest.release.reload());
    const firstRelease = take(client.MissionReleaseCommand, "C");
    await act(async () => latest.release.reload());
    await resolve(take(client.MissionReleaseCommand, "C"), { tag: "latest" });
    await reject(firstRelease);
    check(latest.release.session.tag === "latest", "old release error cleared latest session");
    const factsBeforeBump = take(client.MissionReleaseFactsCommand, "C");
    await change("C", "bumped");
    await resolve(take(client.MissionReleaseFactsCommand, "C"), { tag: "bumped" });
    await resolve(factsBeforeBump, { tag: "old" });
    check(latest.facts.facts.tag === "bumped", "old release facts won after bump");
    passed.push("release refresh/error and facts bump ownership");

    await change("A");
    const firstA = take(client.MissionGetCommand, "A");
    await change("B");
    await change("A");
    await resolve(take(client.MissionGetCommand, "A"), snap("A", "second A"));
    await resolve(firstA, snap("A", "first A"));
    check(latest.snapshot.snapshot.marker === "second A", "A-to-B-to-A revived old A");
    const saved = latest;
    const pendingAtCleanup = take(client.MissionGetCommand, "B");
    await change("");
    check(
        latest.snapshot.snapshot == null &&
            latest.runs.length === 0 &&
            latest.ci.state == null &&
            latest.release.session == null &&
            latest.facts.facts == null,
        "empty directory retains project values"
    );
    check(
        subscriptions.every((s) => s.stopped) && polls.every((p) => p.stopped),
        "empty directory installs subscriptions or polling"
    );
    await act(async () => root.unmount());
    check(
        subscriptions.every((s) => s.stopped) && polls.every((p) => p.stopped),
        "cleanup leaked subscriptions or timers"
    );
    const count = requests.length;
    await act(async () => {
        saved.snapshot.refresh();
        saved.ci.reload();
        saved.release.reload();
        saved.facts.reload();
        polls.forEach((p) => p.callback());
        subscriptions.forEach((s) =>
            s.handler({
                data: s.eventType === client.MissionCiEvent ? ciRun(s.scope, "late", "success") : snap(s.scope, "late"),
            })
        );
    });
    await reject(pendingAtCleanup);
    check(requests.length === count, "callback after cleanup issued a new request");
    passed.push("A-to-B-to-A, StrictMode replay, disposed callbacks and pending cleanup");
    return passed;
}

(globalThis as any).runMissionChecks = runMissionChecks;

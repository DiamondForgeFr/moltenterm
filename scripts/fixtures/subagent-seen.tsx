// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { Provider } from "jotai";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { globalStore } from "../../frontend/app/store/jotaiStore";
import { AgentInfoModel } from "../../frontend/moltenterm-shell/agent-info/agent-info-store";
import { SubagentInfoWindow } from "../../frontend/moltenterm-shell/agent-info/subagent-info-window";
import { activity, companion } from "./subagent-seen-mocks";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mount = document.createElement("main");
document.body.append(mount);
const root = createRoot(mount);
const model = AgentInfoModel.getInstance();
function check(value: unknown, message: string) {
    if (!value) throw new Error(message);
}
function view(state: string, ended = 0) {
    return {
        blockid: "b1",
        version: 1,
        subagents: [{ id: "s1", description: "Task", kind: "worker", state, started: 1, ended }],
    };
}
async function runChecks() {
    globalStore.set(model.seenSubsAtom, {});
    globalStore.set(companion, view("running"));
    await act(async () => {
        model.openSub("b1", "s1");
        root.render(
            <Provider store={globalStore}>
                <SubagentInfoWindow blockId="b1" subId="s1" onClose={() => model.closeSub()} />
            </Provider>
        );
    });
    check(globalStore.get(model.seenSubsAtom).b1 == null, "running card acknowledged an error");
    await act(async () => {
        globalStore.set(activity, "hidden");
        globalStore.set(companion, view("failed", 2));
    });
    check(globalStore.get(model.seenSubsAtom).b1 == null, "hidden card acknowledged a failure");
    await act(async () => globalStore.set(activity, "active"));
    check(globalStore.get(model.seenSubsAtom).b1?.s1 === "1:2", "visible card did not acknowledge the failure");
    await act(async () => {
        globalStore.set(companion, view("failed", 3));
    });
    check(globalStore.get(model.seenSubsAtom).b1?.s1 === "1:3", "open card missed the next failure");
    await act(async () => {
        model.closeSub();
        root.unmount();
    });
    return "PASS: mounted running, hidden failure, visible failure, and later occurrence";
}
Object.assign(globalThis, { runSubagentSeenChecks: runChecks });

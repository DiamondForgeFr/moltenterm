// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useMaterialsDrawer } from "./use-materials-drawer";

(window as any).IS_REACT_ACT_ENVIRONMENT = true;
const requests: any[] = [];
let listener: any = null;
(window as any).testRpc = (_command: string, data: any) =>
    new Promise((resolve, reject) => requests.push({ data, resolve, reject }));
(window as any).testSubscribe = ({ handler }: any) => {
    listener = handler;
    return () => {
        if (listener === handler) listener = null;
    };
};
const root = createRoot(document.getElementById("root"));
let state: any;
function Drawer({ workspace }: { workspace: string }) {
    state = useMaterialsDrawer(workspace);
    return <div>{JSON.stringify(state)}</div>;
}
const check = (condition: boolean, label: string) => {
    if (!condition) throw new Error(label);
};
const event = () => listener({ data: { project: "p" } });
(window as any).runChecks = async () => {
    await act(async () => {
        root.render(<Drawer workspace="a" />);
    });
    await act(async () => {
        requests[0].resolve({ project: { key: "p" }, materials: [] });
    });
    await act(async () => {
        listener({ data: { project: "other" } });
    });
    check(requests.length === 1, "unrelated project triggered a refresh");
    await act(async () => {
        event();
    });
    await act(async () => {
        event();
        event();
    });
    if ((window as any).testBaseline) {
        check(requests.length === 4, "baseline did not overlap requests");
        await act(async () => {
            requests[3].resolve({ project: { key: "p" }, materials: [] });
        });
        await act(async () => {
            requests[1].resolve({ project: { key: "p" }, materials: [{ id: "deleted" }] });
        });
        check(state.view.materials[0]?.id === "deleted", "baseline did not reproduce stale display");
        await act(async () => {
            root.unmount();
        });
        return { outcome: "BASELINE_STALE_REPRODUCED" };
    }
    check(requests.length === 2, `event burst started ${requests.length - 1} simultaneous refreshes`);
    await act(async () => {
        requests[1].resolve({ project: { key: "p" }, materials: [{ id: "deleted" }] });
    });
    check(state.view.materials.length === 0, "invalidated snapshot reappeared");
    check(requests.length === 3, "missing trailing request");
    await act(async () => {
        requests[2].resolve({ project: { key: "p" }, materials: [] });
    });
    await act(async () => {
        event();
    });
    await act(async () => {
        root.render(<Drawer workspace="b" />);
    });
    check(state.view === null, "old workspace remained visible");
    check(requests.length === 4, "workspace change started overlapping request");
    await act(async () => {
        requests[3].resolve({ project: { key: "p" }, materials: [{ id: "old-a" }] });
    });
    check(requests.length === 5 && requests[4].data.workspaceid === "b", "new workspace not requested");
    check(state.view === null, "old workspace response published");
    await act(async () => {
        root.render(<Drawer workspace="a" />);
    });
    check(state.view === null, "returning to A revived its old data");
    await act(async () => {
        requests[4].resolve({ project: { key: "p" }, materials: [{ id: "old-b" }] });
    });
    check(state.view === null && requests[5].data.workspaceid === "a", "late B published after returning to A");
    await act(async () => {
        requests[5].resolve({ project: { key: "p" }, materials: [] });
    });
    await act(async () => {
        event();
    });
    await act(async () => {
        requests[6].reject(new Error("current error"));
    });
    check(state.failed === true, "current error missing");
    await act(async () => {
        event();
    });
    await act(async () => {
        requests[7].resolve({ project: { key: "p" }, materials: [{ id: "new" }] });
    });
    check(!state.failed && state.view.materials[0].id === "new", "error recovery failed");
    await act(async () => {
        root.render(<Drawer workspace="c" />);
    });
    await act(async () => {
        root.render(<Drawer workspace="a" />);
    });
    check(state.view === null, "returning workspace revived old data");
    await act(async () => {
        requests[8].resolve({ project: { key: "p" }, materials: [{ id: "wrong" }] });
    });
    check(state.view === null && requests[9].data.workspaceid === "a", "stale workspace published");
    await act(async () => {
        requests[9].resolve({ project: { key: "p" }, materials: [] });
    });
    await act(async () => {
        event();
    });
    await act(async () => {
        root.unmount();
    });
    check(listener === null, "subscription survived unmount");
    await act(async () => {
        requests[10].resolve({ project: { key: "p" }, materials: [{ id: "late" }] });
    });
    return { requests: requests.length, outcome: "PASS" };
};

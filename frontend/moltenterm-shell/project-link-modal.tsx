// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Linking a project from the terminal (#77): when the focused terminal of a workspace without a project goes into a
// project's folder, a modal offers to link it and to name the workspace after it. A linked workspace that still shows
// its own icon then gets the project icon offer, a toast with the image's thumbnail and only when the project has one
// (FR-SHELL-059, project-icon-offer.ts). Only the visible window offers: the views MoltenTerm keeps for other
// workspaces stay quiet.

import { atoms, getApi } from "@/app/store/global";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MoltenWave } from "./molten-button";
import { hasDefaultName, nextProjectOffer, ProjectOffer, readDismissed, withDismissed } from "./project-detect";
import { offerProjectIcon } from "./project-icon-offer";
import { WorkspaceEditModel } from "./workspace-edit";
import { hasImportedIcon } from "./workspace-icon-model";
import { nextWorkspaceFolder, pathBaseName, readWorkspaceFolder, readWorkspaceProject } from "./workspace-project";
import {
    dismissProject,
    findOfferedProject,
    linkWorkspaceProject,
    readProjectFacts,
    renameWorkspace,
    setWorkspaceFolder,
} from "./workspace-project-store";

const NoFocusedNode = atom(null) as Atom<{ data?: { blockId?: string } }>;

const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

// Reports the folder of a local terminal block as the shell moves (shell integration updates cmd:cwd).
function TerminalFolder({ blockId, onFolder }: { blockId: string; onFolder: (cwd: string) => void }) {
    const [block] = useWaveObjectValue<Block>(makeORef("block", blockId));
    const view = block?.meta?.view;
    const connection = block?.meta?.connection ?? "";
    const cwd = block?.meta?.["cmd:cwd"] ?? "";
    useEffect(() => {
        const local = connection === "" || connection === "local";
        onFolder(view === "term" && local ? cwd : "");
    }, [view, connection, cwd, onFolder]);
    return null;
}

function ProjectLinkModal({ offer, ws, onClose }: { offer: ProjectOffer; ws: Workspace; onClose: () => void }) {
    const [name, setName] = useState(pathBaseName(offer.dir));
    const [rename, setRename] = useState(hasDefaultName(ws.name));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        fireAndForget(async () => {
            const facts = await readProjectFacts(offer.dir);
            setName(facts.name);
        });
    }, [offer.dir]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                decline();
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    });
    const run = (fn: () => Promise<void>) =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                await fn();
                onClose();
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setBusy(false);
            }
        });
    const accept = () =>
        run(async () => {
            await linkWorkspaceProject(ws, offer.dir);
            if (rename && name) {
                await renameWorkspace(ws, name);
            }
        });
    // "Not now" is remembered for this folder in this workspace.
    const decline = () =>
        run(() => dismissProject(ws.oid, withDismissed(readDismissed(ws.meta as Record<string, any>), offer.dir)));
    return createPortal(
        <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40">
            <div
                role="dialog"
                aria-modal="true"
                aria-label={`Link this workspace to ${name}?`}
                className="flex w-[460px] flex-col rounded-10 border border-border bg-surface-3 shadow-e3"
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-13 leading-5 font-semibold">{`Link this workspace to ${name}?`}</div>
                    <div className="mt-0.5 truncate text-12 text-muted" title={offer.dir}>
                        {offer.dir}
                    </div>
                </div>
                <div className="flex flex-col gap-3 px-4 py-3 text-12">
                    <div className="text-secondary">
                        A terminal of this workspace is in this project. Linked, the workspace shows it in Mission
                        Control (Project, CI/CD).
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-secondary">
                        <input type="checkbox" checked={rename} onChange={(e) => setRename(e.target.checked)} />
                        Name the workspace “{name}”
                        {ws.name ? <span className="text-muted">(now “{ws.name}”)</span> : null}
                    </label>
                    {error ? <div className="text-error">{error}</div> : null}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                    <button type="button" disabled={busy} onClick={decline} className={PlainButton}>
                        Not now
                    </button>
                    <button type="button" disabled={busy} onClick={accept} className={AccentButton}>
                        Link the project
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

export function ProjectLinkDetector() {
    const ws = useAtomValue(atoms.workspace);
    const staticTabId = useAtomValue(atoms.staticTabId);
    // Waits for Wave's own modals (the welcome tour, About…) to close.
    const waveModalOpen = useAtomValue(atoms.modalOpen);
    // The edit sheet lists the project's images itself: the icon offer waits until it closes.
    const editing = useAtomValue(WorkspaceEditModel.getInstance().requestAtom) != null;
    const focusedAtom = useMemo(() => getLayoutModelForStaticTab()?.focusedNode ?? NoFocusedNode, []);
    const focused = useAtomValue(focusedAtom);
    const blockId = focused?.data?.blockId;
    const [terminalProject, setTerminalProject] = useState("");
    const [terminalFolder, setTerminalFolder] = useState("");
    const [shown, setShown] = useState<ProjectOffer>(null);
    // Offers made in this session: the workspace's meta takes a moment to reflect the answer, and an icon offer that
    // left unanswered waits for a later session.
    const [answered, setAnswered] = useState<string[]>([]);
    const onFolder = useMemo(
        () => (cwd: string) => {
            setTerminalFolder(cwd);
            if (!cwd) {
                setTerminalProject("");
                return;
            }
            fireAndForget(async () => setTerminalProject(await findOfferedProject(cwd)));
        },
        []
    );
    const project = readWorkspaceProject(ws);
    const folder = readWorkspaceFolder(ws);
    const dismissed = readDismissed(ws?.meta as Record<string, any>);
    // A view kept for another workspace (#68) still sees the window's workspace, with its own terminal: offering then
    // would link the shown workspace to the other one's project (#80).
    const ownTab = ws?.tabids?.includes(staticTabId) ?? false;
    const offer = !ownTab
        ? null
        : nextProjectOffer(project, terminalProject, dismissed, getApi().getEnv("HOME"), hasImportedIcon(ws));
    const offerKey = offer ? `${offer.mode}:${offer.dir}` : "";
    useEffect(() => {
        if (
            offer == null ||
            shown != null ||
            waveModalOpen ||
            answered.includes(offerKey) ||
            document.visibilityState !== "visible"
        ) {
            return;
        }
        if (offer.mode === "link") {
            setShown(offer);
            return;
        }
        if (editing) {
            return;
        }
        setAnswered((keys) => [...keys, offerKey]);
        fireAndForget(() => offerProjectIcon(ws, offer.dir));
    }, [offerKey, shown, answered, waveModalOpen, editing]);
    // The workspace works where its terminal goes (FR-SHELL-009). Only when the terminal moves, so a Reset holds until
    // the next move; only from the view in front, on one of the workspace's own tabs (#80).
    useEffect(() => {
        if (ws == null || document.visibilityState !== "visible" || !ws.tabids?.includes(staticTabId)) {
            return;
        }
        const next = nextWorkspaceFolder(folder, project.dir, terminalFolder);
        if (next != null) {
            fireAndForget(() => setWorkspaceFolder(ws.oid, next));
        }
    }, [terminalFolder, ws?.oid]);
    return (
        <>
            {blockId ? <TerminalFolder key={blockId} blockId={blockId} onFolder={onFolder} /> : null}
            {shown != null && ownTab ? (
                <ProjectLinkModal
                    key={`${shown.mode}:${shown.dir}`}
                    offer={shown}
                    ws={ws}
                    onClose={() => {
                        setAnswered((keys) => [...keys, `${shown.mode}:${shown.dir}`]);
                        setShown(null);
                    }}
                />
            ) : null}
        </>
    );
}

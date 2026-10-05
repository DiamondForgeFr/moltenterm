// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Linking a project from the terminal (#77): when the focused terminal of a workspace without a project goes into a
// project's folder, a modal offers to link it, to use one of its images as the workspace icon and to name the
// workspace after it; a workspace linked without choosing its icon (molten project link) gets the icon part. Only
// the visible window offers: the views MoltenTerm keeps for other workspaces stay quiet.

import { atoms, getApi } from "@/app/store/global";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MoltenWave } from "./molten-button";
import { hasDefaultName, nextProjectOffer, ProjectOffer, readDismissed, withDismissed } from "./project-detect";
import { WorkspaceIcon } from "./workspace-icon";
import { nextWorkspaceFolder, pathBaseName, readWorkspaceFolder, readWorkspaceProject } from "./workspace-project";
import {
    chooseMoltentermPath,
    dismissProject,
    findOfferedProject,
    findProjectLogos,
    linkWorkspaceProject,
    markLogoOffered,
    readProjectFacts,
    renameWorkspace,
    setWorkspaceFolder,
    setWorkspaceLogo,
} from "./workspace-project-store";

const NoFocusedNode = atom(null) as Atom<{ data?: { blockId?: string } }>;

const AccentButton = "molten-btn cursor-pointer rounded px-3 py-1.5 text-xs";
const PlainButton =
    "cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary";

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
    const [logos, setLogos] = useState<string[]>([]);
    const [chosen, setChosen] = useState<string>("");
    const [rename, setRename] = useState(offer.mode === "link" && hasDefaultName(ws.name));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    useEffect(() => {
        fireAndForget(async () => {
            const [facts, found] = await Promise.all([readProjectFacts(offer.dir), findProjectLogos(offer.dir)]);
            setName(facts.name);
            setLogos(found);
            setChosen(found[0] ?? "");
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
            if (offer.mode === "link") {
                await linkWorkspaceProject(ws, offer.dir);
            }
            if (chosen) {
                await setWorkspaceLogo(ws.oid, chosen);
            }
            await markLogoOffered(ws.oid, offer.dir);
            if (rename && name) {
                await renameWorkspace(ws, name);
            }
        });
    // "Not now" is remembered: for this folder in this workspace, or the icon offer for this project.
    const decline = () =>
        run(async () => {
            if (offer.mode === "link") {
                await dismissProject(ws.oid, withDismissed(readDismissed(ws.meta as Record<string, any>), offer.dir));
                return;
            }
            await markLogoOffered(ws.oid, offer.dir);
        });
    const pickOther = () =>
        fireAndForget(async () => {
            const file = await chooseMoltentermPath({ kind: "image", title: "Workspace icon", defaultPath: offer.dir });
            if (file) {
                setLogos((current) => (current.includes(file) ? current : [file, ...current]));
                setChosen(file);
            }
        });
    const choices = [{ logo: "", title: "Keep the workspace's icon" }, ...logos.map((logo) => ({ logo, title: logo }))];
    return createPortal(
        <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40">
            <div className="flex w-[460px] flex-col rounded border border-border bg-modalbg shadow-xl">
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">
                        {offer.mode === "link"
                            ? `Link this workspace to ${name}?`
                            : `Use ${name}'s logo for this workspace?`}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted" title={offer.dir}>
                        {offer.dir}
                    </div>
                </div>
                <div className="flex flex-col gap-3 px-4 py-3 text-xs">
                    {offer.mode === "link" ? (
                        <div className="text-secondary">
                            A terminal of this workspace is in this project. Linked, the workspace shows it in Mission
                            Control (Project, CI/CD).
                        </div>
                    ) : null}
                    <div>
                        <div className="mb-1.5 text-secondary">Workspace icon</div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {choices.map((c) => (
                                <button
                                    key={c.logo || "keep"}
                                    type="button"
                                    title={c.title}
                                    aria-pressed={chosen === c.logo}
                                    onClick={() => setChosen(c.logo)}
                                    className={cn(
                                        "flex h-10 w-10 cursor-pointer items-center justify-center rounded border text-[18px] hover:bg-hover",
                                        chosen === c.logo ? "border-accent ring-1 ring-accent" : "border-border"
                                    )}
                                >
                                    <WorkspaceIcon icon={ws.icon} color={ws.color} logo={c.logo || undefined} />
                                </button>
                            ))}
                            <button type="button" onClick={pickOther} className={PlainButton}>
                                Other image…
                            </button>
                        </div>
                    </div>
                    {offer.mode === "link" ? (
                        <label className="flex cursor-pointer items-center gap-2 text-secondary">
                            <input type="checkbox" checked={rename} onChange={(e) => setRename(e.target.checked)} />
                            Name the workspace “{name}”
                            {ws.name ? <span className="text-muted">(now “{ws.name}”)</span> : null}
                        </label>
                    ) : null}
                    {error ? <div className="text-error">{error}</div> : null}
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                    <button type="button" disabled={busy} onClick={decline} className={PlainButton}>
                        {offer.mode === "link" ? "Not now" : "Keep the icon"}
                    </button>
                    <button type="button" disabled={busy} onClick={accept} className={AccentButton}>
                        {offer.mode === "link" ? "Link the project" : "Use this icon"}
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
    const focusedAtom = useMemo(() => getLayoutModelForStaticTab()?.focusedNode ?? NoFocusedNode, []);
    const focused = useAtomValue(focusedAtom);
    const blockId = focused?.data?.blockId;
    const [terminalProject, setTerminalProject] = useState("");
    const [terminalFolder, setTerminalFolder] = useState("");
    const [shown, setShown] = useState<ProjectOffer>(null);
    // Offers answered in this session: the workspace's meta takes a moment to reflect the answer.
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
    const offer = !ownTab ? null : nextProjectOffer(project, terminalProject, dismissed, getApi().getEnv("HOME"));
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
        setShown(offer);
    }, [offerKey, shown, answered, waveModalOpen]);
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

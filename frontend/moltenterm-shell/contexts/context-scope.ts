// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's reading of where every workspace is (FR-BOSS-009, #2476), for Brokk's scope: which context each workspace
// is in and which folder is whose project. Read once, then again when a workspace or a context changes. The rules are
// context-scope-model.ts's; this is the store they read from, in part of the bubble's up-front JavaScript.

import { ClientModel } from "@/app/store/client-model";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import type { AgentStatesData } from "../agent-state-model";
import { readWorkspaceProject } from "../workspace-project";
import type { WorkspaceRailSource } from "../workspace-rail-model";
import { subscribeWorkspaceSources } from "../workspace-sources";
import { contextIdOf, readContexts } from "./context-model";
import { ContextScopeFacts, EmptyScopeFacts, scopeAgents, trimDir } from "./context-scope-model";

export class ContextScope {
    private static instance: ContextScope = null;

    factsAtom = atom(EmptyScopeFacts) as PrimitiveAtom<ContextScopeFacts>;
    // The context of the workspace this window shows; "" before the client and the workspace are known.
    windowContextAtom: Atom<string>;
    // The agents of the window's context: what Brokk's visits, badge and counts read.
    scopedAgentsAtom: Atom<AgentStatesData>;
    private started = false;

    private constructor() {
        this.windowContextAtom = atom((get) => {
            const clientAtom = ClientModel.getInstance().clientAtom;
            const workspaceAtom = atoms?.workspace;
            if (clientAtom == null || workspaceAtom == null) {
                return "";
            }
            return contextIdOf(readContexts(get(clientAtom)?.meta), get(workspaceAtom)?.meta);
        });
        this.scopedAgentsAtom = atom((get) =>
            scopeAgents(get(AgentStates.getInstance().dataAtom), get(this.factsAtom), get(this.windowContextAtom))
        );
    }

    static getInstance(): ContextScope {
        if (ContextScope.instance == null) {
            ContextScope.instance = new ContextScope();
        }
        return ContextScope.instance;
    }

    // Follows the workspaces the page reads for its sidebar (workspace-sources.ts: one read for every reader, again only
    // when a workspace changes); started once with Brokk's hub, which every window mounts. Until the first read nothing
    // is left out.
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        subscribeWorkspaceSources((sources) => globalStore.set(this.factsAtom, factsOf(sources)));
    }

    static resetInstance(): void {
        ContextScope.instance = null;
    }
}

function factsOf(sources: WorkspaceRailSource[]): ContextScopeFacts {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const contexts = readContexts(clientAtom != null ? globalStore.get(clientAtom)?.meta : undefined);
    const contextOf: Record<string, string> = {};
    const dirContext: Record<string, string> = {};
    const note = (ws: Workspace) => {
        if (ws?.oid == null) {
            return;
        }
        const id = contextIdOf(contexts, ws.meta);
        contextOf[ws.oid] = id;
        const dir = trimDir(readWorkspaceProject(ws).dir);
        if (dir) {
            dirContext[dir] = id;
        }
    };
    sources.forEach((source) => note(source.workspace));
    if (atoms?.workspace != null) {
        note(globalStore.get(atoms.workspace));
    }
    return { contextOf, dirContext, loaded: true };
}

// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What every card of the Project tab receives: the data is read once by the tab (the same hooks as Mission Control's
// panels) and handed to the cards, so a card never opens its own subscription or poll.

import { useSyncExternalStore } from "react";
import { CiState } from "../mission/ci-model";
import { ActiveProject } from "../mission/mission-frame";
import { MissionSnapshot, PipelineDef, RunRecord } from "../mission/mission-model";
import { ReleaseSession } from "../mission/release-model";
import { ProjectCard, ProjectCardRegistry } from "./project-cards";

export type ProjectCardProps = {
    project: ActiveProject;
    projectName: string;
    snapshot: MissionSnapshot;
    refresh: () => void;
    pipeline: PipelineDef;
    runs: RunRecord[];
    ci: CiState;
    reloadCi: () => void;
    release: ReleaseSession;
    reloadRelease: () => void;
    // Starts a declared build (the trust prompt opens when needed); resolves to the error, if any.
    startBuild: (buildId: string) => Promise<string>;
    // Starts the local CI on a branch (the trust prompt opens when needed).
    runCi: (branch: string) => void;
    // Scrolls the run cards into view after a start.
    showRuns: () => void;
};

export const ProjectCards = new ProjectCardRegistry<ProjectCardProps>();

// Registers a card of the Project tab: the hook for contributions (a mod's card, later). Returns the unregister.
export function registerProjectCard(card: ProjectCard<ProjectCardProps>): () => void {
    return ProjectCards.register(card);
}

const subscribe = (listener: () => void) => ProjectCards.subscribe(listener);
const snapshot = () => ProjectCards.cards;

export function useProjectCards(): ProjectCard<ProjectCardProps>[] {
    return useSyncExternalStore(subscribe, snapshot);
}

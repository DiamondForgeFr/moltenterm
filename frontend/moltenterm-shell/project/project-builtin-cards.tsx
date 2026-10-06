// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's own cards (FR-MC-020, DS-MC-012), composed from Mission Control's panels, one home for each
// piece of information: the next station band with the only copy of the actions (next-station-header.tsx: Run CI on
// develop, Build local, Release, Clean branches, each showing its plan before it runs), the branches on the line map,
// then the row of four cards (overview-cards.tsx): Next public release, Releases, Now and Project steps. They register
// like any contribution.

import { LineMapCard } from "./line-map-card";
import { NextStationHeader } from "./next-station-header";
import { NextReleaseCard, NowCard, ReleasesCard, StepsCard } from "./overview-cards";
import { ProjectCard } from "./project-cards";
import { ProjectCardProps } from "./project-context";

// The header and map slots frame themselves; the four cards of the row get the core's frame with their title.
export const BuiltinProjectCards: ProjectCard<ProjectCardProps>[] = [
    {
        id: "moltenterm:next-station",
        title: "Next station",
        region: "header",
        order: 10,
        bare: true,
        component: NextStationHeader,
    },
    { id: "moltenterm:linemap", title: "Line map", region: "map", order: 10, bare: true, component: LineMapCard },
    {
        id: "moltenterm:next-release",
        title: "Next public release",
        region: "cards",
        order: 10,
        component: NextReleaseCard,
    },
    { id: "moltenterm:releases", title: "Releases", region: "cards", order: 20, component: ReleasesCard },
    { id: "moltenterm:now", title: "Now", region: "cards", order: 30, component: NowCard },
    { id: "moltenterm:steps", title: "Project steps", region: "cards", order: 40, component: StepsCard },
];

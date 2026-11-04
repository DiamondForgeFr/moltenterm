// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package projectviews

// PaneFact is what one panel of a view says about its project: the folder of a terminal or of a file panel, and
// whether a coding agent runs in it.
type PaneFact struct {
	Dir   string
	Agent bool
}

// TabFacts is what the assignment reads of a view that no project owns yet.
type TabFacts struct {
	Id         string
	ProjectTab bool
	Panes      []PaneFact
}

// AssignTab gives a view its project from its panels' folders: the first agent panel with a folder in a project wins,
// then the project most panels are in (the first panel's project on a tie). "" when no panel is in any project, and
// for the Project tab, which every project shares.
func AssignTab(projects []Project, facts TabFacts) string {
	if facts.ProjectTab {
		return ""
	}
	counts := map[string]int{}
	var order []string
	for _, pane := range facts.Panes {
		id := ProjectOfDir(projects, pane.Dir)
		if id == "" {
			continue
		}
		if pane.Agent {
			return id
		}
		if counts[id] == 0 {
			order = append(order, id)
		}
		counts[id]++
	}
	best, bestCount := "", 0
	for _, id := range order {
		if counts[id] > bestCount {
			best, bestCount = id, counts[id]
		}
	}
	return best
}

// Assign gives each view that has no project its own: the project its panels' folders say, else the fallback (the
// project being left, or the current one at startup). Views already mapped, and the Project tab, are left as they
// are. The result holds only what was added.
func Assign(projects []Project, mapped map[string]string, unmapped []TabFacts, fallback string) map[string]string {
	rtn := map[string]string{}
	if len(projects) < 2 {
		return rtn
	}
	for _, facts := range unmapped {
		if facts.ProjectTab || mapped[facts.Id] != "" {
			continue
		}
		id := AssignTab(projects, facts)
		if id == "" {
			id = fallback
		}
		if _, ok := FindProject(projects, id); !ok {
			id = projects[0].Id
		}
		rtn[facts.Id] = id
	}
	return rtn
}

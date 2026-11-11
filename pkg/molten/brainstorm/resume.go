// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The resume brief (FR-BOSS-010 AC10, DS-BOSS-010, #2248): when the developer loads a brainstorm, MoltenTerm writes in
// Brokk's own folder where it stood (its title, the outline of its graph with the ids he grows it from, the last
// exchanges), and the developer's next message tells him to read it. His session never reads the brainstorms folder:
// this file holds the one brainstorm the developer chose, and goes when that brainstorm is forgotten.

const (
	// ResumeFile is read by his brief's brainstorm section (pkg/molten/brokksession/brief-brainstorm.md).
	ResumeFile = "brainstorm-resume.md"
	// BrokkFolderName must match pkg/molten/brokksession's FolderName (checked by its tests).
	BrokkFolderName = "brokk"

	resumeMarker = "<!-- molten:brainstorm-resume "
	resumeTurns  = 8
	resumeTurnCh = 600
)

func resumeText(saved Saved) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s%s -->\n", resumeMarker, saved.Info.Id)
	fmt.Fprintf(&b, "# Brainstorm resumed: %s\n\n", CleanText(saved.Info.Title))
	updated := time.UnixMilli(saved.Info.Updated).Format("2006-01-02 15:04")
	fmt.Fprintf(&b, "The developer resumed this brainstorm. This is where it stood when it was last saved (%s, state %s).\n", updated, saved.Info.State)
	if saved.Graph.Centre != "" {
		fmt.Fprintf(&b, "Keep growing this graph: its centre's id is `%s`. Add new nodes from the ids below, and never add one of them again.\n", saved.Graph.Centre)
	} else {
		b.WriteString("Its graph is empty: the next answer puts its central idea.\n")
	}
	b.WriteString("\n## The graph\n\n")
	children := map[string][]Node{}
	for _, n := range saved.Graph.Nodes {
		if n.Id != saved.Graph.Centre {
			children[n.From] = append(children[n.From], n)
		}
	}
	var walk func(id string, depth int)
	walk = func(id string, depth int) {
		for _, n := range children[id] {
			fmt.Fprintf(&b, "%s- `%s` %s: %s\n", strings.Repeat("  ", depth), n.Id, n.Kind, CleanText(n.Text))
			walk(n.Id, depth+1)
		}
	}
	if centre, ok := saved.Graph.node(saved.Graph.Centre); ok {
		fmt.Fprintf(&b, "- `%s` topic: %s\n", centre.Id, CleanText(centre.Text))
		walk(centre.Id, 1)
	}
	for _, l := range saved.Graph.Links {
		why := CleanText(l.Why)
		if why != "" {
			why = ": " + why
		}
		fmt.Fprintf(&b, "- link `%s` to `%s`%s\n", l.A, l.B, why)
	}
	turns := saved.Turns
	if len(turns) > resumeTurns {
		turns = turns[len(turns)-resumeTurns:]
	}
	if len(turns) > 0 {
		b.WriteString("\n## The last exchanges\n\n")
		for _, turn := range turns {
			who := "The developer"
			if turn.Role == RoleBrokk {
				who = "You"
			}
			fmt.Fprintf(&b, "- %s: %s\n", who, cutText(CleanText(turn.Text), resumeTurnCh))
		}
	}
	return b.String()
}

// WriteResume writes the resume brief of saved into his folder, over the one of another brainstorm.
func WriteResume(brokkDir string, saved Saved) error {
	if brokkDir == "" {
		return errors.New("no folder of his")
	}
	if err := os.MkdirAll(brokkDir, 0o700); err != nil {
		return err
	}
	return writeAtomic(filepath.Join(brokkDir, ResumeFile), []byte(resumeText(saved)))
}

// resumeOf is the id of the brainstorm his folder's resume brief is about, "" when there is none MoltenTerm wrote.
func resumeOf(brokkDir string) string {
	file, err := os.Open(filepath.Join(brokkDir, ResumeFile))
	if err != nil {
		return ""
	}
	defer file.Close()
	line, err := bufio.NewReader(file).ReadString('\n')
	if err != nil && line == "" {
		return ""
	}
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, resumeMarker) || !strings.HasSuffix(line, "-->") {
		return ""
	}
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, resumeMarker), "-->"))
}

// ClearResume removes the resume brief when it is the forgotten brainstorm's (AC10d); another's stays.
func ClearResume(brokkDir string, id string) error {
	if brokkDir == "" || id == "" || resumeOf(brokkDir) != id {
		return nil
	}
	err := os.Remove(filepath.Join(brokkDir, ResumeFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

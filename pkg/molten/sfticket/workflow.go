// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package sfticket

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// The workflow of a SaaSFoundry project (#2563): the CLI that moves a ticket through its statuses, and the statuses
// its manifest declares. A project without the manifest or without that CLI has no workflow here, and MoltenTerm moves
// nothing in it.

const (
	WorkflowCliName = "workflow-cli.sh"

	// The statuses SaaSFoundry's workflows know, as its CLI normalizes a name (lower case, one space between words). The
	// name to give the CLI is the one the manifest declares, never one of these.
	StatusInProgress = "in progress"
	StatusAiTesting  = "ai testing"
	StatusInReview   = "in review"
	StatusDone       = "done"
)

// The places a SaaSFoundry project keeps its workflow CLI, per coding agent.
var WorkflowCliPaths = []string{
	".claude/skills/sf-workflow/" + WorkflowCliName,
	".agents/skills/sf-workflow/" + WorkflowCliName,
}

var currentStatusRegex = regexp.MustCompile(`(?m)^Ticket #(\d+) is currently in status: (.+?)\s*$`)
var ansiRegex = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// Workflow is the CLI of a project's workflow and the statuses of its board, in the order the manifest lists them.
type Workflow struct {
	// The CLI's path.
	Cli      string
	Statuses []string
}

// WorkflowOf reads the workflow of the project at dir; nil when the project has no manifest, declares no workflow tool
// or no status, or keeps no workflow CLI.
func WorkflowOf(dir string) *Workflow {
	var m struct {
		Workflow struct {
			Tool     string `json:"tool"`
			Statuses []struct {
				Name string `json:"name"`
			} `json:"statuses"`
		} `json:"workflow"`
	}
	if !readJsonManifest(dir, &m) || strings.TrimSpace(m.Workflow.Tool) == "" {
		return nil
	}
	var statuses []string
	for _, status := range m.Workflow.Statuses {
		if name := strings.TrimSpace(status.Name); name != "" {
			statuses = append(statuses, name)
		}
	}
	if len(statuses) == 0 {
		return nil
	}
	for _, rel := range WorkflowCliPaths {
		if info, err := os.Stat(filepath.Join(dir, rel)); err == nil && info.Mode().IsRegular() {
			return &Workflow{Cli: filepath.Join(dir, rel), Statuses: statuses}
		}
	}
	return nil
}

// NormalStatus is a status name as SaaSFoundry's CLI compares it.
func NormalStatus(name string) string {
	return strings.Join(strings.Fields(strings.ToLower(name)), " ")
}

// Position is where the workflow lists a status, whatever its case; -1 when it lists none of that name.
func (w *Workflow) Position(name string) int {
	want := NormalStatus(name)
	if want == "" {
		return -1
	}
	for i, status := range w.Statuses {
		if NormalStatus(status) == want {
			return i
		}
	}
	return -1
}

// Find gives the name the workflow declares for a status (one of the Status… constants) and its position; "" and -1
// when the workflow has no such status: that moment of a release is then skipped.
func (w *Workflow) Find(status string) (string, int) {
	i := w.Position(status)
	if i < 0 {
		return "", -1
	}
	return w.Statuses[i], i
}

// StripAnsi removes the colour codes the CLI prints.
func StripAnsi(text string) string {
	return ansiRegex.ReplaceAllString(text, "")
}

// ParseCurrentStatus reads a ticket's status from what `workflow-cli.sh status <ticket>` printed.
func ParseCurrentStatus(out string, ticket int) (string, bool) {
	for _, m := range currentStatusRegex.FindAllStringSubmatch(StripAnsi(out), -1) {
		if n, err := strconv.Atoi(m[1]); err == nil && n == ticket {
			return strings.TrimSpace(m[2]), true
		}
	}
	return "", false
}

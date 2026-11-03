// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package sfticket creates a ticket through the ticket CLI of a SaaSFoundry project (its github-projects tool), as the
// project's own workflow does: on the board, typed, with a complexity and a nature, so that the workflow's guards accept
// it. The release setup's ticket (#1788) and the release's own ticket (#1800) go through it.
package sfticket

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	ToolName = "github-projects-cli.sh"
	toolKind = "github-projects"

	TypeTask         = "task"
	ComplexityLow    = "low"
	NatureInternal   = "internal"
	createTicketVerb = "create-ticket"
)

// The places a SaaSFoundry project keeps its ticket CLI, per coding agent.
var ToolPaths = []string{
	".claude/skills/sf-tool-github-projects/" + ToolName,
	".agents/skills/sf-tool-github-projects/" + ToolName,
}

var issueUrlLineRegex = regexp.MustCompile(`(?m)^Issue URL:\s*(\S+)\s*$`)
var issueNumberRegex = regexp.MustCompile(`/issues/(\d+)\s*$`)

// Runner runs a program in a folder and returns its standard output; the error carries the program's last error line.
type Runner func(ctx context.Context, dir string, name string, args ...string) ([]byte, error)

type manifest struct {
	Workflow struct {
		Tool       string `json:"tool"`
		ProjectUrl string `json:"projectUrl"`
	} `json:"workflow"`
	Tools struct {
		Srs struct {
			Backend string `json:"backend"`
		} `json:"srs"`
	} `json:"tools"`
}

func readManifest(dir string) (manifest, bool) {
	var m manifest
	data, err := os.ReadFile(filepath.Join(dir, molten.ProjectSaaSFoundryFile))
	if err != nil {
		return m, false
	}
	if json.Unmarshal(data, &m) != nil {
		return m, false
	}
	return m, true
}

// ToolOf is where the project keeps its ticket CLI (a path relative to its root) when its workflow uses one on a board,
// else "".
func ToolOf(dir string) string {
	m, ok := readManifest(dir)
	if !ok || m.Workflow.Tool != toolKind || strings.TrimSpace(m.Workflow.ProjectUrl) == "" {
		return ""
	}
	for _, rel := range ToolPaths {
		if info, err := os.Stat(filepath.Join(dir, rel)); err == nil && !info.IsDir() {
			return rel
		}
	}
	return ""
}

// IssueNumber reads the number of an issue from its address, 0 when it is none.
func IssueNumber(url string) int {
	m := issueNumberRegex.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// Spec is the ticket to make. SrsBypassReason is passed to the CLI only when the project's SRS is enabled, which
// refuses a ticket without a source otherwise.
type Spec struct {
	Type            string
	Title           string
	Body            string
	Complexity      string
	Nature          string
	Milestone       string
	SrsBypassReason string
}

// Create makes the ticket by running the CLI whose text is script, which the caller read from a commit the project
// reviewed, never from the working copy: whatever the working copy holds is not run. The script is written to a private
// folder under tmpParent. ok false: no ticket was created, the caller makes a plain issue instead. The CLI prints the
// issue's address once it exists, even when a later step (board, type, label, milestone) fails: the ticket is then the
// one to use, never a second one, and the error says what the CLI could not finish.
func Create(ctx context.Context, run Runner, dir string, script []byte, tmpParent string, spec Spec) (number int, ok bool, unfinished error) {
	if len(script) == 0 {
		return 0, false, nil
	}
	tmp, err := os.MkdirTemp(tmpParent, "ticket-")
	if err != nil {
		if os.MkdirAll(tmpParent, 0700) != nil {
			return 0, false, nil
		}
		if tmp, err = os.MkdirTemp(tmpParent, "ticket-"); err != nil {
			return 0, false, nil
		}
	}
	defer os.RemoveAll(tmp)
	tool := filepath.Join(tmp, ToolName)
	bodyFile := filepath.Join(tmp, "body.md")
	if os.WriteFile(tool, script, 0700) != nil || os.WriteFile(bodyFile, []byte(spec.Body+"\n"), 0600) != nil {
		return 0, false, nil
	}
	args := []string{tool, createTicketVerb, spec.Type, spec.Title, "--body-file", bodyFile,
		"--complexity", spec.Complexity, "--nature", spec.Nature}
	if spec.Milestone != "" {
		args = append(args, "--milestone", spec.Milestone)
	}
	if m, _ := readManifest(dir); spec.SrsBypassReason != "" && strings.TrimSpace(m.Tools.Srs.Backend) != "" {
		args = append(args, "--bypass-srs", spec.SrsBypassReason)
	}
	out, runErr := run(ctx, dir, "bash", args...)
	m := issueUrlLineRegex.FindSubmatch(out)
	if m == nil {
		return 0, false, nil
	}
	n := IssueNumber(string(m[1]))
	return n, n > 0, runErr
}

// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// Automatic updates (DS-CONT-009). Auto owns Ticket, Files touched, Plan and progress and Last transcript; it fills
// Goal only while Goal is empty; it never writes Decisions, Open questions or Next steps. A section last written by the
// user or an agent is never overwritten: auto writes only the sections it owns that are its own or empty.

const (
	MaxFilesTouched = 50
	MaxPlanItems    = 60
	MaxGoalBytes    = 2000
)

// The ticket of a branch named with the project's pattern, feature/{N}-description by default: a number, or a key
// such as ABC-12, right after the type's slash.
var ticketBranchRegex = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]*/#?([0-9]{1,9}|[A-Z][A-Z0-9]{0,9}-[0-9]{1,9})(?:[-_/.]|$)`)

// TicketFromBranch is the ticket of a branch: "#42" for feature/42-login, "ABC-12" for fix/ABC-12-crash, "" for none.
func TicketFromBranch(branch string) string {
	m := ticketBranchRegex.FindStringSubmatch(branch)
	if m == nil {
		return ""
	}
	if m[1][0] >= '0' && m[1][0] <= '9' {
		return "#" + m[1]
	}
	return m[1]
}

// GitState is what the pane's folder says: its branch, and how far it is from its upstream.
type GitState struct {
	Repo        bool
	Branch      string
	Detached    string
	HasUpstream bool
	Ahead       int
	Behind      int
}

// AutoInput is what one pane's agent session brings to an update.
type AutoInput struct {
	Agent          string
	SessionId      string
	TranscriptPath string
	// Folder: the pane's folder, for the files' relative paths.
	Folder string
	Home   string
	Digest companion.SessionDigest
	Git    GitState
	At     int64
}

func writable(sec *Section) bool {
	return sec != nil && (sec.Owner == "" || sec.Owner == OwnerAuto || strings.TrimSpace(sec.Body) == "")
}

// setAuto writes a section as auto; it tells whether the body changed.
func setAuto(sec *Section, body string, at int64) bool {
	body = strings.TrimSpace(body)
	if strings.TrimSpace(sec.Body) == body && (sec.Owner == OwnerAuto || body == "") {
		return false
	}
	sec.Body = body
	sec.Owner = OwnerAuto
	sec.At = at
	if body == "" {
		sec.Owner, sec.At = "", 0
	}
	return true
}

// ApplyAuto applies one session's observations; it tells whether the checkpoint changed.
func ApplyAuto(c *Checkpoint, in AutoInput) bool {
	changed := false
	if sec := c.Section(SectionGoal); sec != nil && strings.TrimSpace(sec.Body) == "" {
		if goal := goalOf(c, in.Digest); goal != "" {
			changed = setAuto(sec, goal, in.At) || changed
		}
	}
	if sec := c.Section(SectionTicket); writable(sec) && in.Git.Repo {
		changed = setAuto(sec, ticketBody(in.Git), in.At) || changed
	}
	if sec := c.Section(SectionPlan); writable(sec) {
		if plan := planBody(c, in.Digest); plan != "" {
			changed = setAuto(sec, plan, in.At) || changed
		}
	}
	if sec := c.Section(SectionFiles); writable(sec) {
		if files := filesBody(c, sec, in); files != "" {
			changed = setAuto(sec, files, in.At) || changed
		}
	}
	if in.TranscriptPath != "" {
		pointer := molten.TaskTranscript{Agent: in.Agent, Session: in.SessionId, Path: in.TranscriptPath}
		if c.Transcript != pointer {
			c.Transcript = pointer
			changed = true
		}
		if sec := c.Section(SectionTranscript); writable(sec) {
			changed = setAuto(sec, transcriptBody(in), in.At) || changed
		}
	}
	return changed
}

// since tells whether something observed at `at` belongs to the current task (a task cleared at Started does not take
// back what came before).
func since(c *Checkpoint, at int64) bool {
	return c.Started == 0 || at >= c.Started
}

func goalOf(c *Checkpoint, d companion.SessionDigest) string {
	var prompts []companion.Prompt
	if d.FirstPrompt != nil {
		prompts = append(prompts, *d.FirstPrompt)
	}
	prompts = append(prompts, d.Prompts...)
	for _, p := range prompts {
		if since(c, p.At) && strings.TrimSpace(p.Text) != "" {
			return inertMarkdown(cutText(p.Text, MaxGoalBytes))
		}
	}
	return ""
}

func ticketBody(g GitState) string {
	branch := g.Branch
	if branch == "" {
		if g.Detached == "" {
			return ""
		}
		return fmt.Sprintf("No branch (detached at `%s`).", g.Detached)
	}
	var b strings.Builder
	if ticket := TicketFromBranch(branch); ticket != "" {
		fmt.Fprintf(&b, "%s, on branch `%s`", ticket, branch)
	} else {
		fmt.Fprintf(&b, "No ticket number in branch `%s`", branch)
	}
	if g.HasUpstream {
		fmt.Fprintf(&b, " (%d ahead, %d behind its upstream)", g.Ahead, g.Behind)
	}
	b.WriteString(".")
	return b.String()
}

func planBody(c *Checkpoint, d companion.SessionDigest) string {
	if len(d.Todos) == 0 || !since(c, d.TodosAt) {
		return ""
	}
	todos := d.Todos
	done := 0
	for _, t := range todos {
		if t.Status == companion.TodoCompleted {
			done++
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d of %d done.\n\n", done, len(todos))
	for i, t := range todos {
		if i >= MaxPlanItems {
			fmt.Fprintf(&b, "- … %d more\n", len(todos)-MaxPlanItems)
			break
		}
		text := markdownLine(t.Text)
		switch t.Status {
		case companion.TodoCompleted:
			fmt.Fprintf(&b, "- [x] %s\n", text)
		case companion.TodoInProgress:
			fmt.Fprintf(&b, "- [ ] %s (in progress)\n", text)
		default:
			fmt.Fprintf(&b, "- [ ] %s\n", text)
		}
	}
	return b.String()
}

var fileLineRegex = regexp.MustCompile("^- `([^`]+)`")

var fileKindWords = map[string]string{companion.FileAdded: "added", companion.FileUpdated: "modified", companion.FileDeleted: "deleted"}

// filesBody lists this session's files first, newest first, then the ones earlier sessions of the task touched (the
// section's previous lines), at most MaxFilesTouched. Paths only: never a file's content.
func filesBody(c *Checkpoint, sec *Section, in AutoInput) string {
	seen := map[string]bool{}
	var lines []string
	for _, f := range in.Digest.Files {
		if !since(c, f.At) {
			continue
		}
		path := displayFilePath(f.Path, in.Folder, in.Home)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		line := "- `" + path + "`"
		if word := fileKindWords[f.Kind]; word != "" {
			line += " (" + word + ")"
		}
		lines = append(lines, line)
	}
	if sec.Owner == OwnerAuto || sec.Owner == "" {
		for _, line := range strings.Split(sec.Body, "\n") {
			m := fileLineRegex.FindStringSubmatch(strings.TrimSpace(line))
			if m == nil || seen[m[1]] {
				continue
			}
			seen[m[1]] = true
			lines = append(lines, strings.TrimSpace(line))
		}
	}
	if len(lines) > MaxFilesTouched {
		lines = lines[:MaxFilesTouched]
	}
	return strings.Join(lines, "\n")
}

// displayFilePath shows a path relative to the pane's folder when it is inside it, else from the home folder.
func displayFilePath(path string, folder string, home string) string {
	path = strings.TrimSpace(path)
	if path == "" || strings.ContainsAny(path, "`\n") {
		return ""
	}
	if folder != "" && filepath.IsAbs(path) {
		if rel, err := filepath.Rel(folder, path); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			return filepath.ToSlash(rel)
		}
	}
	return homePath(path, home)
}

func homePath(path string, home string) string {
	if home == "" || !filepath.IsAbs(path) {
		return path
	}
	if rel, err := filepath.Rel(home, path); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
		return "~/" + filepath.ToSlash(rel)
	}
	return path
}

func transcriptBody(in AutoInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "- Agent: %s\n", molten.AgentDisplayName(in.Agent))
	if in.SessionId != "" {
		fmt.Fprintf(&b, "- Session: `%s`\n", strings.ReplaceAll(in.SessionId, "`", ""))
	}
	fmt.Fprintf(&b, "- Transcript: `%s`\n", strings.ReplaceAll(homePath(in.TranscriptPath, in.Home), "`", ""))
	return b.String()
}

// markdownLine keeps a todo on one list line.
func markdownLine(text string) string {
	return inertMarkdown(strings.Join(strings.Fields(text), " "))
}

// inertMarkdown keeps an agent's or a prompt's text from loading anything when the checkpoint is shown rendered: no
// image (a remote image is a request out) and no raw HTML.
func inertMarkdown(text string) string {
	text = strings.ReplaceAll(text, "![", "!\\[")
	return strings.ReplaceAll(text, "<", "\\<")
}

func cutText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max
	for cut > 0 && (text[cut]&0xC0) == 0x80 {
		cut--
	}
	return text[:cut] + "…"
}

// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

const (
	// "off" writes the public notes from the commit subjects, whatever the project declares.
	NotesAiEnv = "MOLTEN_RELEASE_NOTES_AI"
	// A command line that replaces versions.notesagent for one run, split on spaces (e.g. "codex exec -").
	NotesAgentEnv = "MOLTEN_RELEASE_NOTES_AGENT"

	notesAgentAttempts = 2
	notesAgentTimeout  = 10 * time.Minute
	// A first release reads the whole history: the record handed to the agent stops here.
	maxPromptRecordBytes = 120 << 10
)

var fenceRegex = regexp.MustCompile("(?s)^```(?:markdown|md)?\\s*\\n(.*?)\\n?```\\s*$")

// AgentRunner runs a coding agent CLI in dir with the prompt on its standard input and returns its standard output.
type AgentRunner func(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error)

// ExecAgent runs the agent with the process's PATH, nothing on its terminal: what it prints on stderr is only kept for
// the error.
func ExecAgent(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, notesAgentTimeout)
	defer cancel()
	cmd := spawns.Command(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(prompt)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if lines := strings.Split(msg, "\n"); msg != "" {
			msg = strings.TrimSpace(lines[len(lines)-1])
		}
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), fmt.Errorf("%s: %s", argv[0], msg)
	}
	return stdout.Bytes(), nil
}

// notesAgent is the agent command of this run: the environment's, else the project's (versions.notesagent), else the
// non-interactive form of the project's coding agent (#845: what Mission Control puts in the step's environment, or
// what MoltenTerm answers a terminal); nil when the notes are written from the commit subjects. A chosen agent that is
// not installed is said, never replaced.
func (e *Env) notesAgent(ctx context.Context, p *Project) []string {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(NotesAiEnv))) {
	case "off", "0", "false", "no":
		return nil
	}
	if fields := strings.Fields(os.Getenv(NotesAgentEnv)); len(fields) > 0 {
		return fields
	}
	if len(p.NotesAgent) > 0 {
		return p.NotesAgent
	}
	if missing := strings.TrimSpace(os.Getenv(agentchoice.MissingEnvVar)); missing != "" {
		e.printf("%s, the coding agent chosen for this project, is not installed on this computer: the public notes are "+
			"written from the commit subjects. Choose an installed agent in the panel's options (Agent), then redo the notes.\n",
			molten.AgentDisplayName(missing))
		return nil
	}
	if argv := agentchoice.PrintArgv(strings.TrimSpace(os.Getenv(agentchoice.EnvVar))); argv != nil {
		return argv
	}
	if e.CodingAgent == nil {
		return nil
	}
	choice, ok := e.CodingAgent(ctx, e.Dir)
	if !ok {
		return nil
	}
	if choice.Missing {
		e.printf("%s. The public notes are written from the commit subjects.\n", choice.MissingText())
		return nil
	}
	return agentchoice.PrintArgv(choice.Agent)
}

func notesPrompt(f NotesFacts, record string) string {
	product := f.Product
	if product == "" {
		product = "the app"
	}
	if len(record) > maxPromptRecordBytes {
		cut := strings.LastIndex(record[:maxPromptRecordBytes], "\n")
		if cut < 0 {
			cut = maxPromptRecordBytes
		}
		record = record[:cut] + "\n\n(The record is longer; the rest is left out.)\n"
	}
	kind := "a public release"
	if f.Channel == versions.ChannelRc {
		kind = "a release candidate, offered to testers"
	}
	repoRule := ""
	if f.Repo != "" {
		repoRule = fmt.Sprintf(" or a link into %s", f.Repo)
	}
	return fmt.Sprintf(`You are writing the release notes of %[1]s for the version %[2]s, %[3]s.

Below is the ENGINEERING RECORD of this release: every ticket, with what each commit said about it. It is the only
source of facts. Never invent a change that is not in it, and never promise anything it does not show.

Write the PUBLIC notes: what this version brings to someone who USES %[1]s.

Rules, all of them hard:
- English only. Translate any commit subject written in another language.
- NEVER a ticket number, a "#123"%[4]s: those pages are the engineering record's.
- NEVER a commit or ticket count, and nothing about how the work was cut up.
- Start with "## What this version brings", then ONE short paragraph naming the one or two changes a user notices
  first.
- Then AT MOST three "### " sections, three to five bullets each. Group by what the user experiences, never by
  modules. Merge several tickets into one bullet whenever they are one change to a reader.
- DO NOT enumerate fixes. Say what now works in ONE line covering the lot, and only for defects a user could have run
  into.
- DO NOT mention work with nothing for them to see: architecture, tests, build, internal tooling.
- Every bullet names something they can SEE or DO.
- Plain, concrete, understated. No marketing, no exclamation marks, no emoji. Say what it now does, not that it is
  "improved".
- HARD LIMIT: %[5]d non-empty lines, headings included. Shorter is better.
- Output the markdown alone: no preamble, no front matter, no code fence. Use no tool.

ENGINEERING RECORD
------------------
%[6]s`, product, f.Tag, kind, repoRule, MaxPublicNoteLines, record)
}

func cleanAgentNotes(out []byte) string {
	text := strings.TrimSpace(strings.ReplaceAll(string(out), "\r\n", "\n"))
	if m := fenceRegex.FindStringSubmatch(text); m != nil {
		text = strings.TrimSpace(m[1])
	}
	return text
}

// agentNotes asks the agent for the public notes, twice at most, and returns the first text the audit accepts; "" when
// none is.
func (e *Env) agentNotes(ctx context.Context, wt string, argv []string, f NotesFacts, record string) string {
	run := e.Agent
	if run == nil {
		run = ExecAgent
	}
	prompt := notesPrompt(f, record)
	for attempt := 1; attempt <= notesAgentAttempts; attempt++ {
		e.printf("Writing the public notes with %s (attempt %d of %d)…\n", strings.Join(argv, " "), attempt, notesAgentAttempts)
		out, err := run(ctx, wt, argv, prompt)
		if err != nil {
			e.printf("  The agent failed: %v\n", err)
			continue
		}
		text := cleanAgentNotes(out)
		problems := AuditPublicNotes(text, f.Repo)
		if len(problems) == 0 {
			return text
		}
		e.printf("  Refused, the text carries what must not be public:\n")
		for _, problem := range problems {
			e.printf("    - %s\n", problem)
		}
	}
	return ""
}

// writeNotes writes the engineering record and the public notes of a prepared tag in the release worktree: the agent's
// notes when one is declared and plain is false, else the commit subjects. It returns the public notes' path.
func (e *Env) writeNotes(ctx context.Context, wt string, p *Project, tag string, v versions.Version, plain bool) (string, error) {
	facts, err := e.gatherNotesFacts(ctx, wt, p, tag, v)
	if err != nil {
		return "", err
	}
	record := InternalRecord(facts)
	internalPath := filepath.Join(wt, p.InternalNotesFile(tag))
	notesPath := filepath.Join(wt, p.NotesFile(tag))
	if !insideDir(wt, notesPath) || !insideDir(wt, internalPath) {
		return "", fmt.Errorf("versions.notes (%s) leaves the project", p.Notes)
	}
	if err := os.MkdirAll(filepath.Dir(notesPath), 0755); err != nil {
		return "", err
	}
	if err := os.WriteFile(internalPath, []byte(record), 0644); err != nil {
		return "", err
	}
	e.printf("Engineering record written: %s (%d commit(s), %d ticket(s) since %s).\n", p.InternalNotesFile(tag), len(facts.Subjects), len(facts.Tickets), facts.sinceLabel())
	body := ""
	how := "from the commit subjects"
	if argv := e.notesAgent(ctx, p); len(argv) > 0 && !plain {
		body = e.agentNotes(ctx, wt, argv, facts, record)
		if body == "" {
			e.printf("Falling back to the commit subjects: review them, they may read oddly.\n")
		} else {
			how = "by " + argv[0]
		}
	}
	if body == "" {
		body = DraftNotes(facts)
	}
	notes := PublicNotes{Body: body}
	notes.Set(FrontMatterDate, e.now().Format("2006-01-02"))
	if err := os.WriteFile(notesPath, []byte(notes.String()), 0644); err != nil {
		return "", err
	}
	e.printf("Public notes written %s: %s.\n", how, p.NotesFile(tag))
	return notesPath, nil
}

// keepNotes stamps the day of the cut on notes the release branch already carries (written by hand ahead of it), and
// says what finalize would refuse in them.
func (e *Env) keepNotes(notesPath string, repo string) error {
	data, err := os.ReadFile(notesPath)
	if err != nil {
		return err
	}
	notes := ParsePublicNotes(string(data))
	notes.Set(FrontMatterDate, e.now().Format("2006-01-02"))
	if err := os.WriteFile(notesPath, []byte(notes.String()), 0644); err != nil {
		return err
	}
	if notes.IsDraft() {
		e.printf("Warning: the notes are marked draft: true. Rewrite them and remove that line: finalize refuses a draft.\n")
	}
	for _, problem := range AuditPublicNotes(notes.Body, repo) {
		e.printf("Warning: finalize will refuse the notes: %s.\n", problem)
	}
	return nil
}

// checkPublicNotes is what finalize refuses in the public notes: a draft, or what the audit finds.
func checkPublicNotes(text string, repo string) error {
	notes := ParsePublicNotes(text)
	if notes.IsDraft() {
		return fmt.Errorf("the notes are marked draft: true: rewrite them and remove that line")
	}
	if problems := AuditPublicNotes(notes.Body, repo); len(problems) > 0 {
		return fmt.Errorf("the notes cannot be public: %s", strings.Join(problems, "; "))
	}
	return nil
}

func (e *Env) originRepo(ctx context.Context, dir string) string {
	url, _ := e.git(ctx, dir, "remote", "get-url", "origin")
	return GithubRepo(url)
}

// PreparedNotesPath is where the public notes of a tag are in the release worktree.
func (e *Env) PreparedNotesPath(ctx context.Context, tag string) (string, error) {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return "", err
	}
	if _, _, err := p.releaseOf(tag); err != nil {
		return "", err
	}
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return "", err
	}
	path := filepath.Join(wt, p.NotesFile(tag))
	if !insideDir(wt, path) {
		return "", fmt.Errorf("versions.notes (%s) leaves the project", p.Notes)
	}
	return path, nil
}

type NotesOptions struct {
	// The commit subjects, whatever agent the project declares.
	Plain bool
	// Only audit the notes as they are, and say what finalize would refuse.
	Check bool
}

// Notes rewrites the notes of a prepared release (the Rewrite step beside them in Mission Control, or a terminal):
// the engineering record again, and the public notes by the agent or from the commit subjects. With Check, it only
// audits them.
func (e *Env) Notes(ctx context.Context, tag string, opts NotesOptions) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, _, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(wt, ".git")); err != nil {
		return fmt.Errorf("nothing is prepared: %s does not exist, prepare %s first", wt, tag)
	}
	for _, f := range p.Files {
		found, err := versions.ReadFileVersions(wt, f)
		if err != nil || len(found) == 0 || found[0] != v.String() {
			return fmt.Errorf("%s is not prepared in %s: prepare it first", tag, wt)
		}
	}
	notesPath := filepath.Join(wt, p.NotesFile(tag))
	if !insideDir(wt, notesPath) {
		return fmt.Errorf("versions.notes (%s) leaves the project", p.Notes)
	}
	if opts.Check {
		data, err := os.ReadFile(notesPath)
		if err != nil {
			return fmt.Errorf("%s is missing: prepare %s again", p.NotesFile(tag), tag)
		}
		if err := checkPublicNotes(string(data), e.originRepo(ctx, wt)); err != nil {
			return err
		}
		e.printf("The notes of %s can be public.\n", tag)
		return nil
	}
	notesPath, err = e.writeNotes(ctx, wt, p, tag, v, opts.Plain)
	if err != nil {
		return err
	}
	if data, err := os.ReadFile(notesPath); err == nil {
		e.printf("\n%s\n", strings.TrimSpace(ParsePublicNotes(string(data)).Body))
	}
	e.printf("\n%s%s\n", NotesMarker, notesPath)
	return nil
}

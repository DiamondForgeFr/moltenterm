// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package checkpoint is the workspace task checkpoint (FR-CONT-007, DS-CONT-008 to DS-CONT-010): one living task
// memory per workspace, every agent continues from it. MoltenTerm keeps it in its data folder, never in the
// workspace's folder, as Markdown the user can read and edit: a short front matter, then fixed sections, each with an
// owner comment. It is updated automatically from what MoltenTerm already observes (the end of an agent's turn, the
// pane's transcript, the folder's git branch), and never overwrites a section the user or an agent wrote. Secrets are
// redacted before every write.
package checkpoint

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The fixed sections, in their order (DS-CONT-008).
const (
	SectionGoal       = "Goal"
	SectionTicket     = "Ticket"
	SectionPlan       = "Plan and progress"
	SectionDecisions  = "Decisions"
	SectionFiles      = "Files touched"
	SectionQuestions  = "Open questions"
	SectionNext       = "Next steps"
	SectionTranscript = "Last transcript"
)

// Owners of a section; an agent is <agent>:<session>.
const (
	OwnerAuto = "auto"
	OwnerUser = "user"
)

const (
	documentTitle = "# Workspace task"
	documentNote  = "<!-- MoltenTerm keeps this file. Edit any section and save: automatic updates never overwrite a section you wrote. -->"
	hashLen       = 8
)

var SectionNames = []string{SectionGoal, SectionTicket, SectionPlan, SectionDecisions, SectionFiles, SectionQuestions, SectionNext, SectionTranscript}

var ownerCommentRegex = regexp.MustCompile(`^<!--\s*by\s+([A-Za-z0-9_.:@-]{1,200})(?:\s+at\s+(\S+))?(?:\s+sha\s+([0-9a-f]{` + fmt.Sprint(hashLen) + `}))?\s*-->$`)

// Section is one section. Owner "" is a section nobody wrote.
type Section struct {
	Name  string
	Owner string
	At    int64
	Body  string
	Extra bool
}

// Checkpoint is the parsed file. Started: when the task began (0 for a task never cleared: everything counts).
type Checkpoint struct {
	Workspace  string
	Started    int64
	Updated    int64
	UpdatedBy  string
	Transcript molten.TaskTranscript
	// Preamble: text the user wrote above the first section, kept as is.
	Preamble string
	Sections []Section
	// HandEdited: the file was changed outside MoltenTerm's writes (a section's text no longer matches what was written).
	HandEdited bool
}

// MakeCheckpoint is an empty checkpoint with its fixed sections.
func MakeCheckpoint(workspace string) *Checkpoint {
	c := &Checkpoint{Workspace: workspace}
	for _, name := range SectionNames {
		c.Sections = append(c.Sections, Section{Name: name})
	}
	return c
}

// Section returns the section of a name (fixed sections exist even when the file lacked them).
func (c *Checkpoint) Section(name string) *Section {
	for i := range c.Sections {
		if strings.EqualFold(c.Sections[i].Name, name) {
			return &c.Sections[i]
		}
	}
	return nil
}

// Empty tells a checkpoint with nothing written in it.
func (c *Checkpoint) Empty() bool {
	for _, s := range c.Sections {
		if strings.TrimSpace(s.Body) != "" {
			return false
		}
	}
	return strings.TrimSpace(c.Preamble) == ""
}

func bodyHash(body string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(body)))
	return hex.EncodeToString(sum[:])[:hashLen]
}

func formatTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(time.RFC3339)
}

func parseTimeValue(value string) int64 {
	t, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func knownSectionName(name string) string {
	for _, known := range SectionNames {
		if strings.EqualFold(strings.TrimSpace(name), known) {
			return known
		}
	}
	return ""
}

// Parse reads a checkpoint file, hand-edited or not: a missing front matter or section is empty, an unknown section is
// kept after the fixed ones. A section auto wrote whose body no longer matches its hash was edited by hand: it is the
// user's from then on (DS-CONT-009), and so is a written section without an owner comment.
func Parse(data []byte) *Checkpoint {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	c := &Checkpoint{}
	text = c.parseFrontMatter(text)
	type rawSection struct {
		name  string
		lines []string
	}
	var preamble []string
	var raws []*rawSection
	var cur *rawSection
	fence := ""
	scanner := bufio.NewScanner(strings.NewReader(text))
	scanner.Buffer(make([]byte, 64*1024), MaxFileBytes)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if marker := fenceMarker(trimmed); marker != "" {
			if fence == "" {
				fence = marker
			} else if strings.HasPrefix(trimmed, fence) {
				fence = ""
			}
		}
		if fence == "" && strings.HasPrefix(line, "## ") {
			cur = &rawSection{name: strings.TrimSpace(strings.TrimPrefix(line, "## "))}
			raws = append(raws, cur)
			continue
		}
		if cur == nil {
			if trimmed == documentTitle || trimmed == documentNote {
				continue
			}
			preamble = append(preamble, line)
			continue
		}
		cur.lines = append(cur.lines, line)
	}
	c.Preamble = strings.TrimSpace(strings.Join(preamble, "\n"))
	known := map[string]*Section{}
	var extras []Section
	for _, raw := range raws {
		sec, edited := parseSection(raw.name, raw.lines)
		c.HandEdited = c.HandEdited || edited
		name := knownSectionName(raw.name)
		if name == "" || known[name] != nil {
			sec.Extra = true
			extras = append(extras, sec)
			continue
		}
		sec.Name = name
		known[name] = &sec
	}
	for _, name := range SectionNames {
		if sec := known[name]; sec != nil {
			c.Sections = append(c.Sections, *sec)
			continue
		}
		c.Sections = append(c.Sections, Section{Name: name})
	}
	c.Sections = append(c.Sections, extras...)
	return c
}

func fenceMarker(trimmed string) string {
	for _, marker := range []string{"```", "~~~"} {
		if strings.HasPrefix(trimmed, marker) {
			return marker
		}
	}
	return ""
}

func parseSection(name string, lines []string) (Section, bool) {
	sec := Section{Name: name}
	start := 0
	for start < len(lines) && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	hash := ""
	commented := false
	if start < len(lines) {
		if m := ownerCommentRegex.FindStringSubmatch(strings.TrimSpace(lines[start])); m != nil {
			sec.Owner, sec.At, hash = m[1], parseTimeValue(m[2]), m[3]
			commented = true
			start++
		}
	}
	sec.Body = strings.TrimSpace(strings.Join(lines[start:], "\n"))
	switch {
	case sec.Body == "":
		if sec.Owner == OwnerAuto {
			sec.Owner = ""
		}
	case !commented:
		sec.Owner = OwnerUser
		return sec, true
	case sec.Owner == OwnerAuto && hash != bodyHash(sec.Body):
		sec.Owner = OwnerUser
		sec.At = 0
		return sec, true
	}
	return sec, false
}

func (c *Checkpoint) parseFrontMatter(text string) string {
	if !strings.HasPrefix(text, "---\n") {
		return text
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return text
	}
	header := text[4 : 4+end]
	rest := text[4+end+4:]
	rest = strings.TrimPrefix(rest, "\n")
	inTranscript := false
	for _, line := range strings.Split(header, "\n") {
		indented := strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = unquoteYaml(strings.TrimSpace(value))
		if indented && inTranscript {
			switch key {
			case "agent":
				c.Transcript.Agent = value
			case "session":
				c.Transcript.Session = value
			case "path":
				c.Transcript.Path = value
			}
			continue
		}
		inTranscript = false
		switch key {
		case "workspace":
			c.Workspace = value
		case "started":
			c.Started = parseTimeValue(value)
		case "updated":
			c.Updated = parseTimeValue(value)
		case "updatedby":
			c.UpdatedBy = value
		case "transcript":
			inTranscript = true
		}
	}
	return rest
}

func unquoteYaml(value string) string {
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		inner := value[1 : len(value)-1]
		inner = strings.ReplaceAll(inner, `\"`, `"`)
		return strings.ReplaceAll(inner, `\\`, `\`)
	}
	return value
}

// quoteYaml quotes a front matter value: always, so a path or an id with a colon or a hash stays one value.
func quoteYaml(value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, `\`, `\\`)
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

// Render writes the file. The hash of each auto section is computed from its body as written, so a later hand edit
// is told apart.
func (c *Checkpoint) Render() []byte {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "workspace: %s\n", quoteYaml(c.Workspace))
	if c.Started > 0 {
		fmt.Fprintf(&b, "started: %s\n", formatTime(c.Started))
	}
	if c.Updated > 0 {
		fmt.Fprintf(&b, "updated: %s\n", formatTime(c.Updated))
	}
	if c.UpdatedBy != "" {
		fmt.Fprintf(&b, "updatedby: %s\n", quoteYaml(c.UpdatedBy))
	}
	if c.Transcript != (molten.TaskTranscript{}) {
		b.WriteString("transcript:\n")
		fmt.Fprintf(&b, "  agent: %s\n", quoteYaml(c.Transcript.Agent))
		fmt.Fprintf(&b, "  session: %s\n", quoteYaml(c.Transcript.Session))
		fmt.Fprintf(&b, "  path: %s\n", quoteYaml(c.Transcript.Path))
	}
	b.WriteString("---\n\n")
	b.WriteString(documentTitle + "\n\n")
	b.WriteString(documentNote + "\n")
	if c.Preamble != "" {
		b.WriteString("\n" + c.Preamble + "\n")
	}
	for _, sec := range c.Sections {
		b.WriteString("\n## " + oneLineName(sec.Name) + "\n")
		body := strings.TrimSpace(sec.Body)
		if sec.Owner != "" && body != "" {
			b.WriteString(ownerComment(sec, body) + "\n")
		}
		if body != "" {
			b.WriteString("\n" + escapeHeadings(body) + "\n")
		}
	}
	return []byte(b.String())
}

func ownerComment(sec Section, body string) string {
	var b strings.Builder
	b.WriteString("<!-- by " + sec.Owner)
	if sec.At > 0 {
		b.WriteString(" at " + formatTime(sec.At))
	}
	if sec.Owner == OwnerAuto {
		b.WriteString(" sha " + bodyHash(escapeHeadings(body)))
	}
	b.WriteString(" -->")
	return b.String()
}

func oneLineName(name string) string {
	return strings.Join(strings.Fields(name), " ")
}

// escapeHeadings keeps a body's own "## " lines (outside code fences) from starting a new section when read back.
func escapeHeadings(body string) string {
	if !strings.Contains(body, "## ") {
		return body
	}
	lines := strings.Split(body, "\n")
	fence := ""
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if marker := fenceMarker(trimmed); marker != "" {
			if fence == "" {
				fence = marker
			} else if strings.HasPrefix(trimmed, fence) {
				fence = ""
			}
		}
		if fence == "" && strings.HasPrefix(line, "## ") {
			lines[i] = "#" + line
		}
	}
	return strings.Join(lines, "\n")
}

// redactAll redacts every part of the checkpoint a person could have pasted a secret into.
func (c *Checkpoint) redactAll() int {
	count := 0
	redact := func(text string) string {
		out, n := Redact(text)
		count += n
		return out
	}
	c.Preamble = redact(c.Preamble)
	for i := range c.Sections {
		c.Sections[i].Body = redact(c.Sections[i].Body)
		c.Sections[i].Name = redact(c.Sections[i].Name)
	}
	c.Transcript.Path = redact(c.Transcript.Path)
	c.Transcript.Session = redact(c.Transcript.Session)
	return count
}

// View is what the read API returns.
func (c *Checkpoint) View() []molten.TaskSection {
	rtn := make([]molten.TaskSection, 0, len(c.Sections))
	for _, s := range c.Sections {
		rtn = append(rtn, molten.TaskSection{Name: s.Name, Owner: s.Owner, At: s.At, Text: s.Body, Extra: s.Extra})
	}
	return rtn
}

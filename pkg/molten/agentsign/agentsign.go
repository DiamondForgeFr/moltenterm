// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentsign is who made a pull request and who reviewed it (#847). Agents commit and open PRs with the
// developer's GitHub account, so the work carries its own signature: a commit trailer
// (Molten-Agent: Valentin (Claude Code, Opus 5.5, medium)) and a block at the end of the PR body (Made by …, Earlier:
// …, Reviewed by …). A part MoltenTerm does not know is left out, never guessed.
package agentsign

import (
	"regexp"
	"strings"
)

const (
	TrailerKey = "Molten-Agent"
	BlockStart = "<!-- molten:agents -->"
	BlockEnd   = "<!-- /molten:agents -->"

	madeByPrefix     = "Made by "
	earlierPrefix    = "Earlier: "
	reviewedByPrefix = "Reviewed by "
	partSep          = " · "
	earlierSep       = "; "
	// The line agents' PR bodies end with: the block goes above it.
	generatedPrefix = "🤖 Generated with"
)

// Signature is one agent's identity on a piece of work.
type Signature struct {
	FirstName string `json:"firstname,omitempty"`
	// Agent: the CLI's display name (Claude Code, Codex).
	Agent  string `json:"agent,omitempty"`
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

// Review is the developer's validation, written by MoltenTerm.
type Review struct {
	Name string `json:"name"`
	// Date: YYYY-MM-DD.
	Date string `json:"date"`
	Url  string `json:"url,omitempty"`
}

// Block is what a PR body's signature block says.
type Block struct {
	// Agents: the last agent first.
	Agents   []Signature `json:"agents,omitempty"`
	Reviewed *Review     `json:"reviewed,omitempty"`
}

var lineBreakRe = regexp.MustCompile(`[\r\n]+`)

// clean keeps a part on one line and out of the trailer's and the block's separators.
func clean(text string) string {
	text = lineBreakRe.ReplaceAllString(text, " ")
	text = strings.NewReplacer("·", "-", ";", ",", "(", "", ")", "", ",", " ", "<", "", ">", "").Replace(text)
	return strings.Join(strings.Fields(text), " ")
}

func (s Signature) cleaned() Signature {
	return Signature{FirstName: clean(s.FirstName), Agent: clean(s.Agent), Model: clean(s.Model), Effort: clean(s.Effort)}
}

func (s Signature) IsZero() bool {
	c := s.cleaned()
	return c.FirstName == "" && c.Agent == ""
}

func (s Signature) details() []string {
	c := s.cleaned()
	var parts []string
	for _, p := range []string{c.Agent, c.Model, c.Effort} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

// Line: "Valentin · Claude Code · Opus 5.5 · medium".
func (s Signature) Line() string {
	c := s.cleaned()
	var parts []string
	if c.FirstName != "" {
		parts = append(parts, c.FirstName)
	}
	return strings.Join(append(parts, s.details()...), partSep)
}

// TrailerValue: "Valentin (Claude Code, Opus 5.5, medium)".
func (s Signature) TrailerValue() string {
	c := s.cleaned()
	details := strings.Join(s.details(), ", ")
	switch {
	case c.FirstName == "":
		return details
	case details == "":
		return c.FirstName
	}
	return c.FirstName + " (" + details + ")"
}

// Trailer: "Molten-Agent: Valentin (Claude Code, Opus 5.5, medium)".
func (s Signature) Trailer() string {
	return TrailerKey + ": " + s.TrailerValue()
}

// SameAgent: the same session's agent, whatever model or effort it used since.
func (s Signature) SameAgent(o Signature) bool {
	return strings.EqualFold(s.FirstName, o.FirstName) && strings.EqualFold(s.Agent, o.Agent)
}

// ParseTrailerValue reads "Valentin (Claude Code, Opus 5.5, medium)" back. The parts in parentheses are the agent,
// the model and the effort, in that order.
func ParseTrailerValue(value string) (Signature, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return Signature{}, false
	}
	open := strings.Index(value, "(")
	if open < 0 || !strings.HasSuffix(value, ")") {
		return Signature{FirstName: value}, true
	}
	sig := Signature{FirstName: strings.TrimSpace(value[:open])}
	var parts []string
	for _, p := range strings.Split(value[open+1:len(value)-1], ",") {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	fields := []*string{&sig.Agent, &sig.Model, &sig.Effort}
	for i, p := range parts {
		if i < len(fields) {
			*fields[i] = p
		}
	}
	if sig.FirstName == "" && sig.Agent == "" {
		return Signature{}, false
	}
	return sig, true
}

// parseLine reads "Valentin · Claude Code · Opus 5.5 · medium" back.
func parseLine(line string) (Signature, bool) {
	parts := strings.Split(strings.TrimSpace(line), "·")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	if len(parts) == 0 || parts[0] == "" {
		return Signature{}, false
	}
	sig := Signature{FirstName: parts[0]}
	fields := []*string{&sig.Agent, &sig.Model, &sig.Effort}
	for i, p := range parts[1:] {
		if i < len(fields) {
			*fields[i] = p
		}
	}
	return sig, true
}

// CommitAgents reads the Molten-Agent trailers of a commit message, in their order.
func CommitAgents(message string) []Signature {
	var rtn []Signature
	for _, line := range strings.Split(message, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), TrailerKey) {
			continue
		}
		if sig, ok := ParseTrailerValue(value); ok {
			rtn = append(rtn, sig)
		}
	}
	return rtn
}

// blockBounds finds the block in a body: the start of its first marker and the end of its last.
func blockBounds(body string) (int, int, bool) {
	start := strings.Index(body, BlockStart)
	if start < 0 {
		return 0, 0, false
	}
	end := strings.Index(body[start:], BlockEnd)
	if end < 0 {
		return 0, 0, false
	}
	return start, start + end + len(BlockEnd), true
}

// ParseBlock reads the signature block of a PR body.
func ParseBlock(body string) (Block, bool) {
	start, end, ok := blockBounds(body)
	if !ok {
		return Block{}, false
	}
	var rtn Block
	for _, line := range strings.Split(body[start+len(BlockStart):end-len(BlockEnd)], "\n") {
		line = strings.TrimSpace(strings.TrimRight(strings.TrimSpace(line), "\\"))
		line = strings.TrimSuffix(strings.TrimPrefix(line, "<sub>"), "</sub>")
		switch {
		case strings.HasPrefix(line, madeByPrefix):
			if sig, ok := parseLine(strings.TrimPrefix(line, madeByPrefix)); ok {
				rtn.Agents = append([]Signature{sig}, rtn.Agents...)
			}
		case strings.HasPrefix(line, earlierPrefix):
			for _, part := range strings.Split(strings.TrimPrefix(line, earlierPrefix), earlierSep) {
				if sig, ok := parseLine(part); ok {
					rtn.Agents = append(rtn.Agents, sig)
				}
			}
		case strings.HasPrefix(line, reviewedByPrefix):
			rtn.Reviewed = parseReview(strings.TrimPrefix(line, reviewedByPrefix))
		}
	}
	return rtn, true
}

var reviewLinkRe = regexp.MustCompile(`\[[^\]]*\]\(([^)\s]+)\)`)

func parseReview(text string) *Review {
	parts := strings.Split(text, partSep)
	review := &Review{Name: strings.TrimSpace(parts[0])}
	for _, p := range parts[1:] {
		p = strings.TrimSpace(p)
		if m := reviewLinkRe.FindStringSubmatch(p); m != nil {
			review.Url = m[1]
		} else if review.Date == "" {
			review.Date = p
		}
	}
	if review.Name == "" {
		return nil
	}
	return review
}

func renderBlock(b Block) string {
	var lines []string
	if len(b.Agents) > 0 {
		lines = append(lines, madeByPrefix+b.Agents[0].Line())
		if len(b.Agents) > 1 {
			var earlier []string
			for _, a := range b.Agents[1:] {
				earlier = append(earlier, a.Line())
			}
			lines = append(lines, earlierPrefix+strings.Join(earlier, earlierSep))
		}
	}
	if r := b.Reviewed; r != nil && clean(r.Name) != "" {
		line := reviewedByPrefix + clean(r.Name)
		if r.Date != "" {
			line += partSep + clean(r.Date)
		}
		if r.Url != "" && !strings.ContainsAny(r.Url, " ()\n") {
			line += partSep + "[review](" + r.Url + ")"
		}
		lines = append(lines, line)
	}
	// Markdown joins consecutive lines: a trailing backslash keeps each on its own line.
	for i := 0; i < len(lines)-1; i++ {
		lines[i] += "\\"
	}
	return BlockStart + "\n---\n" + strings.Join(lines, "\n") + "\n" + BlockEnd
}

// withBlock puts the block in the body: in place of the old one, else at the end (above a trailing "Generated with"
// line).
func withBlock(body string, b Block) string {
	block := renderBlock(b)
	if start, end, ok := blockBounds(body); ok {
		return body[:start] + block + body[end:]
	}
	trimmed := strings.TrimRight(body, " \t\r\n")
	if trimmed == "" {
		return block + "\n"
	}
	lines := strings.Split(trimmed, "\n")
	last := len(lines) - 1
	if strings.HasPrefix(strings.TrimSpace(lines[last]), generatedPrefix) {
		head := strings.TrimRight(strings.Join(lines[:last], "\n"), " \t\r\n")
		if head == "" {
			return block + "\n\n" + lines[last] + "\n"
		}
		return head + "\n\n" + block + "\n\n" + lines[last] + "\n"
	}
	return trimmed + "\n\n" + block + "\n"
}

// WithAgent makes sig the PR's last agent; earlier agents stay, newest first, each once.
func WithAgent(body string, sig Signature) string {
	b, _ := ParseBlock(body)
	agents := []Signature{sig.cleaned()}
	for _, a := range b.Agents {
		if !a.SameAgent(sig.cleaned()) {
			agents = append(agents, a)
		}
	}
	b.Agents = agents
	return withBlock(body, b)
}

// WithReview writes the developer's review in the block, replacing an earlier one.
func WithReview(body string, review Review) string {
	b, _ := ParseBlock(body)
	b.Reviewed = &review
	return withBlock(body, b)
}

// PrAgents is who worked on a PR, the last agent first: the trailers of its commits (oldest to newest), then the
// body's block for the agents no commit names. FromCommits: the last agent comes from a commit trailer.
func PrAgents(commitMessages []string, body string) ([]Signature, bool) {
	var rtn []Signature
	add := func(sig Signature) {
		for _, a := range rtn {
			if a.SameAgent(sig) {
				return
			}
		}
		rtn = append(rtn, sig)
	}
	for i := len(commitMessages) - 1; i >= 0; i-- {
		sigs := CommitAgents(commitMessages[i])
		for j := len(sigs) - 1; j >= 0; j-- {
			add(sigs[j])
		}
	}
	fromCommits := len(rtn) > 0
	if b, ok := ParseBlock(body); ok {
		for _, a := range b.Agents {
			add(a)
		}
	}
	return rtn, fromCommits
}

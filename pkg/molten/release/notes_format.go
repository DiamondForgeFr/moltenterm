// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// The public notes file (versions.notes, e.g. releases/v1.2.0.md) is markdown with an optional front matter:
//
//	---
//	date: 2026-10-20
//	draft: true
//	---
//	## What this version brings
//	…
//
// `date` is the day of the cut, stamped by prepare. `draft: true` marks notes written ahead of the cut that are not
// ready: finalize refuses them and the app's version history leaves them out. Other keys are kept and ignored. The
// release body and the app show the markdown after the front matter (frontend/moltenterm-shell/releases).

const (
	FrontMatterDate  = "date"
	FrontMatterDraft = "draft"
)

var frontMatterKeyRegex = regexp.MustCompile(`^([a-z][a-z0-9]*)\s*:\s*(.*?)\s*$`)

type FrontMatterField struct {
	Key   string
	Value string
}

// PublicNotes is a public notes file read: its front matter fields, in order, and its markdown.
type PublicNotes struct {
	Front []FrontMatterField
	Body  string
}

// ParsePublicNotes splits a notes file into its front matter and its markdown. A file whose first line is not `---`, or
// whose front matter is never closed, has none.
func ParsePublicNotes(text string) PublicNotes {
	text = strings.TrimPrefix(strings.ReplaceAll(text, "\r\n", "\n"), string(rune(0xFEFF)))
	if !strings.HasPrefix(text, "---\n") {
		return PublicNotes{Body: text}
	}
	rest := text[len("---\n"):]
	var front []FrontMatterField
	for {
		line, after, found := strings.Cut(rest, "\n")
		if strings.TrimSpace(line) == "---" {
			return PublicNotes{Front: front, Body: strings.TrimLeft(after, "\n")}
		}
		if !found {
			return PublicNotes{Body: text}
		}
		if m := frontMatterKeyRegex.FindStringSubmatch(line); m != nil {
			front = append(front, FrontMatterField{Key: m[1], Value: strings.Trim(m[2], `"'`)})
		}
		rest = after
	}
}

func (n PublicNotes) Get(key string) string {
	for _, f := range n.Front {
		if f.Key == key {
			return f.Value
		}
	}
	return ""
}

func (n *PublicNotes) Set(key string, value string) {
	for i := range n.Front {
		if n.Front[i].Key == key {
			n.Front[i].Value = value
			return
		}
	}
	n.Front = append(n.Front, FrontMatterField{Key: key, Value: value})
}

// IsDraft tells whether the notes are marked as not ready (`draft: true`).
func (n PublicNotes) IsDraft() bool {
	switch strings.ToLower(n.Get(FrontMatterDraft)) {
	case "true", "yes", "1":
		return true
	}
	return false
}

func (n PublicNotes) String() string {
	body := strings.TrimSpace(n.Body) + "\n"
	if len(n.Front) == 0 {
		return body
	}
	var sb strings.Builder
	sb.WriteString("---\n")
	for _, f := range n.Front {
		fmt.Fprintf(&sb, "%s: %s\n", f.Key, f.Value)
	}
	sb.WriteString("---\n\n")
	sb.WriteString(body)
	return sb.String()
}

var ticketReferenceRegex = regexp.MustCompile(`#\d+`)
var countRegex = regexp.MustCompile(`(?i)\b\d+\s+(?:commits?|tickets?|pull requests?)\b`)

// AuditPublicNotes lists what must never reach a public page, with the reason (Notulia's auditPublicNotes): ticket
// references, links into the project's repository (its issues and commits are the engineering record's, and a 404 to
// everyone when the repository is private), commit or ticket counts, more than MaxPublicNoteLines non-empty lines, and
// empty notes. It reads the markdown after the front matter; repo is "owner/repo" (or "host/owner/repo"), "" for none.
// Unlike Notulia, words such as CI, commit or pull request are allowed: a developer tool's users use them.
func AuditPublicNotes(markdown string, repo string) []string {
	var problems []string
	if strings.TrimSpace(markdown) == "" {
		return []string{"the notes are empty, which says less than publishing nothing at all"}
	}
	if repo != "" {
		host, ownerRepo := "github.com", repo
		if parts := strings.Split(repo, "/"); len(parts) == 3 {
			host, ownerRepo = parts[0], parts[1]+"/"+parts[2]
		}
		link := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(host+"/"+ownerRepo) + `(?:[^\w.-]|$)`)
		if n := len(link.FindAllString(markdown, -1)); n > 0 {
			problems = append(problems, fmt.Sprintf("%d link(s) into %s: its issues, pull requests and commits belong to the engineering record, and are a 404 for everyone while the repository is private", n, repo))
		}
	}
	refs := ticketReferences(markdown)
	if len(refs) > 0 {
		shown := refs
		more := ""
		if len(shown) > 5 {
			shown, more = shown[:5], ", …"
		}
		problems = append(problems, fmt.Sprintf("ticket reference(s) (%s%s): a number that means nothing to a reader, whose page they may not open", strings.Join(shown, ", "), more))
	}
	if counts := countRegex.FindAllString(markdown, -1); len(counts) > 0 {
		problems = append(problems, fmt.Sprintf("commit or ticket counts (%s): that is how the work was cut up, not what the version brings", strings.Join(counts, ", ")))
	}
	lines := 0
	for _, line := range strings.Split(markdown, "\n") {
		if strings.TrimSpace(line) != "" {
			lines++
		}
	}
	if lines > MaxPublicNoteLines {
		problems = append(problems, fmt.Sprintf("%d lines, against %d: past that, the reader scrolls a release page inside the update dialog; group the fixes in one line and leave out what nobody sees", lines, MaxPublicNoteLines))
	}
	return problems
}

func isWordByte(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// ticketReferences lists the `#123` of a text, distinct, leaving out URL fragments (`page#3`), entities (`&#38;`) and
// hex colours (`#4f46e5`, whose `#4` a looser pattern reads as ticket four).
func ticketReferences(text string) []string {
	refs := []string{}
	for _, loc := range ticketReferenceRegex.FindAllStringIndex(text, -1) {
		start, end := loc[0], loc[1]
		if start > 0 && (isWordByte(text[start-1]) || text[start-1] == '/' || text[start-1] == '&') {
			continue
		}
		if end < len(text) && (isWordByte(text[end]) || text[end] == '-') {
			continue
		}
		if ref := text[start:end]; !slices.Contains(refs, ref) {
			refs = append(refs, ref)
		}
	}
	return refs
}

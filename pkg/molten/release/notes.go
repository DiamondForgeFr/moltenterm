// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The notes of a release (FR-REL-003, DS-REL-003), after Notulia's release-highlights.mjs: one range of commits, two
// texts. The public notes (versions.notes) say what changed for someone using the app; the engineering record (beside
// them, .internal.md) lists every ticket and commit with links. The facts come from git and the GitHub API; only the
// prose of the public notes is written, by the project's own coding agent CLI (versions.notesagent), and it is audited
// before it can be committed. Without an agent, the public notes are the commit subjects grouped under New and Fixed.

const (
	// Notulia's MAX_PUBLIC_NOTE_LINES: past it, the reader scrolls a release page inside the update dialog.
	MaxPublicNoteLines = 25

	// The ticket titles of a range larger than this many tickets outside its milestone are not looked up one by one.
	maxTicketLookups = 60
)

var trailingTicketRegex = regexp.MustCompile(`\s*\(#\d+(?:\s*,\s*#\d+)*\)\s*$`)
var ticketRefRegex = regexp.MustCompile(`#(\d+)`)
var scopeRegex = regexp.MustCompile(`^[a-z]+\(([^)]*)\)`)

// NotesTicket is one ticket of the range, with what its commits said.
type NotesTicket struct {
	Number int
	Title  string
	Url    string
	// Conventional types its commits used, in order of appearance.
	Types []string
	// What its commits said, deduplicated, first spelling first.
	Descriptions []string
}

type NotesFacts struct {
	Tag     string
	Channel string
	Product string
	// The release the notes start from ("" for the first one).
	Since string
	// Commit subjects since then, newest first, merges excluded.
	Subjects []string
	// The repository on GitHub ("owner/repo", or "host/owner/repo"), "" off GitHub.
	Repo string
	// The milestone the version ships, when it was read.
	Milestone *Milestone
	// The tickets the commits claim, newest first.
	Tickets []NotesTicket
	// The closed issues of the milestone that no commit of the range claims.
	MilestoneOnly []MilestoneIssue
	// Subjects claiming no ticket.
	Untracked []string
}

func (f NotesFacts) sinceLabel() string {
	if f.Since == "" {
		return "the start of the history"
	}
	return f.Since
}

func (f NotesFacts) repoUrl() string {
	if f.Repo == "" {
		return ""
	}
	if strings.Count(f.Repo, "/") == 1 {
		return "https://github.com/" + f.Repo
	}
	return "https://" + f.Repo
}

// previousRelease is the release the notes of v start from: the last public release for a public one, the last
// release of either channel for a candidate; only tags reachable from the cut count.
func (e *Env) previousRelease(ctx context.Context, wt string, p *Project, v versions.Version) string {
	best := ""
	var bestVersion versions.Version
	for _, tag := range e.releaseTags(ctx, wt, p, "--merged", "HEAD") {
		tv, _ := p.Rules.ReleaseOf(tag)
		if versions.Compare(tv, v) >= 0 || (!v.IsRc() && tv.IsRc()) {
			continue
		}
		if best == "" || versions.Compare(tv, bestVersion) > 0 {
			best, bestVersion = tag, tv
		}
	}
	return best
}

// commitTickets reads the tickets a subject claims: in its scope (`feat(#12,#13): …`) or at its end (`… (#12)`).
func commitTickets(subject string) []int {
	var refs []string
	if m := scopeRegex.FindStringSubmatch(subject); m != nil {
		refs = append(refs, m[1])
	}
	if m := trailingTicketRegex.FindString(subject); m != "" {
		refs = append(refs, m)
	}
	var rtn []int
	for _, ref := range refs {
		for _, m := range ticketRefRegex.FindAllStringSubmatch(ref, -1) {
			n, err := strconv.Atoi(m[1])
			if err == nil && n > 0 && !slices.Contains(rtn, n) {
				rtn = append(rtn, n)
			}
		}
	}
	return rtn
}

// readRange sorts the subjects into tickets and untracked work, newest first (Notulia's readRange).
func readRange(subjects []string) ([]NotesTicket, []string) {
	var tickets []NotesTicket
	index := map[int]int{}
	var untracked []string
	for _, raw := range subjects {
		subject := strings.TrimSpace(raw)
		if subject == "" {
			continue
		}
		c, ok := versions.ParseCommit(versions.CommitInput{Subject: subject})
		refs := commitTickets(subject)
		if !ok || len(refs) == 0 {
			untracked = append(untracked, subject)
			continue
		}
		description := strings.TrimSpace(trailingTicketRegex.ReplaceAllString(c.Subject, ""))
		for _, n := range refs {
			i, found := index[n]
			if !found {
				i = len(tickets)
				index[n] = i
				tickets = append(tickets, NotesTicket{Number: n})
			}
			t := &tickets[i]
			if !slices.Contains(t.Types, c.Type) {
				t.Types = append(t.Types, c.Type)
			}
			if description != "" && !slices.Contains(t.Descriptions, description) {
				t.Descriptions = append(t.Descriptions, description)
			}
		}
	}
	return tickets, untracked
}

type githubIssue struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	HtmlUrl     string          `json:"html_url"`
	PullRequest json.RawMessage `json:"pull_request"`
}

func (i githubIssue) isPullRequest() bool {
	return len(i.PullRequest) > 0 && string(i.PullRequest) != "null"
}

// decodeIssuePages reads what `gh api --paginate` prints: one JSON array per page, one after the other.
func decodeIssuePages(data []byte) ([]githubIssue, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	var all []githubIssue
	for {
		var page []githubIssue
		err := dec.Decode(&page)
		if err == io.EOF {
			return all, nil
		}
		if err != nil {
			return all, err
		}
		all = append(all, page...)
	}
}

// addGithubFacts names the tickets (their titles and links) and adds the milestone's closed issues no commit claims.
// Nothing here is required: off GitHub, or when gh fails, the record lists the tickets by number only.
func (e *Env) addGithubFacts(ctx context.Context, wt string, facts *NotesFacts, v versions.Version) {
	url, _ := e.git(ctx, wt, "remote", "get-url", "origin")
	facts.Repo = GithubRepo(url)
	if facts.Repo == "" {
		return
	}
	known := map[int]githubIssue{}
	m, err := e.MilestoneOf(ctx, wt, v.Base().String())
	if err != nil {
		e.printf("Milestone not read (%v): the record lists the tickets without their milestone.\n", err)
	}
	if m != nil {
		facts.Milestone = m
		out, err := e.gh(ctx, wt, "api", fmt.Sprintf("repos/{owner}/{repo}/issues?milestone=%d&state=closed&per_page=100", m.Number), "--paginate")
		issues, decodeErr := decodeIssuePages(out)
		if err != nil || decodeErr != nil {
			e.printf("The closed issues of %s were not read: the record names only the tickets the commits claim.\n", m.Title)
		}
		for _, issue := range issues {
			if !issue.isPullRequest() {
				known[issue.Number] = issue
			}
		}
	}
	lookups := 0
	for i := range facts.Tickets {
		t := &facts.Tickets[i]
		issue, ok := known[t.Number]
		if !ok && lookups < maxTicketLookups {
			lookups++
			out, err := e.gh(ctx, wt, "api", fmt.Sprintf("repos/{owner}/{repo}/issues/%d", t.Number))
			if err == nil && json.Unmarshal(out, &issue) == nil && issue.Number == t.Number {
				ok = true
			}
		}
		if ok {
			t.Title, t.Url = issue.Title, issue.HtmlUrl
		}
	}
	claimed := map[int]bool{}
	for _, t := range facts.Tickets {
		claimed[t.Number] = true
	}
	for _, issue := range known {
		if !claimed[issue.Number] {
			facts.MilestoneOnly = append(facts.MilestoneOnly, MilestoneIssue{Number: issue.Number, Title: issue.Title, Url: issue.HtmlUrl})
		}
	}
	slices.SortFunc(facts.MilestoneOnly, func(a, b MilestoneIssue) int { return b.Number - a.Number })
}

func (e *Env) gatherNotesFacts(ctx context.Context, wt string, p *Project, tag string, v versions.Version) (NotesFacts, error) {
	facts := NotesFacts{Tag: tag, Channel: versions.ChannelPublic, Product: p.Name, Since: e.previousRelease(ctx, wt, p, v)}
	if v.IsRc() {
		facts.Channel = versions.ChannelRc
	}
	rangeArg := "HEAD"
	if facts.Since != "" {
		rangeArg = facts.Since + "..HEAD"
	}
	args := []string{"log", "--no-merges", "--format=%s", rangeArg}
	// A fork's upstream history is not the project's own: the first release would otherwise list every upstream
	// commit since the beginning.
	if remotes, _ := e.gitLines(ctx, wt, "remote"); slices.Contains(remotes, "upstream") {
		args = append(args, "--not", "--remotes=upstream")
	}
	subjects, err := e.gitLines(ctx, wt, args...)
	if err != nil {
		return facts, fmt.Errorf("could not read the commits since %s: %w", facts.sinceLabel(), err)
	}
	facts.Subjects = subjects
	facts.Tickets, facts.Untracked = readRange(subjects)
	if e.OnGithub(ctx, wt) {
		e.addGithubFacts(ctx, wt, &facts, v)
	}
	return facts, nil
}

func noteLine(subject string) string {
	subject = strings.TrimSpace(trailingTicketRegex.ReplaceAllString(subject, ""))
	first, size := utf8.DecodeRuneInString(subject)
	if first == utf8.RuneError {
		return subject
	}
	return string(unicode.ToUpper(first)) + subject[size:]
}

// DraftNotes is the public notes without an agent: the conventional subjects a user would notice (feat under New, then
// fix, perf and revert under Fixed) without their scope or ticket number, within MaxPublicNoteLines; the rest (chore,
// ci, docs, refactor…, and subjects outside the convention) is left out. A subject that names a ticket elsewhere is
// left out too: the audit would refuse it.
func DraftNotes(f NotesFacts) string {
	var added, fixed []string
	seen := map[string]bool{}
	for _, subject := range f.Subjects {
		c, ok := versions.ParseCommit(versions.CommitInput{Subject: subject})
		if !ok {
			continue
		}
		line := noteLine(c.Subject)
		key := strings.ToLower(line)
		if line == "" || seen[key] || len(AuditPublicNotes(line, f.Repo)) > 0 {
			continue
		}
		switch c.Type {
		case "feat":
			added = append(added, line)
		case "fix", "perf", "revert":
			fixed = append(fixed, line)
		default:
			continue
		}
		seen[key] = true
	}
	if len(added)+len(fixed) == 0 {
		return "Maintenance release: nothing changes for users.\n"
	}
	// Every heading and the closing line count against the audit's limit.
	budget := MaxPublicNoteLines - 1
	for _, lines := range [][]string{added, fixed} {
		if len(lines) > 0 {
			budget--
		}
	}
	var sb strings.Builder
	left := 0
	section := func(title string, lines []string) {
		if len(lines) == 0 {
			return
		}
		if budget <= 0 {
			left += len(lines)
			return
		}
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		fmt.Fprintf(&sb, "## %s\n\n", title)
		for i, line := range lines {
			if budget == 0 {
				left += len(lines) - i
				break
			}
			fmt.Fprintf(&sb, "- %s\n", line)
			budget--
		}
	}
	section("New", added)
	section("Fixed", fixed)
	if left > 0 {
		fmt.Fprintf(&sb, "\nAnd more changes and fixes.\n")
	}
	return sb.String()
}

// InternalRecord is the engineering record of a release: deterministic, no agent writes it (Notulia's internalRecord).
func InternalRecord(f NotesFacts) string {
	base := f.repoUrl()
	issue := func(n int, url string) string {
		if url == "" && base != "" {
			url = fmt.Sprintf("%s/issues/%d", base, n)
		}
		if url == "" {
			return fmt.Sprintf("#%d", n)
		}
		return fmt.Sprintf("[#%d](%s)", n, url)
	}
	plural := func(n int, word string) string {
		if n == 1 {
			return fmt.Sprintf("1 %s", word)
		}
		return fmt.Sprintf("%d %ss", n, word)
	}
	byType := map[string]int{}
	for _, subject := range f.Subjects {
		if c, ok := versions.ParseCommit(versions.CommitInput{Subject: subject}); ok {
			byType[c.Type]++
		}
	}
	types := make([]string, 0, len(byType))
	for t := range byType {
		types = append(types, t)
	}
	slices.SortFunc(types, func(a, b string) int {
		if byType[a] != byType[b] {
			return byType[b] - byType[a]
		}
		return strings.Compare(a, b)
	})
	counts := make([]string, 0, len(types))
	for _, t := range types {
		counts = append(counts, fmt.Sprintf("%d %s", byType[t], t))
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "## %s — engineering record\n\n", f.Tag)
	since := "Since the start of the history"
	if f.Since != "" {
		since = fmt.Sprintf("Since **%s**", f.Since)
	}
	fmt.Fprintf(&sb, "%s: %s, %s", since, plural(len(f.Subjects), "commit"), plural(len(f.Tickets), "ticket"))
	if len(counts) > 0 {
		fmt.Fprintf(&sb, " — %s", strings.Join(counts, ", "))
	}
	sb.WriteString(".\n")
	if f.Milestone != nil {
		fmt.Fprintf(&sb, "\nMilestone: [%s](%s).\n", f.Milestone.Title, f.Milestone.Url)
	}
	if len(f.Tickets) > 0 {
		sb.WriteString("\n### Tickets\n\n")
		for _, t := range f.Tickets {
			fmt.Fprintf(&sb, "- %s · `%s`", issue(t.Number, t.Url), strings.Join(t.Types, "/"))
			if t.Title != "" {
				fmt.Fprintf(&sb, " — %s", t.Title)
			}
			sb.WriteString("\n")
			for _, d := range t.Descriptions {
				fmt.Fprintf(&sb, "  - %s\n", d)
			}
		}
	}
	if len(f.MilestoneOnly) > 0 {
		sb.WriteString("\n### Closed in the milestone, claimed by no commit of this range\n\n")
		for _, m := range f.MilestoneOnly {
			fmt.Fprintf(&sb, "- %s — %s\n", issue(m.Number, m.Url), m.Title)
		}
	}
	if len(f.Untracked) > 0 {
		sb.WriteString("\n### Commits claiming no ticket\n\n")
		for _, subject := range f.Untracked {
			fmt.Fprintf(&sb, "- %s\n", subject)
		}
	}
	if f.Since != "" && base != "" {
		fmt.Fprintf(&sb, "\n**Full diff:** %s/compare/%s...%s\n", base, f.Since, f.Tag)
	}
	return sb.String()
}

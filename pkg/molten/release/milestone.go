// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The milestone a release ships: reported when the release starts, closed once a public release is published. Its
// open issues are a warning, never a refusal: a milestone reports, it does not block (FR-REL-002).

const maxMilestoneIssues = 100

var milestonePrefixRegex = regexp.MustCompile(`^milestone\s+`)
var milestoneVersionPrefixRegex = regexp.MustCompile(`^v(\d)`)
var milestoneLineRegex = regexp.MustCompile(`^\d+(\.\d+)?$`)

type MilestoneIssue struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url"`
}

type Milestone struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	Url    string `json:"url"`
	// GitHub's count of open issues and pull requests in it.
	OpenCount int              `json:"opencount"`
	Issues    []MilestoneIssue `json:"issues"`
}

type githubMilestone struct {
	Number     int    `json:"number"`
	Title      string `json:"title"`
	HtmlUrl    string `json:"html_url"`
	OpenIssues int    `json:"open_issues"`
}

// MilestoneKey is the version a milestone's title names ("Milestone v1.2.0" → "1.2.0"), or its title lower-cased when
// it names none (frontend/moltenterm-shell/mission/github.ts milestoneKey).
func MilestoneKey(title string) string {
	key := strings.ToLower(strings.TrimSpace(title))
	key = milestonePrefixRegex.ReplaceAllString(key, "")
	return milestoneVersionPrefixRegex.ReplaceAllString(key, "$1")
}

// pickMilestone finds the milestone of a public version: the one its title names ("1.2.0", "v1.2.0"), else the one of
// its line ("v1" for 1.x.y). Unlike the overview's card, no other milestone stands in for it.
func pickMilestone(list []githubMilestone, version string) *githubMilestone {
	for i := range list {
		if MilestoneKey(list[i].Title) == version {
			return &list[i]
		}
	}
	for i := range list {
		key := MilestoneKey(list[i].Title)
		if milestoneLineRegex.MatchString(key) && strings.HasPrefix(version, key+".") {
			return &list[i]
		}
	}
	return nil
}

// MilestoneOf reads the open milestone of a public version (X.Y.Z) and its open issues; nil when there is none.
func (e *Env) MilestoneOf(ctx context.Context, dir string, version string) (*Milestone, error) {
	return e.milestoneOf(ctx, dir, version, false)
}

func (e *Env) milestoneOf(ctx context.Context, dir string, version string, exact bool) (*Milestone, error) {
	if _, err := versions.ParseBase(version); err != nil {
		return nil, fmt.Errorf("%q is not a public version (X.Y.Z)", version)
	}
	out, err := e.gh(ctx, dir, "api", "repos/{owner}/{repo}/milestones?state=open&per_page=100")
	if err != nil {
		return nil, err
	}
	var list []githubMilestone
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("gh api milestones: unreadable answer")
	}
	found := pickMilestone(list, version)
	if found != nil && exact && MilestoneKey(found.Title) != version {
		found = nil
	}
	if found == nil {
		return nil, nil
	}
	rtn := &Milestone{Number: found.Number, Title: found.Title, Url: found.HtmlUrl, OpenCount: found.OpenIssues, Issues: []MilestoneIssue{}}
	if found.OpenIssues == 0 {
		return rtn, nil
	}
	out, err = e.gh(ctx, dir, "api", fmt.Sprintf("repos/{owner}/{repo}/issues?milestone=%d&state=open&per_page=%d", found.Number, maxMilestoneIssues))
	if err != nil {
		return nil, err
	}
	var issues []struct {
		Number      int             `json:"number"`
		Title       string          `json:"title"`
		HtmlUrl     string          `json:"html_url"`
		PullRequest json.RawMessage `json:"pull_request"`
	}
	if err := json.Unmarshal(out, &issues); err != nil {
		return nil, fmt.Errorf("gh api issues: unreadable answer")
	}
	for _, issue := range issues {
		if len(issue.PullRequest) > 0 && string(issue.PullRequest) != "null" {
			continue
		}
		rtn.Issues = append(rtn.Issues, MilestoneIssue{Number: issue.Number, Title: issue.Title, Url: issue.HtmlUrl})
	}
	return rtn, nil
}

func (e *Env) warnOpenIssues(m *Milestone) {
	if len(m.Issues) == 0 {
		return
	}
	e.printf("Warning: %d open issue(s) in %s (reported, not blocking):\n", len(m.Issues), m.Title)
	for _, issue := range m.Issues {
		e.printf("  #%d %s\n", issue.Number, issue.Title)
	}
}

// CloseMilestone closes the milestone of a public release once its GitHub release is published (not a draft); a
// release candidate leaves it open, as the public release it leads to ships it.
func (e *Env) CloseMilestone(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, channel, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	if channel == versions.ChannelRc {
		e.printf("%s is a release candidate: the milestone stays open until %s is published.\n", tag, p.Rules.Tag(v.Base()))
		return nil
	}
	if !e.OnGithub(ctx, p.Root) {
		e.printf("origin is not on GitHub: no milestone to close.\n")
		return nil
	}
	out, err := e.gh(ctx, p.Root, "release", "view", tag, "--json", "isDraft,url")
	if err != nil {
		return fmt.Errorf("no GitHub release for %s yet: %w", tag, err)
	}
	var rel struct {
		IsDraft bool   `json:"isDraft"`
		Url     string `json:"url"`
	}
	if err := json.Unmarshal(out, &rel); err != nil {
		return fmt.Errorf("gh release view: unreadable answer")
	}
	if rel.IsDraft {
		return fmt.Errorf("the GitHub release of %s is still a draft: publish it first (%s)", tag, rel.Url)
	}
	// A milestone of the whole line ("v1") stays open for the next versions of the line.
	m, err := e.milestoneOf(ctx, p.Root, v.String(), true)
	if err != nil {
		return err
	}
	if m == nil {
		e.printf("No open milestone named %s: nothing to close.\n", v)
		return nil
	}
	e.warnOpenIssues(m)
	if _, err := e.gh(ctx, p.Root, "api", "--method", "PATCH", fmt.Sprintf("repos/{owner}/{repo}/milestones/%d", m.Number), "-f", "state=closed"); err != nil {
		return fmt.Errorf("could not close %s: %w", m.Title, err)
	}
	e.printf("Milestone %s closed (%s).\n", m.Title, m.Url)
	return nil
}

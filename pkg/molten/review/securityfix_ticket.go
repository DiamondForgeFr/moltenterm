// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/milestones"
	"github.com/wavetermdev/waveterm/pkg/molten/secfix"
	"github.com/wavetermdev/waveterm/pkg/molten/sfticket"
)

// The ticket of a set of advisories (FR-REV-036 AC9): an open ticket or pull request that already cites one of the
// advisories is the one, so nobody is asked twice for the same work; only when none does is a ticket made, through the
// project's ticket tool when it has one (a SaaSFoundry project's board) and as a plain GitHub issue otherwise, in the
// release being prepared. Its body is the advisories' table and holds no personal data.

const (
	// Said to the project's ticket tool when its SRS is enabled: the ticket has no source in the SRS.
	securityTicketSrsReason = "dependency advisories, no user-facing change"
	securityTicketTrees     = "molten-secfix-trees"
	securityTicketTimeout   = 3 * time.Minute
)

// securityTicketAnswer is the ticket of a fix and how it came about.
type securityTicketAnswer struct {
	number int
	url    string
	// created: MoltenTerm made it.
	created bool
	// external: someone's pull request, or an agent on the ticket's branch, is on it already.
	external bool
	pr       int
	prUrl    string
	branch   string
}

type ghFoundIssue struct {
	Number      int    `json:"number"`
	Url         string `json:"url"`
	Title       string `json:"title"`
	HeadRefName string `json:"headRefName"`
	IsDraft     bool   `json:"isDraft"`
	// Who wrote it, and, for a pull request, whether its head is in another repository (a fork).
	Author struct {
		Login string `json:"login"`
	} `json:"author"`
	IsCrossRepository   bool `json:"isCrossRepository"`
	HeadRepositoryOwner struct {
		Login string `json:"login"`
	} `json:"headRepositoryOwner"`
}

const (
	// writerTtl is how long what the repository said of a login's permission stands.
	writerTtl = 10 * time.Minute
)

// loginPattern is what a GitHub login looks like: nothing else is put in a path.
var loginPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$`)

// writerAnswer is what the repository answered for a login, and when.
type writerAnswer struct {
	at     time.Time
	writes bool
}

// authorWrites tells whether a login has write access to the repository (a collaborator, an organization member or a team
// that can push): an issue or a pull request of a login that has not is text anyone could have written, and is neither the
// ticket of a fix nor a fix on its way. An answer that cannot be read counts as no.
func (r *Restarter) authorWrites(ctx context.Context, dir string, repo string, login string) bool {
	if !loginPattern.MatchString(login) {
		return false
	}
	key := strings.ToLower(repo + "/" + login)
	now := r.env.Now()
	r.lock.Lock()
	hit, cached := r.secWriters[key]
	r.lock.Unlock()
	if cached && now.Sub(hit.at) < writerTtl {
		return hit.writes
	}
	out, err := r.ghAt(ctx, dir, "api", "repos/"+repo+"/collaborators/"+login+"/permission")
	if err != nil {
		return false
	}
	var answer struct {
		Permission string `json:"permission"`
		RoleName   string `json:"role_name"`
	}
	if json.Unmarshal(out, &answer) != nil {
		return false
	}
	writes := false
	for _, word := range []string{answer.Permission, answer.RoleName} {
		switch strings.ToLower(word) {
		case "admin", "maintain", "write":
			writes = true
		}
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	if r.secWriters == nil {
		r.secWriters = map[string]writerAnswer{}
	}
	r.secWriters[key] = writerAnswer{at: now, writes: writes}
	return writes
}

// trustedFound: an issue or a pull request that a person who can write to the repository wrote, and, for a pull request,
// whose head is in the repository itself. What anyone else wrote is data, and never makes a ticket or a fix.
func (r *Restarter) trustedFound(ctx context.Context, dir string, repo string, item ghFoundIssue, pullRequest bool) bool {
	if pullRequest {
		owner, _, _ := strings.Cut(repo, "/")
		if item.IsCrossRepository || (item.HeadRepositoryOwner.Login != "" && !strings.EqualFold(item.HeadRepositoryOwner.Login, owner)) {
			return false
		}
	}
	return r.authorWrites(ctx, dir, repo, item.Author.Login)
}

func (r *Restarter) ghAt(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if r.env.Gh == nil {
		return nil, fmt.Errorf("gh is not available here")
	}
	ctx, cancel := context.WithTimeout(ctx, securityTicketTimeout)
	defer cancel()
	return r.env.Gh(ctx, dir, args...)
}

// ghInRepo is gh with the repository named in the placeholders of the calls that use them ({owner} and {repo} of an api
// call): gh resolves a remote named upstream before origin, so the project's own repository is said, never guessed.
func (r *Restarter) ghInRepo(repo string) func(ctx context.Context, dir string, args ...string) ([]byte, error) {
	owner, name, _ := strings.Cut(repo, "/")
	return func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		named := make([]string, len(args))
		for i, arg := range args {
			named[i] = strings.NewReplacer("{owner}", owner, "{repo}", name).Replace(arg)
		}
		return r.ghAt(ctx, dir, named...)
	}
}

// citing lists the open issues or pull requests (kind "issue" or "pr") that cite one of the advisories, lowest number
// first; one search per advisory, for the first few of the set.
func (r *Restarter) citing(ctx context.Context, dir string, repo string, kind string, ids []string) ([]ghFoundIssue, error) {
	seen := map[int]bool{}
	var found []ghFoundIssue
	fields := "number,url,title,author"
	if kind == "pr" {
		fields += ",headRefName,isDraft,isCrossRepository,headRepositoryOwner"
	}
	for i, id := range ids {
		if i == securitySearchIds {
			break
		}
		out, err := r.ghAt(ctx, dir, kind, "list", "--repo", repo, "--state", "open", "--search", id+" in:title,body", "--json", fields,
			"--limit", strconv.Itoa(securitySearchLimit))
		if err != nil {
			return nil, err
		}
		var list []ghFoundIssue
		if err := json.Unmarshal(out, &list); err != nil {
			return nil, fmt.Errorf("gh %s list: unreadable answer", kind)
		}
		for _, item := range list {
			if item.Number > 0 && !seen[item.Number] {
				seen[item.Number] = true
				found = append(found, item)
			}
		}
	}
	for i := 1; i < len(found); i++ {
		for j := i; j > 0 && found[j].Number < found[j-1].Number; j-- {
			found[j], found[j-1] = found[j-1], found[j]
		}
	}
	return found, nil
}

func blockPrNumbers(block secfix.Block) []int {
	numbers := make([]int, 0, len(block.Prs))
	for _, pr := range block.Prs {
		numbers = append(numbers, pr.Number)
	}
	return numbers
}

// securityTicket finds or makes the set's ticket. A fix that already has one (an earlier try made it) keeps it.
func (r *Restarter) securityTicket(ctx context.Context, in securityLaunch, fix *secfix.Fix) (securityTicketAnswer, error) {
	if fix.Ticket > 0 {
		return securityTicketAnswer{number: fix.Ticket, url: fix.TicketUrl, created: fix.TicketNew}, nil
	}
	ids := secfix.Ids(in.block.Advisories)
	// A pull request that cites the advisories is a fix already on its way: MoltenTerm starts nothing beside it. The
	// pull requests the scan blocks are not that, whatever their text says.
	prs, err := r.citing(ctx, in.dir, in.repo, "pr", ids)
	if err != nil {
		return securityTicketAnswer{}, fmt.Errorf("the open pull requests could not be searched: %w", err)
	}
	blocked := map[int]bool{}
	for _, n := range blockPrNumbers(in.block) {
		blocked[n] = true
	}
	for _, pr := range prs {
		// Only a pull request of the repository itself, by someone who can write to it, is a fix on its way: a fork's text
		// citing the advisories (anyone can write one) neither stands for the fix nor ends it by being closed.
		if !blocked[pr.Number] && r.trustedFound(ctx, in.dir, in.repo, pr, true) {
			return securityTicketAnswer{number: pr.Number, url: pr.Url, external: true, pr: pr.Number, prUrl: pr.Url, branch: pr.HeadRefName}, nil
		}
	}
	issues, err := r.citing(ctx, in.dir, in.repo, "issue", ids)
	if err != nil {
		return securityTicketAnswer{}, fmt.Errorf("the open tickets could not be searched: %w", err)
	}
	for _, issue := range issues {
		if !r.trustedFound(ctx, in.dir, in.repo, issue, false) {
			continue
		}
		answer := securityTicketAnswer{number: issue.Number, url: issue.Url}
		if r.ticketHasAgent(ctx, in.dir, answer.number) {
			answer.external = true
		}
		return answer, nil
	}
	return r.createSecurityTicket(ctx, in, ids)
}

// ticketHasAgent: an agent already works on a branch named for the ticket.
func (r *Restarter) ticketHasAgent(ctx context.Context, dir string, ticket int) bool {
	if r.env.BranchAgents == nil {
		return false
	}
	agents, ok := r.env.BranchAgents(ctx, dir)
	if !ok {
		return false
	}
	for _, agent := range agents {
		if m := branchTicketPattern.FindStringSubmatch(agent.Branch); m != nil && !agent.Visiting {
			if n, _ := strconv.Atoi(m[1]); n == ticket {
				return true
			}
		}
	}
	return false
}

func (r *Restarter) createSecurityTicket(ctx context.Context, in securityLaunch, ids []string) (securityTicketAnswer, error) {
	title := secfix.TicketTitle(ids)
	body := secfix.TicketBody(in.block.Advisories, in.block.Check, in.trunk, in.block.TrunkFailing, blockPrNumbers(in.block))
	milestone := ""
	if r.env.Gh != nil {
		milestone = milestones.ReleaseBeingPrepared(ctx, r.ghInRepo(in.repo), in.dir)
	}
	if rel := sfticket.ToolOf(in.dir); rel != "" && r.env.SecurityFix.Run != nil {
		script := sfticket.CommittedScript(ctx, r.git, in.dir, rel, "origin/"+in.trunk)
		spec := sfticket.Spec{Type: sfticket.TypeIssue, Title: title, Body: body, Complexity: sfticket.ComplexityLow, Milestone: milestone,
			SrsBypassReason: securityTicketSrsReason}
		n, ok, _ := sfticket.Create(ctx, r.env.SecurityFix.Run, in.dir, script, filepath.Join(os.TempDir(), securityTicketTrees), spec)
		if ok {
			return securityTicketAnswer{number: n, url: ticketUrl(in.repo, n), created: true}, nil
		}
	}
	args := []string{"issue", "create", "--repo", in.repo, "--title", title, "--body", body}
	if milestone != "" {
		args = append(args, "--milestone", milestone)
	}
	out, err := r.ghAt(ctx, in.dir, args...)
	if err != nil {
		return securityTicketAnswer{}, fmt.Errorf("the ticket could not be created: %w", err)
	}
	address := lastLine(string(out))
	n := sfticket.IssueNumber(address)
	if n == 0 {
		return securityTicketAnswer{}, fmt.Errorf("the ticket was created but its number cannot be read from %q", secfix.CleanLine(address, 100))
	}
	return securityTicketAnswer{number: n, url: address, created: true}, nil
}

func ticketUrl(repo string, number int) string {
	return fmt.Sprintf("https://github.com/%s/issues/%d", repo, number)
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// securityExternal: a pull request, or an agent on the ticket, was there first. The fix stands for the set, MoltenTerm
// follows it and starts, readies and stops nothing.
func (r *Restarter) securityExternal(ctx context.Context, in securityLaunch, fix secfix.Fix, t securityTicketAnswer) SecurityFixResult {
	updated, _, err := r.fixStore().Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.State, f.Reason, f.External, f.Tries, f.RetryAt = secfix.FixWorking, "", true, 0, 0
		f.Ticket, f.TicketUrl, f.Pr, f.PrUrl, f.Branch = t.number, t.url, t.pr, t.prUrl, t.branch
		if t.pr > 0 {
			f.Ticket = 0
			f.TicketUrl = ""
		}
		return true
	})
	if errors.Is(err, secfix.ErrEnded) {
		return securityAnswer(SecurityFixStoppedStatus, updated)
	}
	r.followSecurityFix(in.dir, fix.Fingerprint)
	return securityAnswer(SecurityFixExternal, updated)
}

// securityAddendum: a fix is in flight for other advisories, and these join it (FR-REV-036 AC9): its ticket gets them as a
// comment, once, and the agent is told of them when it can be (securityfix_follow.go).
func (r *Restarter) securityAddendum(ctx context.Context, in securityLaunch, fix secfix.Fix, ids []string) {
	var fresh []string
	for _, id := range ids {
		if !fix.Covers([]string{id}) {
			fresh = append(fresh, id)
		}
	}
	if len(fresh) == 0 {
		return
	}
	updated, found, err := r.fixStore().Update(in.dir, fix.Fingerprint, func(f *secfix.Fix) bool {
		f.Extra = secfix.NormalizeIds(append(append([]string{}, f.Extra...), fresh...))
		return true
	})
	if err != nil || !found {
		return
	}
	if fix.External || updated.Ticket == 0 {
		return
	}
	var added []secfix.Advisory
	for _, advisory := range in.block.Advisories {
		for _, id := range fresh {
			if advisory.Id == id {
				added = append(added, advisory)
			}
		}
	}
	if _, err := r.ghAt(ctx, in.dir, "issue", "comment", strconv.Itoa(updated.Ticket), "--repo", in.repo, "--body", secfix.AddendumComment(added)); err != nil {
		// The advisories stay in the fix's Extra: the agent still hears of them; the comment is the ticket's courtesy.
		log.Printf("%s security fix %s: the ticket could not be told of the new advisories: %v\n", logPrefix, fix.Fingerprint, err)
	}
}

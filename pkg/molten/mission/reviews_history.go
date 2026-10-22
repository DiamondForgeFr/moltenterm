// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The merged history (#960, FR-REV-030): every PR merged into the project's PR target, opened from Recently merged.
// It is its own read, not the collector's: GitHub's GraphQL through the developer's gh, 100 PRs a page, in the
// background while the view asks, kept per project while wavesrv runs. Once complete, a later ask reads the newest
// pages only, until one brings nothing new. Where each PR ships is read for the whole history in a few git calls: the
// release tags in version order, each one's commits less those of the tags before it (the first tag that carries a
// commit, as ReadShips says it), then the release branch, then the target.

const (
	MergedHistoryCommand = "moltenmissionmergedhistory"

	// How a PR was merged, read from its merge commit's parents: a merge commit has two, a squash or a rebase one.
	MergeMethodMerge  = "merge"
	MergeMethodLinear = "linear"
)

const (
	mergedHistoryPage = 100
	// A history this long is cut: the oldest PRs are not read.
	mergedHistoryMaxPrs = 5000
	// A complete history is read again (its newest pages) when asked after this.
	mergedHistoryMaxAge     = 2 * time.Minute
	mergedHistoryGhTimeout  = time.Minute
	mergedHistoryGitTimeout = time.Minute
	// Tickets named only by a branch are read by number, this many per query.
	mergedHistoryTicketBatch = 50
)

type MergedHistoryRequest struct {
	Dir   string `json:"dir"`
	Force bool   `json:"force,omitempty"`
}

type MergedHistoryPr struct {
	ReviewMergedPr
	UpdatedAt   string   `json:"updatedat,omitempty"`
	TicketTitle string   `json:"tickettitle,omitempty"`
	TicketUrl   string   `json:"ticketurl,omitempty"`
	TicketType  string   `json:"tickettype,omitempty"`
	Milestone   string   `json:"milestone,omitempty"`
	Reviewers   []string `json:"reviewers,omitempty"`
	MergeMethod string   `json:"mergemethod,omitempty"`
}

type MergedHistoryAnswer struct {
	Dir    string `json:"dir"`
	Repo   string `json:"repo,omitempty"`
	Url    string `json:"url,omitempty"`
	Target string `json:"target,omitempty"`
	// Newest merge first.
	Prs []MergedHistoryPr `json:"prs"`
	// GitHub's count of the merged PRs into the target, as of the last page read.
	Total    int  `json:"total"`
	Loading  bool `json:"loading,omitempty"`
	Complete bool `json:"complete,omitempty"`
	// Cut: the history is longer than what is read.
	Cut bool `json:"cut,omitempty"`
	// The release tags of the project, oldest version first; empty for a project without releases.
	Tags      []string `json:"tags"`
	TagPrefix string   `json:"tagprefix,omitempty"`
	Error     string   `json:"error,omitempty"`
	// When the last read ended, in Unix milliseconds.
	At int64 `json:"at,omitempty"`
}

type mergedHistoryState struct {
	prs      map[int]MergedHistoryPr
	total    int
	cursor   string
	complete bool
	cut      bool
	loading  bool
	tags     []string
	ships    map[string]reviewShip
	err      string
	at       time.Time
	usedAt   time.Time
	repoRef  string
	target   string
	repo     string
	url      string
	prefix   string
	release  string
	noType   bool
	tickets  map[int]historyTicket
}

type historyTicket struct {
	Title     string
	Url       string
	Type      string
	Milestone string
}

type ghHistoryIssue struct {
	Number    int    `json:"number"`
	Title     string `json:"title"`
	Url       string `json:"url"`
	IssueType *struct {
		Name string `json:"name"`
	} `json:"issueType"`
	Milestone *struct {
		Title string `json:"title"`
	} `json:"milestone"`
}

type ghHistoryPr struct {
	Number            int    `json:"number"`
	Title             string `json:"title"`
	Url               string `json:"url"`
	HeadRefName       string `json:"headRefName"`
	BaseRefName       string `json:"baseRefName"`
	IsCrossRepository bool   `json:"isCrossRepository"`
	MergedAt          string `json:"mergedAt"`
	UpdatedAt         string `json:"updatedAt"`
	Body              string `json:"body"`
	Author            *struct {
		Login string `json:"login"`
	} `json:"author"`
	MergedBy *struct {
		Login string `json:"login"`
	} `json:"mergedBy"`
	MergeCommit *struct {
		Oid     string `json:"oid"`
		Parents *struct {
			TotalCount int `json:"totalCount"`
		} `json:"parents"`
	} `json:"mergeCommit"`
	LatestReviews *struct {
		Nodes []struct {
			Author *struct {
				Login string `json:"login"`
			} `json:"author"`
		} `json:"nodes"`
	} `json:"latestReviews"`
	ClosingIssuesReferences *struct {
		Nodes []ghHistoryIssue `json:"nodes"`
	} `json:"closingIssuesReferences"`
}

type ghHistoryPage struct {
	Data struct {
		Repository *struct {
			PullRequests struct {
				TotalCount int `json:"totalCount"`
				PageInfo   struct {
					HasNextPage bool   `json:"hasNextPage"`
					EndCursor   string `json:"endCursor"`
				} `json:"pageInfo"`
				Nodes []ghHistoryPr `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"repository"`
	} `json:"data"`
}

func historyIssueFields(withType bool) string {
	if withType {
		return "number title url issueType{name} milestone{title}"
	}
	return "number title url milestone{title}"
}

// mergedHistoryQuery reads one page of the merged PRs into a base, the most recently updated first (GitHub cannot
// order them by merge date; the answer is sorted by it).
func mergedHistoryQuery(withType bool) string {
	return "query($owner:String!,$name:String!,$base:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){" +
		"pullRequests(states:MERGED,baseRefName:$base,first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){" +
		"totalCount pageInfo{hasNextPage endCursor} nodes{number title url headRefName baseRefName isCrossRepository mergedAt updatedAt body " +
		"author{login} mergedBy{login} mergeCommit{oid parents(first:2){totalCount}} latestReviews(first:10){nodes{author{login}}} " +
		"closingIssuesReferences(first:1){nodes{" + historyIssueFields(withType) + "}}}}}}"
}

// historyTicketsQuery reads tickets by number; numbers are integers formatted here, never text from GitHub.
func historyTicketsQuery(numbers []int, withType bool) string {
	var sb strings.Builder
	sb.WriteString("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){")
	for _, n := range numbers {
		fmt.Fprintf(&sb, "t%d:issueOrPullRequest(number:%d){...on Issue{%s}}", n, n, historyIssueFields(withType))
	}
	sb.WriteString("}}")
	return sb.String()
}

func ghGraphqlArgs(repoRef string, query string, vars ...string) ([]string, error) {
	parts := strings.Split(repoRef, "/")
	if len(parts) < 2 {
		return nil, fmt.Errorf("no repository to read the merged pull requests from")
	}
	args := []string{"api", "graphql", "-f", "query=" + query, "-f", "owner=" + parts[len(parts)-2], "-f", "name=" + parts[len(parts)-1]}
	args = append(args, vars...)
	if len(parts) == 3 {
		args = append(args, "--hostname", parts[0])
	}
	return args, nil
}

// noIssueType: a GitHub without issue types (an older GitHub Enterprise Server) refuses the field.
func noIssueType(out []byte, err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(string(out)+err.Error(), "issueType")
}

// readHistoryPage reads one page; noType says the issue types had to be left out.
func readHistoryPage(ctx context.Context, run Runner, dir string, repoRef string, target string, after string, noType bool) (ghHistoryPage, bool, error) {
	var page ghHistoryPage
	for {
		vars := []string{"-f", "base=" + target, "-F", fmt.Sprintf("first=%d", mergedHistoryPage)}
		if after != "" {
			vars = append(vars, "-f", "after="+after)
		}
		args, err := ghGraphqlArgs(repoRef, mergedHistoryQuery(!noType), vars...)
		if err != nil {
			return page, noType, err
		}
		out, err := run(ctx, dir, "gh", args...)
		if !noType && noIssueType(out, err) {
			noType = true
			continue
		}
		if err != nil {
			return page, noType, fmt.Errorf("%s", shortGhError(err))
		}
		if jsonErr := json.Unmarshal(out, &page); jsonErr != nil || page.Data.Repository == nil {
			return page, noType, fmt.Errorf("gh api graphql: unreadable answer")
		}
		return page, noType, nil
	}
}

func ticketOfIssue(issue ghHistoryIssue) historyTicket {
	rtn := historyTicket{Title: issue.Title, Url: issue.Url}
	if issue.IssueType != nil {
		rtn.Type = issue.IssueType.Name
	}
	if issue.Milestone != nil {
		rtn.Milestone = issue.Milestone.Title
	}
	return rtn
}

// makeHistoryPr turns a page's PR into a history row, its ticket from the closing reference, else from its branch.
func makeHistoryPr(pr ghHistoryPr, res []*regexp.Regexp) MergedHistoryPr {
	row := MergedHistoryPr{ReviewMergedPr: ReviewMergedPr{
		Number:   pr.Number,
		Title:    pr.Title,
		Url:      pr.Url,
		Branch:   pr.HeadRefName,
		Base:     pr.BaseRefName,
		MergedAt: pr.MergedAt,
	}, UpdatedAt: pr.UpdatedAt}
	if pr.Author != nil {
		row.Author = pr.Author.Login
	}
	if pr.MergedBy != nil {
		row.MergedBy = pr.MergedBy.Login
	}
	if block, ok := agentsign.ParseBlock(pr.Body); ok {
		row.Agents, row.Reviewed = block.Agents, block.Reviewed
	}
	if pr.MergeCommit != nil && commitOidRe.MatchString(pr.MergeCommit.Oid) {
		row.MergeOid = pr.MergeCommit.Oid
		if pr.MergeCommit.Parents != nil {
			row.MergeMethod = MergeMethodLinear
			if pr.MergeCommit.Parents.TotalCount > 1 {
				row.MergeMethod = MergeMethodMerge
			}
		}
	}
	if pr.LatestReviews != nil {
		for _, review := range pr.LatestReviews.Nodes {
			if review.Author == nil || review.Author.Login == "" || containsWord(row.Reviewers, review.Author.Login) {
				continue
			}
			row.Reviewers = append(row.Reviewers, review.Author.Login)
		}
	}
	if pr.ClosingIssuesReferences != nil {
		for _, issue := range pr.ClosingIssuesReferences.Nodes {
			if issue.Number <= 0 {
				continue
			}
			ticket := ticketOfIssue(issue)
			row.Ticket, row.TicketFrom = issue.Number, ReviewTicketFromClosing
			row.TicketTitle, row.TicketUrl, row.TicketType, row.Milestone = ticket.Title, ticket.Url, ticket.Type, ticket.Milestone
			break
		}
	}
	if row.Ticket == 0 {
		if n := ticketOfBranch(pr.HeadRefName, res); n > 0 {
			row.Ticket, row.TicketFrom = n, ReviewTicketFromBranch
		}
	}
	return row
}

// MergedHistory answers with the project's history as read so far; a read that is due starts in the background, and
// the view asks again while the answer says it is loading.
func (r *Reviews) MergedHistory(req MergedHistoryRequest) (MergedHistoryAnswer, error) {
	if err := checkDir(req.Dir); err != nil {
		return MergedHistoryAnswer{}, err
	}
	dir := filepath.Clean(req.Dir)
	snap, ok := r.collector.Cached(dir)
	if !ok || snap.Github == nil {
		var err error
		snap, err = r.collector.Get(dir, DefaultMaxAgeSec*time.Second, false)
		if err != nil {
			return MergedHistoryAnswer{}, err
		}
	}
	answer := MergedHistoryAnswer{Dir: dir, Prs: []MergedHistoryPr{}, Tags: []string{}}
	answer.Target, _ = reviewTarget(snap)
	if snap.Github == nil && snap.Refreshing {
		// The project's first GitHub read is under way: the view asks again while loading.
		answer.Loading = true
		return answer, nil
	}
	if snap.Github == nil ||snap.Github.State != GithubStateOk || snap.Github.Repo == "" {
		answer.Error = "GitHub could not be read for this project"
		if snap.Github != nil && snap.Github.Message != "" {
			answer.Error = snap.Github.Message
		}
		return answer, nil
	}
	answer.Repo, answer.Url = snap.Github.Repo, snap.Github.Url
	if r.prepareHistory(dir, snap, answer.Target, req.Force) {
		go r.readHistory(dir)
	}
	return r.historyAnswer(dir, answer), nil
}

// prepareHistory says whether a read starts now.
func (r *Reviews) prepareHistory(dir string, snap Snapshot, target string, force bool) bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	repoRef := ghRepoRef(snap.Github.Repo, snap.Github.Url)
	state := r.history[dir]
	if state != nil && (state.repoRef != repoRef || state.target != target) {
		state = nil
	}
	if state == nil {
		if len(r.history) >= maxProjects {
			r.evictHistoryLocked()
		}
		state = &mergedHistoryState{prs: map[int]MergedHistoryPr{}, ships: map[string]reviewShip{}, tickets: map[int]historyTicket{}, repoRef: repoRef, target: target}
		r.history[dir] = state
	}
	now := r.now()
	state.usedAt = now
	state.repo, state.url = snap.Github.Repo, snap.Github.Url
	state.prefix, state.release = "", ""
	if snap.Git != nil {
		state.prefix, state.release = snap.Git.TagPrefix, snap.Git.Release
	}
	if state.release == target {
		state.release = ""
	}
	if state.loading {
		return false
	}
	due := !state.complete || force || now.Sub(state.at) >= mergedHistoryMaxAge
	if !due || (!force && state.err != "" && now.Sub(state.at) < minForcedInterval) {
		return false
	}
	state.loading = true
	state.err = ""
	return true
}

func (r *Reviews) evictHistoryLocked() {
	var oldest string
	var oldestAt time.Time
	for dir, state := range r.history {
		if state.loading {
			continue
		}
		if oldest == "" || state.usedAt.Before(oldestAt) {
			oldest, oldestAt = dir, state.usedAt
		}
	}
	if oldest != "" {
		delete(r.history, oldest)
	}
}

func (r *Reviews) historyAnswer(dir string, answer MergedHistoryAnswer) MergedHistoryAnswer {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.history[dir]
	if state == nil {
		return answer
	}
	answer.Total, answer.Loading, answer.Complete, answer.Cut, answer.Error = state.total, state.loading, state.complete, state.cut, state.err
	if !state.at.IsZero() {
		answer.At = state.at.UnixMilli()
	}
	answer.Tags = append([]string{}, state.tags...)
	answer.TagPrefix = state.prefix
	answer.Prs = make([]MergedHistoryPr, 0, len(state.prs))
	for _, pr := range state.prs {
		if ship, ok := state.ships[pr.MergeOid]; ok && pr.MergeOid != "" {
			pr.Ships, pr.ShipsIn = ship.ships, ship.in
		}
		if pr.TicketTitle == "" && pr.Ticket > 0 {
			if ticket, ok := state.tickets[pr.Ticket]; ok {
				pr.TicketTitle, pr.TicketUrl, pr.TicketType, pr.Milestone = ticket.Title, ticket.Url, ticket.Type, ticket.Milestone
			}
		}
		answer.Prs = append(answer.Prs, pr)
	}
	sort.SliceStable(answer.Prs, func(i, j int) bool {
		if answer.Prs[i].MergedAt != answer.Prs[j].MergedAt {
			return answer.Prs[i].MergedAt > answer.Prs[j].MergedAt
		}
		return answer.Prs[i].Number > answer.Prs[j].Number
	})
	return answer
}

type historyQuery struct {
	repoRef  string
	target   string
	cursor   string
	complete bool
	noType   bool
	prefix   string
	release  string
	known    map[int]string
}

func (r *Reviews) takeHistoryQuery(dir string) (historyQuery, bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.history[dir]
	if state == nil {
		return historyQuery{}, false
	}
	known := make(map[int]string, len(state.prs))
	for n, pr := range state.prs {
		known[n] = pr.UpdatedAt
	}
	return historyQuery{repoRef: state.repoRef, target: state.target, cursor: state.cursor, complete: state.complete, noType: state.noType,
		prefix: state.prefix, release: state.release, known: known}, true
}

// storeHistoryPage keeps a page's PRs. fullRead: a first read, whose cursor lets a failed read go on from there;
// complete: no older page is left to read (a cut history counts as read).
func (r *Reviews) storeHistoryPage(dir string, rows []MergedHistoryPr, total int, cursor string, fullRead bool, complete bool, cut bool, noType bool) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.history[dir]
	if state == nil {
		return
	}
	for _, row := range rows {
		state.prs[row.Number] = row
	}
	state.total = total
	state.noType = noType
	if fullRead {
		state.cursor = cursor
	}
	if complete {
		state.complete = true
		state.cursor = ""
	}
	state.cut = state.cut || cut
}

func (r *Reviews) historyGaps(dir string) ([]int, []string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.history[dir]
	if state == nil {
		return nil, nil
	}
	var tickets []int
	seen := map[int]bool{}
	oids := []string{}
	for _, pr := range state.prs {
		if pr.MergeOid != "" {
			oids = append(oids, pr.MergeOid)
		}
		if pr.Ticket <= 0 || pr.TicketTitle != "" || seen[pr.Ticket] || pr.Ticket == pr.Number {
			continue
		}
		if _, ok := state.tickets[pr.Ticket]; ok {
			continue
		}
		seen[pr.Ticket] = true
		tickets = append(tickets, pr.Ticket)
	}
	sort.Ints(tickets)
	return tickets, oids
}

func (r *Reviews) storeHistoryTickets(dir string, tickets map[int]historyTicket) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.history[dir]
	if state == nil {
		return
	}
	for n, ticket := range tickets {
		state.tickets[n] = ticket
	}
}

func (r *Reviews) endHistory(dir string, tags []string, ships map[string]reviewShip, errMsg string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	state := r.history[dir]
	if state == nil {
		return
	}
	state.loading = false
	state.at = r.now()
	state.err = errMsg
	if ships != nil {
		state.tags = tags
		state.ships = ships
	}
}

func (r *Reviews) readHistory(dir string) {
	var tags []string
	var ships map[string]reviewShip
	errMsg := ""
	defer func() {
		if rec := recover(); rec != nil {
			panichandler.PanicHandler("molten:mission:reviews:history", rec)
			errMsg = "the merged history could not be read"
		}
		r.endHistory(dir, tags, ships, errMsg)
	}()
	query, ok := r.takeHistoryQuery(dir)
	if !ok {
		return
	}
	if err := r.readHistoryPages(dir, query); err != nil {
		errMsg = err.Error()
		log.Printf("molten: reading the merged history of %s: %v\n", dir, err)
	}
	tickets, oids := r.historyGaps(dir)
	if len(tickets) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), mergedHistoryGhTimeout)
		found := readHistoryTickets(ctx, r.run, dir, query.repoRef, tickets, query.noType)
		cancel()
		r.storeHistoryTickets(dir, found)
	}
	ctx, cancel := context.WithTimeout(context.Background(), mergedHistoryGitTimeout)
	defer cancel()
	tags, ships = ReadHistoryShips(ctx, r.run, dir, oids, query.prefix, query.release, query.target)
}

// readHistoryPages reads on from where a cut read stopped, or, on a complete history, the newest pages until one
// brings no PR that is new or updated.
func (r *Reviews) readHistoryPages(dir string, query historyQuery) error {
	res := branchTicketRes(readBranchNaming(dir))
	cursor := ""
	if !query.complete {
		cursor = query.cursor
	}
	read := len(query.known)
	noType := query.noType
	for {
		ctx, cancel := context.WithTimeout(context.Background(), mergedHistoryGhTimeout)
		page, pageNoType, err := readHistoryPage(ctx, r.run, dir, query.repoRef, query.target, cursor, noType)
		cancel()
		noType = pageNoType
		if err != nil {
			return err
		}
		prs := page.Data.Repository.PullRequests
		rows := []MergedHistoryPr{}
		// The pages come by last update: past a PR known as it is, every PR is known as it is.
		metKnown := false
		for _, pr := range prs.Nodes {
			if updatedAt, ok := query.known[pr.Number]; ok && updatedAt == pr.UpdatedAt {
				metKnown = true
			}
			if pr.IsCrossRepository || pr.BaseRefName != query.target {
				continue
			}
			rows = append(rows, makeHistoryPr(pr, res))
		}
		read += len(prs.Nodes)
		more := prs.PageInfo.HasNextPage && prs.PageInfo.EndCursor != ""
		cut := more && read >= mergedHistoryMaxPrs
		done := !more || cut || (query.complete && metKnown)
		r.storeHistoryPage(dir, rows, prs.TotalCount, prs.PageInfo.EndCursor, !query.complete, query.complete || !more || cut, cut, noType)
		if done {
			return nil
		}
		cursor = prs.PageInfo.EndCursor
	}
}

func readHistoryTickets(ctx context.Context, run Runner, dir string, repoRef string, numbers []int, noType bool) map[int]historyTicket {
	rtn := map[int]historyTicket{}
	for start := 0; start < len(numbers); start += mergedHistoryTicketBatch {
		batch := numbers[start:min(len(numbers), start+mergedHistoryTicketBatch)]
		args, err := ghGraphqlArgs(repoRef, historyTicketsQuery(batch, !noType))
		if err != nil {
			return rtn
		}
		out, err := run(ctx, dir, "gh", args...)
		if !noType && noIssueType(out, err) {
			args, _ = ghGraphqlArgs(repoRef, historyTicketsQuery(batch, false))
			out, err = run(ctx, dir, "gh", args...)
		}
		var answer struct {
			Data struct {
				Repository map[string]*ghHistoryIssue `json:"repository"`
			} `json:"data"`
		}
		// gh prints the data it got along with GraphQL errors (a number that is a PR, not an issue): keep what came.
		if jsonErr := json.Unmarshal(out, &answer); jsonErr != nil || answer.Data.Repository == nil {
			if err != nil {
				log.Printf("molten: reading the tickets of the merged history of %s: %v\n", dir, err)
			}
			continue
		}
		for _, n := range batch {
			if issue := answer.Data.Repository[fmt.Sprintf("t%d", n)]; issue != nil && issue.Title != "" {
				rtn[n] = ticketOfIssue(*issue)
			}
		}
	}
	return rtn
}

func gitLines(out []byte) []string {
	var rtn []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			rtn = append(rtn, line)
		}
	}
	return rtn
}

func firstRef(ctx context.Context, run Runner, dir string, branch string) string {
	if branch == "" || strings.HasPrefix(branch, "-") {
		return ""
	}
	for _, ref := range []string{"refs/remotes/origin/" + branch, "refs/heads/" + branch} {
		if _, err := run(ctx, dir, "git", "rev-parse", "--verify", "-q", ref); err == nil {
			return ref
		}
	}
	return ""
}

// ReadHistoryShips says where each merge commit ships, as ReadShips does for one: the first release tag in version
// order that carries it, else the release branch, else the next release when the target carries it. A commit the
// clone lacks has no answer. It returns the release tags, oldest version first.
func ReadHistoryShips(ctx context.Context, run Runner, dir string, oids []string, tagPrefix string, release string, target string) ([]string, map[string]reviewShip) {
	ships := map[string]reviewShip{}
	wanted := map[string]bool{}
	for _, oid := range oids {
		if commitOidRe.MatchString(oid) {
			wanted[strings.ToLower(oid)] = true
		}
	}
	args := []string{"tag", "--sort=v:refname"}
	if tagPrefix != "" {
		args = append(args, "--list", tagPrefix+"*")
	}
	out, err := run(ctx, dir, "git", args...)
	if err != nil {
		log.Printf("molten: listing the release tags of %s: %v\n", dir, err)
		return []string{}, ships
	}
	tags := gitLines(out)
	if tags == nil {
		tags = []string{}
	}
	now := time.Now()
	assign := func(rev string, exclude []string, where string, in string) bool {
		revArgs := append([]string{"rev-list", rev}, "--not")
		revArgs = append(revArgs, exclude...)
		out, err := run(ctx, dir, "git", revArgs...)
		if err != nil {
			return false
		}
		for _, oid := range gitLines(out) {
			oid = strings.ToLower(oid)
			if !wanted[oid] {
				continue
			}
			ships[oid] = reviewShip{ships: where, in: in, at: now}
			delete(wanted, oid)
		}
		return true
	}
	for i, tag := range tags {
		if len(wanted) == 0 {
			break
		}
		assign("refs/tags/"+tag, tagRefs(tags[:i]), ReviewShipsTag, tag)
	}
	if len(wanted) > 0 {
		if ref := firstRef(ctx, run, dir, release); ref != "" {
			assign(ref, tagRefs(tags), ReviewShipsBranch, release)
		}
	}
	if len(wanted) > 0 {
		if ref := firstRef(ctx, run, dir, target); ref != "" {
			assign(ref, tagRefs(tags), ReviewShipsNext, "")
		}
	}
	// The answer is keyed as GitHub writes the oids.
	rtn := make(map[string]reviewShip, len(ships))
	for _, oid := range oids {
		if ship, ok := ships[strings.ToLower(oid)]; ok {
			rtn[oid] = ship
		}
	}
	return tags, rtn
}

func tagRefs(tags []string) []string {
	rtn := make([]string, 0, len(tags))
	for _, tag := range tags {
		rtn = append(rtn, "refs/tags/"+tag)
	}
	return rtn
}

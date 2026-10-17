// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Investigate and fix (#896): green means solved. The agent's hooks say when its turn ends, not when the PR's CI
// passes, so MoltenTerm owns the agent's state for the run (attention's holds): fixing while the agent works; once it
// stops, waiting for the CI while the PR's required checks run on the pushed head; green only when they all pass there;
// needs you, with the reason and a notification, when they fail again, when the agent left work unpushed, or when it
// stopped on a question (its outcome line starts with "needs you:"). Its own question (a permission, a waiting hook)
// shows through. The PR's checks are read only once the agent stopped, at most every followRecheck.

const (
	// ciWatchMax: a CI still running this long after the agent stopped is handed to the developer.
	ciWatchMax = 2 * time.Hour
	// outcomeMaxLength: the outcome line a notification quotes.
	outcomeMaxLength = 200
	needsYouPrefix   = "needs you:"
	outcomeExt       = ".outcome"

	ciPending = "pending"
	ciFailed  = "failed"
	ciPassed  = "passed"
	ciGone    = "gone"
)

type ghCheckBucket struct {
	Name   string `json:"name"`
	Bucket string `json:"bucket"`
}

type prCiVerdict struct {
	state string
	// failed: the names of the required checks that failed.
	failed []string
}

func investigateOutcomePath(briefPath string) string {
	if briefPath == "" {
		return ""
	}
	return strings.TrimSuffix(briefPath, ".md") + outcomeExt
}

// readOutcome is the agent's outcome line (the brief's last step), its first line, cleaned; "" without one.
func readOutcome(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			text := molten.CleanAgentMessage(line)
			if runes := []rune(text); len(runes) > outcomeMaxLength {
				text = string(runes[:outcomeMaxLength-1]) + "…"
			}
			return text
		}
	}
	return ""
}

// outcomeNeedsYou: the agent stopped for a decision; the rest of the line says why.
func outcomeNeedsYou(outcome string) (string, bool) {
	if len(outcome) < len(needsYouPrefix) || !strings.EqualFold(outcome[:len(needsYouPrefix)], needsYouPrefix) {
		return "", false
	}
	return strings.TrimSpace(outcome[len(needsYouPrefix):]), true
}

// foldChecks reads gh pr checks' buckets: failed when one failed or was cancelled, pending while one runs or none
// is reported yet (a push GitHub has not picked up), passed when every one passed or was skipped.
func foldChecks(checks []ghCheckBucket) prCiVerdict {
	var failed []string
	pending := len(checks) == 0
	for _, c := range checks {
		switch c.Bucket {
		case "fail", "cancel":
			failed = append(failed, c.Name)
		case "pending":
			pending = true
		}
	}
	if len(failed) > 0 {
		sort.Strings(failed)
		return prCiVerdict{state: ciFailed, failed: failed}
	}
	if pending {
		return prCiVerdict{state: ciPending}
	}
	return prCiVerdict{state: ciPassed}
}

// readChecks: the PR's required checks, all its checks when the repository requires none. gh exits 8 while checks
// are pending and 1 when none is reported; its JSON still comes on stdout.
func (r *Restarter) readChecks(ctx context.Context, f agentFollow) ([]ghCheckBucket, error) {
	number := strconv.Itoa(f.req.Number)
	var lastErr error
	for _, args := range [][]string{
		{"pr", "checks", number, "--required", "--json", "name,bucket", "--repo", f.req.Repo},
		{"pr", "checks", number, "--json", "name,bucket", "--repo", f.req.Repo},
	} {
		out, err := r.env.Gh(ctx, f.req.Dir, args...)
		var checks []ghCheckBucket
		if jerr := json.Unmarshal(out, &checks); jerr == nil && len(checks) > 0 {
			return checks, nil
		}
		lastErr = err
	}
	if lastErr != nil && !strings.Contains(lastErr.Error(), "no checks reported") && !strings.Contains(lastErr.Error(), "no required checks") {
		return nil, lastErr
	}
	return nil, nil
}

// readCi: the PR's checks on its current head, which must be the head the agent pushed (localHead).
func (r *Restarter) readCi(ctx context.Context, f agentFollow, localHead string) (prCiVerdict, error) {
	if r.env.Gh == nil {
		return prCiVerdict{state: ciPending}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, ghCallTimeout)
	defer cancel()
	out, err := r.env.Gh(ctx, f.req.Dir, "pr", "view", strconv.Itoa(f.req.Number), "--json", "state,headRefOid", "--repo", f.req.Repo)
	if err != nil {
		return prCiVerdict{}, err
	}
	var pr struct {
		State      string `json:"state"`
		HeadRefOid string `json:"headRefOid"`
	}
	if err := json.Unmarshal(out, &pr); err != nil {
		return prCiVerdict{}, err
	}
	if !strings.EqualFold(pr.State, "OPEN") {
		return prCiVerdict{state: ciGone}, nil
	}
	if localHead != "" && pr.HeadRefOid != localHead {
		return prCiVerdict{state: ciPending}, nil
	}
	checks, err := r.readChecks(ctx, f)
	if err != nil {
		return prCiVerdict{}, err
	}
	return foldChecks(checks), nil
}

func (r *Restarter) holdState(f agentFollow, st *followState, state string, message string, text *uimsg.Text) {
	if r.env.HoldState == nil || st.hold == state+"/"+message {
		return
	}
	st.hold = state + "/" + message
	r.env.HoldState(f.blockId, state, message, text)
}

func (r *Restarter) releaseState(f agentFollow, state string, message string, text *uimsg.Text) {
	if r.env.ReleaseState == nil {
		return
	}
	r.env.ReleaseState(f.blockId, state, message, text)
}

// holdFixing: the agent works on the CI (from its start, and whenever it works again).
func (r *Restarter) holdFixing(f agentFollow, st *followState) {
	number := strconv.Itoa(f.req.Number)
	st.stoppedAt, st.failSeen = time.Time{}, ""
	r.holdState(f, st, molten.AgentStateWorking, "Fixing the CI of #"+number, uimsg.Make("agentHold.fixing", "number", number))
}

func (r *Restarter) holdCi(f agentFollow, st *followState) {
	number := strconv.Itoa(f.req.Number)
	r.holdState(f, st, molten.AgentStateWorking, "Waiting for the CI of #"+number, uimsg.Make("agentHold.ci", "number", number))
}

// followInvestigation judges a stopped investigation; false when the follow ends (the PR is green, merged or closed).
func (r *Restarter) followInvestigation(ctx context.Context, f agentFollow, st *followState, run molten.AgentRunInfo, running bool) bool {
	waiting := running && (run.State == molten.AgentStateWaiting || run.State == molten.AgentStateError)
	if waiting {
		// The agent's question shows through the hold, with its own notification.
		return true
	}
	stopped := (st.sawRun && !running) || st.sawWorking || run.State == molten.AgentStateDone
	if !stopped {
		r.holdFixing(f, st)
		return true
	}
	if st.stoppedAt.IsZero() {
		st.stoppedAt = r.env.Now()
	}
	name := agentName(run, f.agent)
	number := strconv.Itoa(f.req.Number)
	outcome := readOutcome(f.outcomePath)
	if reason, ok := outcomeNeedsYou(outcome); ok {
		r.needsYou(ctx, f, st, name, reason, uimsg.Make("notif.review.asks", "name", name, "reason", reason))
		return true
	}
	facts, err := r.readTree(ctx, f)
	if err != nil {
		log.Printf("%s %s#%d: the agent's worktree could not be read: %v\n", logPrefix, f.req.Repo, f.req.Number, err)
		r.holdCi(f, st)
		return true
	}
	if message, text, ok := treeNeeds(name, f.req.HeadRef, facts); ok {
		r.needsYou(ctx, f, st, name, message, text)
		return true
	}
	verdict, err := r.readCi(ctx, f, facts.head)
	if err != nil {
		log.Printf("%s %s#%d: the PR's checks could not be read: %v\n", logPrefix, f.req.Repo, f.req.Number, err)
		r.holdCi(f, st)
		return true
	}
	switch verdict.state {
	case ciGone:
		r.releaseState(f, "", "", nil)
		r.resolveNotice(ctx, f)
		return false
	case ciPassed:
		r.ciGreen(ctx, f, name, outcome)
		return false
	case ciFailed:
		// A failure is told once seen twice: right after a rerun or a push GitHub may still show the last one.
		names := strings.Join(verdict.failed, ", ")
		if st.failSeen != facts.head+"/"+names {
			st.failSeen = facts.head + "/" + names
			r.holdCi(f, st)
			return true
		}
		message := "Still failing on #" + number + ": " + names
		r.needsYou(ctx, f, st, name, message, uimsg.Make("notif.review.stillFailing", "number", number, "names", names))
		return true
	}
	st.failSeen = ""
	if r.env.Now().Sub(st.stoppedAt) > ciWatchMax {
		r.needsYou(ctx, f, st, name, "The CI of #"+number+" is still running after 2 hours.", uimsg.Make("notif.review.ciSlow", "number", number))
		return true
	}
	r.holdCi(f, st)
	return true
}

// treeNeeds: work the agent left in its copy of the branch.
func treeNeeds(name string, branch string, facts treeFacts) (string, *uimsg.Text, bool) {
	switch {
	case facts.rebasing:
		return name + " stopped in the middle of the rebase of " + branch + ": its terminal says what it needs.",
			uimsg.Make("notif.review.midRebase", "name", name, "branch", branch), true
	case facts.unpushed > 0:
		count := strconv.Itoa(facts.unpushed)
		return "Commits not pushed on " + branch + ": " + count + ".", uimsg.Make("notif.review.commits", "branch", branch, "count", count), true
	case len(facts.changes) > 0:
		count, names := strconv.Itoa(len(facts.changes)), namesOf(facts.changes)
		return name + " left uncommitted files in its copy of " + branch + " (" + count + "): " + names,
			uimsg.Make("notif.review.uncommitted", "name", name, "branch", branch, "count", count, "names", names), true
	}
	return "", nil, false
}

// needsYou: the run waits for the developer, with the reason in its state and, once per reason, a notification.
func (r *Restarter) needsYou(ctx context.Context, f agentFollow, st *followState, name string, message string, text *uimsg.Text) {
	r.holdState(f, st, molten.AgentStateWaiting, message, text)
	if st.notice == message {
		return
	}
	st.notice = message
	number := strconv.Itoa(f.req.Number)
	r.notify(ctx, molten.NotificationInput{
		Key:         agentNoticeKey(f.req.PrKey),
		Source:      "agent",
		Kind:        "warning",
		Title:       name + " needs you on #" + number,
		TitleText:   uimsg.Make("notif.review.needsTitle", "name", name, "number", number),
		Message:     message,
		MessageText: text,
		WorkspaceId: f.req.WorkspaceId,
		TabId:       f.tabId,
		BlockId:     f.blockId,
	})
}

// ciGreen: the PR's required checks pass on the pushed head; the run turns green and says what the agent did.
func (r *Restarter) ciGreen(ctx context.Context, f agentFollow, name string, outcome string) {
	number := strconv.Itoa(f.req.Number)
	r.releaseState(f, molten.AgentStateDone, "The CI of #"+number+" passes", uimsg.Make("agentHold.green", "number", number))
	r.resolveNotice(ctx, f)
	input := molten.NotificationInput{
		Key:         agentDoneKey(f.req.PrKey),
		Source:      "agent",
		Kind:        "success",
		Title:       "#" + number + ": CI green again",
		TitleText:   uimsg.Make("notif.review.ciGreenTitle", "number", number),
		Message:     name + " stopped and the required checks of #" + number + " pass.",
		MessageText: uimsg.Make("notif.review.ciGreenPlain", "name", name, "number", number),
		WorkspaceId: f.req.WorkspaceId,
		TabId:       f.tabId,
		BlockId:     f.blockId,
		Actions: []molten.NotificationAction{{Id: "review", Label: "Open the review", LabelText: uimsg.Make("notif.review.openReview"),
			Kind: "gesture", Gesture: ReviewOpenGesture, Args: map[string]any{"pr": f.prInfo()}}},
	}
	if outcome != "" {
		input.Message = name + ": " + outcome
		input.MessageText = uimsg.Make("notif.review.ciGreen", "name", name, "outcome", outcome)
	}
	r.notify(ctx, input)
}

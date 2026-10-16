// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The clean end of an agent MoltenTerm started (#758). wavesrv follows it while its terminal lives: while it works,
// only its state (in memory) is read; once it stops, its worktree is. Pushed and clean (the branch moved and origin has
// it, nothing uncommitted, no rebase stopped halfway, nothing unpushed) and no longer working: the terminal closes, its
// tab with it when nothing else is there, the worktree MoltenTerm made goes, and a notification says the PR is ready
// for review. An agent out of sight that stops short of that tells the developer why, in plain words, with Go to the
// terminal; nothing opens by itself. Ignored files (build outputs, dependencies) are not work: they go with the
// worktree. The follow lives in memory: a restart of MoltenTerm leaves the agent as any other.

const (
	followTimeout = 30 * time.Second
	// While the agent is stopped and nothing changes, the worktree is read again at most this often.
	followRecheck = 30 * time.Second
	// followMaxNames: the uncommitted files a notification names.
	followMaxNames = 3

	// ReviewOpenGesture opens a PR's Review tab from a notification; must match frontend/moltenterm-shell/reviews/agent-choice.tsx.
	ReviewOpenGesture = "review:open"

	agentNoticePrefix = "review:agent:"
)

type agentFollow struct {
	req     RestartRequest
	origin  AgentOrigin
	tree    string
	created bool
	blockId string
	tabId   string
	// startHead: the worktree's HEAD when the agent started; a push moves it.
	startHead string
	agent     string
}

type followState struct {
	sawRun     bool
	sawWorking bool
	lastKey    string
	checkedAt  time.Time
	notice     string
}

type treeFacts struct {
	head     string
	remote   string
	changes  []string
	rebasing bool
	unpushed int
}

func (f treeFacts) pushed(startHead string) bool {
	return f.head != "" && f.head == f.remote && f.head != startHead
}

func (f treeFacts) clean() bool {
	return len(f.changes) == 0 && !f.rebasing && f.unpushed == 0
}

// agentNoticeKey: what the agent needs from the developer, resolved once it is done or gone; agentDoneKey: its end.
func agentNoticeKey(k PrKey) string {
	return agentNoticePrefix + "needs:" + strings.ToLower(k.Repo) + "#" + strconv.Itoa(k.Number) + ":"
}

func agentDoneKey(k PrKey) string {
	return agentNoticePrefix + "done:" + strings.ToLower(k.Repo) + "#" + strconv.Itoa(k.Number) + ":"
}

// startFollow follows the agent until its terminal goes; without FollowEvery (the tests) nothing runs on its own.
func (r *Restarter) startFollow(f agentFollow) {
	if r.env.FollowEvery <= 0 {
		return
	}
	go func() {
		st := &followState{}
		ticker := time.NewTicker(r.env.FollowEvery)
		defer ticker.Stop()
		for range ticker.C {
			ctx, cancel := context.WithTimeout(context.Background(), followTimeout)
			more := r.followStep(ctx, f, st)
			cancel()
			if !more {
				return
			}
		}
	}()
}

// followStep reads the agent once; false when the follow ends (cleaned up, or its terminal is gone).
func (r *Restarter) followStep(ctx context.Context, f agentFollow, st *followState) bool {
	if r.env.BlockExists != nil && !r.env.BlockExists(ctx, f.blockId) {
		r.resolveNotice(ctx, f)
		return false
	}
	run, ok := r.agentRunOf(f.blockId)
	if ok {
		st.sawRun = true
	}
	running := ok && run.Running
	if running && run.State == molten.AgentStateWorking {
		st.sawWorking = true
		return true
	}
	key := run.State + "/" + strconv.FormatBool(running) + "/" + strconv.FormatInt(run.StateSince, 10)
	if key == st.lastKey && r.env.Now().Sub(st.checkedAt) < followRecheck {
		return true
	}
	st.lastKey, st.checkedAt = key, r.env.Now()
	facts, err := r.readTree(ctx, f)
	if err != nil {
		log.Printf("%s %s#%d: the agent's worktree could not be read: %v\n", logPrefix, f.req.Repo, f.req.Number, err)
		return true
	}
	waiting := running && (run.State == molten.AgentStateWaiting || run.State == molten.AgentStateError)
	if facts.pushed(f.startHead) && facts.clean() && !waiting {
		r.finish(ctx, f, run)
		return false
	}
	if f.origin.Mode != AgentModeBackground || waiting {
		// Waiting for an answer is the agent's own notification (attention), with Go to the terminal.
		return true
	}
	stopped := (st.sawRun && !running) || st.sawWorking
	if !stopped {
		return true
	}
	r.noticeNeeds(ctx, f, st, run, running, facts)
	return true
}

func (r *Restarter) agentRunOf(blockId string) (molten.AgentRunInfo, bool) {
	if r.env.AgentRun == nil {
		return molten.AgentRunInfo{}, false
	}
	return r.env.AgentRun(blockId)
}

func (r *Restarter) readTree(ctx context.Context, f agentFollow) (treeFacts, error) {
	var facts treeFacts
	head, err := r.git(ctx, f.tree, "rev-parse", "HEAD")
	if err != nil {
		return facts, err
	}
	facts.head = head
	facts.remote, _ = r.git(ctx, f.tree, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+f.req.HeadRef)
	status, err := r.git(ctx, f.tree, "status", "--porcelain", "--untracked-files=normal")
	if err != nil {
		return facts, err
	}
	for _, line := range strings.Split(status, "\n") {
		if len(line) > 3 {
			facts.changes = append(facts.changes, strings.TrimSpace(line[3:]))
		}
	}
	for _, name := range []string{"rebase-merge", "rebase-apply"} {
		path, err := r.git(ctx, f.tree, "rev-parse", "--git-path", name)
		if err != nil || path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(f.tree, path)
		}
		if pathExists(path) {
			facts.rebasing = true
		}
	}
	count, err := r.git(ctx, f.tree, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err == nil {
		facts.unpushed, _ = strconv.Atoi(count)
	}
	return facts, nil
}

// agentName: how the developer calls the agent (its first name once it has one).
func agentName(run molten.AgentRunInfo, fallback string) string {
	if name := molten.AgentCallName(run.FirstName, run.Agent); name != "" {
		return name
	}
	if fallback != "" {
		return molten.AgentDisplayName(fallback)
	}
	return "The agent"
}

func (r *Restarter) noticeNeeds(ctx context.Context, f agentFollow, st *followState, run molten.AgentRunInfo, running bool, facts treeFacts) {
	name := agentName(run, f.agent)
	number := strconv.Itoa(f.req.Number)
	branch := f.req.HeadRef
	var message string
	var text *uimsg.Text
	switch {
	case facts.pushed(f.startHead) && len(facts.changes) > 0:
		count, names := strconv.Itoa(len(facts.changes)), namesOf(facts.changes)
		message = name + " pushed, but its copy of " + branch + " has uncommitted files (" + count + "): " + names
		text = uimsg.Make("notif.review.changes", "name", name, "branch", branch, "count", count, "names", names)
	case facts.unpushed > 0 && !facts.rebasing:
		count := strconv.Itoa(facts.unpushed)
		message = "Commits not pushed on " + branch + ": " + count + "."
		text = uimsg.Make("notif.review.commits", "branch", branch, "count", count)
	case facts.rebasing:
		message = name + " stopped in the middle of the rebase of " + branch + ": its terminal says what it needs."
		text = uimsg.Make("notif.review.midRebase", "name", name, "branch", branch)
	case !running:
		message = name + "'s session ended before " + branch + " was pushed."
		text = uimsg.Make("notif.review.exited", "name", name, "branch", branch)
	default:
		message = name + " stopped before pushing " + branch + ": its terminal says what it needs."
		text = uimsg.Make("notif.review.stopped", "name", name, "branch", branch)
	}
	if st.notice == message {
		return
	}
	st.notice = message
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

func namesOf(paths []string) string {
	names := paths
	if len(names) > followMaxNames {
		names = names[:followMaxNames]
	}
	text := strings.Join(names, ", ")
	if len(paths) > followMaxNames {
		text += ", …"
	}
	return text
}

// finish closes the terminal (and its tab when nothing else is there), removes the worktree MoltenTerm made, and says
// the PR is ready for review.
// finish closes the terminal (and its tab when nothing else is there), removes the worktree MoltenTerm made, and says
// the PR is ready for review.
func (r *Restarter) finish(ctx context.Context, f agentFollow, run molten.AgentRunInfo) {
	if r.env.CloseTerminal != nil {
		if err := r.env.CloseTerminal(ctx, f.blockId); err != nil {
			log.Printf("%s %s#%d: the agent's terminal could not be closed: %v\n", logPrefix, f.req.Repo, f.req.Number, err)
			return
		}
	}
	removed := false
	if f.created {
		if _, err := r.git(ctx, f.req.Dir, "worktree", "remove", f.tree); err != nil {
			log.Printf("%s %s#%d: the worktree %s is kept: %v\n", logPrefix, f.req.Repo, f.req.Number, f.tree, err)
		} else {
			removed = true
			os.RemoveAll(f.tree)
		}
	}
	r.resolveNotice(ctx, f)
	name := agentName(run, f.agent)
	number, branch, base := strconv.Itoa(f.req.Number), f.req.HeadRef, f.req.BaseRef
	input := molten.NotificationInput{
		Key:         agentDoneKey(f.req.PrKey),
		Source:      "agent",
		Kind:        "success",
		Title:       "#" + number + " rebased on " + base + " by " + name + ", ready for review",
		TitleText:   uimsg.Make("notif.review.rebasedTitle", "number", number, "base", base, "name", name),
		WorkspaceId: f.req.WorkspaceId,
		Actions: []molten.NotificationAction{{Id: "review", Label: "Open the review", LabelText: uimsg.Make("notif.review.openReview"),
			Kind: "gesture", Gesture: ReviewOpenGesture, Args: map[string]any{"pr": f.prInfo()}}},
	}
	if f.origin.Kind == AgentOriginRestart {
		round := strconv.Itoa(f.origin.Round)
		input.Title = name + " pushed the changes of review round " + round + " on #" + number + ", ready for review"
		input.TitleText = uimsg.Make("notif.review.reworkedTitle", "name", name, "round", round, "number", number)
	}
	if removed {
		input.Message = "Its terminal is closed and its copy of " + branch + " removed: nothing was left behind."
		input.MessageText = uimsg.Make("notif.review.cleanedUp", "branch", branch)
	}
	r.notify(ctx, input)
}

func (f agentFollow) prInfo() PrInfo {
	return PrInfo{Dir: f.req.Dir, Repo: f.req.Repo, Number: f.req.Number, Title: f.req.Title, Url: f.req.Url,
		HeadRef: f.req.HeadRef, BaseRef: f.req.BaseRef, Ticket: f.req.Ticket}
}

func (r *Restarter) notify(ctx context.Context, input molten.NotificationInput) {
	if r.env.Notify == nil {
		return
	}
	if err := r.env.Notify(ctx, input); err != nil {
		log.Printf("%s %s: the notification could not be published: %v\n", logPrefix, input.Key, err)
	}
}

func (r *Restarter) resolveNotice(ctx context.Context, f agentFollow) {
	if r.env.ResolveNotices == nil {
		return
	}
	if err := r.env.ResolveNotices(ctx, agentNoticeKey(f.req.PrKey)); err != nil {
		log.Printf("%s %s#%d: the agent's notification could not be resolved: %v\n", logPrefix, f.req.Repo, f.req.Number, err)
	}
}

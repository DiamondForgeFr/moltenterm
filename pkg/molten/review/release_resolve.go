// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// A failed release step (#945, FR-MC-016): the release card's Analyze and resolve and Investigate together go the way
// the Reviews' Investigate and fix goes (investigate.go): the developer's click, the coding agent the project chose, a
// brief in MoltenTerm's data folder, a one-line outcome the agent writes last, and a follow that tells the developer.
// The agent works in a new copy of the trunk, detached, never in the main checkout or a release worktree. Its rules are
// the release's: it may rerun failed jobs when the code is not the cause, or fix the code on a ticket branch with a
// pull request into the trunk; it never pushes the trunk or the release branch, never merges, tags or publishes, and
// never runs the release itself: the developer retries the step. Analyze and resolve works out of sight and reports by
// notification; Investigate together opens a tab, shown, with the failing logs beside the agent.

const (
	ReleaseResolveCommand = "moltenreviewreleaseresolve"

	// AgentOriginRelease: the agent works on a failed release step (#945).
	AgentOriginRelease = "release"

	releaseDirName  = "release"
	releaseTreePre  = "release-"
	releaseLogExt   = ".log"
	releaseNoRepo   = "local"
	maxReleaseRuns  = 4
	maxReleaseLog   = 256 << 10
	releaseNoticeAt = "release:agent:"
)

// The phases of a release followed; must match ReleasePhase in frontend/moltenterm-shell/mission/mission-model.ts.
var releasePhases = map[string]bool{"prepare": true, "cut": true, "build": true, "publish": true, "back": true}

var unsafeNameRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

type ReleaseResolveRequest struct {
	Dir  string `json:"dir"`
	Repo string `json:"repo,omitempty"`
	Tag  string `json:"tag"`
	// Phase: the failed phase; Step: the step that failed in it, named as the card names it.
	Phase string `json:"phase"`
	Step  string `json:"step"`
	// Trunk: the branch fixes go to by pull request, and where the agent's copy starts.
	Trunk string `json:"trunk"`
	// Log: the failed step's own log, as MoltenTerm kept it; Runs: the GitHub runs that failed.
	Log  string             `json:"log,omitempty"`
	Runs []InvestigateCheck `json:"runs,omitempty"`
	// Mode: background (Analyze and resolve) or together (Investigate together).
	Mode        string `json:"mode"`
	WorkspaceId string `json:"workspaceid"`
	TabName     string `json:"tabname,omitempty"`
	Agent       string `json:"agent,omitempty"`
}

func (req ReleaseResolveRequest) check() error {
	if err := checkDir(req.Dir); err != nil {
		return err
	}
	if req.Repo != "" && (!repoPattern.MatchString(req.Repo) || strings.HasPrefix(req.Repo, ".") || strings.Contains(req.Repo, "/.")) {
		return fmt.Errorf("repo must be owner/name")
	}
	if !reviewsession.ValidRef(req.Tag) {
		return fmt.Errorf("tag must be the release's tag")
	}
	if !releasePhases[req.Phase] {
		return fmt.Errorf("phase must be one of prepare, cut, build, publish, back")
	}
	if strings.TrimSpace(req.Step) == "" {
		return fmt.Errorf("step must name the step that failed")
	}
	if !reviewsession.ValidRef(req.Trunk) {
		return fmt.Errorf("trunk must be the branch fixes go to")
	}
	for _, c := range req.Runs {
		if strings.TrimSpace(c.Name) == "" || c.RunId < 0 || c.JobId < 0 {
			return fmt.Errorf("each run needs its name, and ids that are not negative")
		}
	}
	return req.restartRequest().checkStart()
}

func (req ReleaseResolveRequest) restartRequest() RestartRequest {
	return RestartRequest{PrKey: PrKey{Repo: req.Repo}, Dir: req.Dir, HeadRef: req.Trunk, BaseRef: req.Trunk, Start: true,
		Mode: req.Mode, WorkspaceId: req.WorkspaceId, TabName: req.TabName, Agent: req.Agent}
}

// releaseKey: one agent per release step at a time.
func (req ReleaseResolveRequest) releaseKey() PrKey {
	return PrKey{Repo: "release:" + filepath.Clean(req.Dir) + "@" + req.Tag + "/" + req.Phase}
}

func releaseNoticeKey(f agentFollow) string {
	return releaseNoticeAt + strings.ToLower(f.req.Dir) + "@" + f.origin.Tag + "/" + f.origin.Phase + ":"
}

// releasePromptLine holds the rules that must hold even if the brief is not read; it fits the guarded typing path.
func releasePromptLine(req ReleaseResolveRequest, briefPath string) string {
	what := "Find the cause and resolve it"
	if req.Mode == AgentModeTogether {
		what = "The developer is with you: find the cause with them and resolve it"
	}
	return fmt.Sprintf("MoltenTerm: release %s failed at %s (%s). %s: rerun the failed jobs when the code is not the cause, "+
		"or fix it on a ticket branch with a PR into %s. Never push %s or main, never merge, tag, publish or run the release. "+
		"Brief: %s", req.Tag, req.Step, req.Phase, what, req.Trunk, req.Trunk, briefPath)
}

func renderReleaseBrief(req ReleaseResolveRequest, tree string, logPath string, commit string, outcomePath string) string {
	var b strings.Builder
	repoArg := ""
	if req.Repo != "" {
		repoArg = " -R " + req.Repo
	}
	fmt.Fprintf(&b, "# Resolve the failed release step: %s, %s\n\n", req.Tag, req.Step)
	if req.Mode == AgentModeTogether {
		b.WriteString("MoltenTerm wrote this brief when the developer clicked Investigate together on the release card: a step " +
			"of the release failed. The developer is in this tab with you, the failing logs beside your terminal: explain what " +
			"you find as you go and agree with them before you change anything. You work under the developer's usual permissions.\n\n")
	} else {
		b.WriteString("MoltenTerm wrote this brief when the developer clicked Analyze and resolve on the release card: a step " +
			"of the release failed. The developer asks you to find the cause and resolve what you can on your own, within the " +
			"release rules below; MoltenTerm tells them what you did. You work under the developer's usual permissions.\n\n")
	}
	fmt.Fprintf(&b, "- Release: %s\n- Failed phase: %s\n- Failed step: %s\n", req.Tag, req.Phase, req.Step)
	if req.Repo != "" {
		fmt.Fprintf(&b, "- Repository: %s\n", req.Repo)
	}
	fmt.Fprintf(&b, "- Trunk (fixes go there by pull request): %s\n- Project: %s\n- Your copy of origin/%s (detached): %s\n", req.Trunk, req.Dir, req.Trunk, tree)
	fmt.Fprintf(&b, "- The step's log and the failed jobs' logs: %s\n\n", logPath)
	if len(req.Runs) > 0 {
		b.WriteString("## Failed GitHub runs\n\n")
		for _, c := range req.Runs {
			fmt.Fprintf(&b, "- %s", c.Name)
			if c.Url != "" {
				fmt.Fprintf(&b, ": %s", c.Url)
			}
			if c.RunId > 0 {
				fmt.Fprintf(&b, "\n  - log: `gh run view %d --log-failed%s`\n  - rerun: `gh run rerun %d --failed%s`", c.RunId, repoArg, c.RunId, repoArg)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("## Release rules\n\n")
	fmt.Fprintf(&b, "- Never push to %s, main or a release branch, never merge a pull request, never create, move or push a tag, never publish or edit a GitHub release, never run `molten release` or the project's release steps: the developer retries the step from the release card.\n", req.Trunk)
	b.WriteString("- Never touch the project's main checkout or another worktree (a release worktree included): work only in your copy.\n")
	b.WriteString("- Never change a ticket's status.\n\n")
	b.WriteString("## Steps\n\n")
	fmt.Fprintf(&b, "1. Read the log file above: the step's own lines say what it waited on or what failed; then each failed job's log. Find the failing step: the `--- FAIL` lines for Go, the failing test for vitest, the first error otherwise.\n")
	fmt.Fprintf(&b, "2. Find the cause. Is it the code (the same failure again on a rerun, or in the worktree: `git fetch origin`, run the failing test there), or not (a network reset, a runner or a service outage, a flaky test: look at the same workflow's earlier runs with `gh run list --workflow <file>%s`)?\n", repoArg)
	b.WriteString("3. Resolve it, by cause:\n")
	b.WriteString("   - Not the code: rerun the failed jobs once (the rerun commands above) and watch them (`gh run watch <run id>" + repoArg + "`). If the same unrelated failure comes back, look for an open ticket on it first and open one only when none exists, following the project's workflow, then stop.\n")
	fmt.Fprintf(&b, "   - The code: open or find the ticket, create its branch from origin/%s in your copy following the project's naming, fix it, run the project's checks that cover it, commit in the project's format `%s`, push the branch and open a pull request into %s. Do not merge it.\n", req.Trunk, commit, req.Trunk)
	b.WriteString("4. At most two reruns and one fix pull request; stop and ask the developer for a real decision only (a fix that changes the product's behaviour, or a risk to accept).\n")
	fmt.Fprintf(&b, "5. Last, write one line in the developer's language to %s: what you did and whether the step can be retried now (\"reran Perf budgets, green: retry the step\", \"fix PR #<n> into %s: merge it, then retry\"). When you stop for a decision or give up, start the line with `needs you:` and say why. Then end your turn: MoltenTerm tells the developer.\n", outcomePath, req.Trunk)
	return b.String()
}

// releaseLog writes the step's log and the failed jobs' logs, read through the developer's gh, in one file the brief
// and the Investigate together tab name.
func (r *Restarter) releaseLog(ctx context.Context, req ReleaseResolveRequest, path string) error {
	var b strings.Builder
	fmt.Fprintf(&b, "=== %s: %s (%s) ===\n", req.Tag, req.Step, req.Phase)
	text := req.Log
	if len(text) > maxReleaseLog {
		text = text[len(text)-maxReleaseLog:]
	}
	b.WriteString(strings.TrimRight(text, "\n"))
	b.WriteString("\n")
	for _, c := range req.Runs {
		if c.RunId <= 0 {
			continue
		}
		fmt.Fprintf(&b, "\n=== %s: failed jobs of run %d ===\n", c.Name, c.RunId)
		if r.env.Gh == nil {
			b.WriteString("(gh is not available here)\n")
			continue
		}
		args := []string{"run", "view", strconv.FormatInt(c.RunId, 10), "--log-failed"}
		if req.Repo != "" {
			args = append(args, "-R", req.Repo)
		}
		out, err := r.env.Gh(ctx, req.Dir, args...)
		if err != nil {
			fmt.Fprintf(&b, "(the log could not be read: %v)\n", err)
			continue
		}
		logText := string(out)
		if len(logText) > maxReleaseLog {
			logText = logText[len(logText)-maxReleaseLog:]
		}
		b.WriteString(strings.TrimRight(logText, "\n"))
		b.WriteString("\n")
	}
	return os.WriteFile(path, []byte(b.String()), 0600)
}

// releaseBrief writes the brief and the logs in MoltenTerm's data folder, never in the project:
// <data>/molten/reviews/<repo-key>/release/<tag>-<phase>.md, .log beside it; the last outcome line goes.
func (r *Restarter) releaseBrief(ctx context.Context, req ReleaseResolveRequest, tree string) (string, string, error) {
	repoKey := releaseNoRepo
	if req.Repo != "" {
		repoKey = RepoKey(req.Repo)
	}
	dir := filepath.Join(r.env.DataDir, "molten", "reviews", repoKey, releaseDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", "", err
	}
	base := filepath.Join(dir, unsafeNameRe.ReplaceAllString(req.Tag, "-")+"-"+req.Phase)
	path, logPath := base+".md", base+releaseLogExt
	outcome := investigateOutcomePath(path)
	if err := os.Remove(outcome); err != nil && !os.IsNotExist(err) {
		return "", "", err
	}
	if err := r.releaseLog(ctx, req, logPath); err != nil {
		return "", "", err
	}
	text := renderReleaseBrief(req, tree, logPath, r.commitFormat(req.Dir, 0), outcome)
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", "", err
	}
	return path, logPath, nil
}

// releaseTree makes the agent's copy: a new worktree, detached at origin/<trunk>, in MoltenTerm's data folder.
func (r *Restarter) releaseTree(ctx context.Context, req ReleaseResolveRequest) (string, error) {
	r.git(ctx, req.Dir, "worktree", "prune")
	r.git(ctx, req.Dir, "fetch", "--quiet", "origin", "+refs/heads/"+req.Trunk+":refs/remotes/origin/"+req.Trunk)
	start := "origin/" + req.Trunk
	if _, err := r.git(ctx, req.Dir, "rev-parse", "--verify", "--quiet", "refs/remotes/"+start); err != nil {
		return "", uimsg.Errorf(uimsg.Make("review.branchmissing", "branch", req.Trunk), "the branch %s was found neither in the project nor on origin", req.Trunk)
	}
	parent := reviewsession.ReviewTreesDir(r.env.DataDir, req.Dir)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	name := releaseTreePre + unsafeNameRe.ReplaceAllString(req.Tag, "-")
	tree := filepath.Join(parent, name)
	for i := 2; pathExists(tree); i++ {
		tree = filepath.Join(parent, name+"-"+strconv.Itoa(i))
	}
	if _, err := r.git(ctx, req.Dir, "worktree", "add", "--quiet", "--detach", tree, start); err != nil {
		return "", uimsg.Errorf(uimsg.Make("review.worktreecreate", "branch", req.Trunk, "detail", uimsg.Detail(err)),
			"a worktree on %s could not be created: %w", req.Trunk, err)
	}
	return tree, nil
}

// AskReleaseResolve is the developer's click on Analyze and resolve (background) or Investigate together (together) on
// a failed release step: a new agent starts in its own copy of the trunk with the release brief.
func (r *Restarter) AskReleaseResolve(ctx context.Context, req ReleaseResolveRequest) (RestartResult, error) {
	if err := req.check(); err != nil {
		return RestartResult{}, err
	}
	req.Dir = filepath.Clean(req.Dir)
	req.Step = cleanCheck(InvestigateCheck{Name: req.Step}).Name
	runs := make([]InvestigateCheck, 0, len(req.Runs))
	for i, c := range req.Runs {
		if i == maxReleaseRuns {
			break
		}
		runs = append(runs, cleanCheck(c))
	}
	req.Runs = runs
	key := req.releaseKey()
	if !r.claim(key) {
		return RestartResult{Status: RestartBusy, Reason: RestartReasonInFlight,
			Message: "An agent is already being started for this step."}, nil
	}
	defer r.release(key)
	rreq := req.restartRequest()
	result := RestartResult{Branch: req.Trunk}
	agent, choice := r.pickAgent(ctx, rreq)
	noteChoice(&result, choice)
	if agent == "" {
		result.Status = RestartNoAgent
		if choice.Missing {
			result.Reason = RestartReasonAgentMissing
			result.Message = choice.MissingText() + ". Nothing was started."
			return result, nil
		}
		result.Message = agentchoice.NoneText() + ". Nothing was started."
		return result, nil
	}
	if r.env.OpenTerminal == nil || r.env.AgentTab == nil {
		result.Status, result.Reason, result.Message = RestartFailed, RestartReasonTerminal, "MoltenTerm cannot open terminals yet: try again in a moment."
		return result, nil
	}
	tree, err := r.releaseTree(ctx, req)
	if err != nil {
		result.Status, result.Reason, result.Message = RestartFailed, RestartReasonWorktree, err.Error()
		return result, nil
	}
	result.Worktree, result.WorktreeCreated = tree, true
	briefPath, logPath, err := r.releaseBrief(ctx, req, tree)
	if err != nil {
		r.git(ctx, req.Dir, "worktree", "remove", "--force", tree)
		result.Status, result.Reason, result.Message = RestartFailed, RestartReasonBrief, fmt.Sprintf("the brief could not be written: %v", err)
		return result, nil
	}
	result.BriefPath = briefPath
	origin := AgentOrigin{Kind: AgentOriginRelease, Repo: req.Repo, Branch: req.Trunk, Tag: req.Tag, Phase: req.Phase,
		Step: req.Step, Mode: req.Mode, At: r.env.Now().UnixMilli()}
	name := req.TabName
	if name == "" {
		name = "Release " + req.Tag
	}
	tabId, err := r.env.AgentTab(ctx, req.WorkspaceId, name, waveobj.MetaMapType{AgentTabMetaKey: "release:" + req.Tag},
		req.Mode == AgentModeBackground)
	if err != nil {
		r.git(ctx, req.Dir, "worktree", "remove", "--force", tree)
		result.Status, result.Reason, result.Message = RestartFailed, RestartReasonTerminal, fmt.Sprintf("The agent's tab could not be made: %v", err)
		return result, nil
	}
	command := reviewsession.CommandLine(agent, []string{"--", releasePromptLine(req, briefPath)})
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     tree,
		molten.WorktreeMetaKey:     tree,
		OriginMetaKey:              origin,
	}
	blockId, err := r.env.OpenTerminal(ctx, tabId, "", meta, command)
	result.BlockId, result.Agent, result.AgentName = blockId, agent, molten.AgentDisplayName(agent)
	result.TabId, result.Hidden = tabId, req.Mode == AgentModeBackground
	if blockId == "" {
		if r.env.CloseTab != nil {
			if cerr := r.env.CloseTab(ctx, tabId); cerr == nil {
				result.TabId = ""
			}
		}
		r.git(ctx, req.Dir, "worktree", "remove", "--force", tree)
		result.Status, result.Reason = RestartFailed, RestartReasonNotStarted
		result.Message = fmt.Sprintf("The agent was not started (%v).", err)
		return result, nil
	}
	if req.Mode == AgentModeTogether {
		logMeta := waveobj.MetaMapType{
			waveobj.MetaKey_View:       "term",
			waveobj.MetaKey_Controller: "shell",
			waveobj.MetaKey_CmdCwd:     tree,
		}
		if _, lerr := r.env.OpenTerminal(ctx, tabId, blockId, logMeta, reviewsession.CommandLine("less", []string{"-R", "+G", logPath})); lerr != nil {
			log.Printf("%s release %s: the log terminal could not be opened: %v\n", logPrefix, req.Tag, lerr)
		}
	}
	r.startFollow(agentFollow{req: rreq, origin: origin, tree: tree, created: true, blockId: blockId, tabId: tabId,
		agent: agent, outcomePath: investigateOutcomePath(briefPath)})
	if err != nil {
		result.Status, result.Reason = RestartFailed, RestartReasonNotStarted
		result.Message = fmt.Sprintf("The agent was not started (%v). Start it in the new terminal with: %s", err, command)
		return result, nil
	}
	result.Status = RestartStarted
	result.Message = fmt.Sprintf("%s started in %s.", result.AgentName, tree)
	return result, nil
}

// followRelease follows a release agent: once it stops, its outcome line goes to the developer by notification (a
// warning when it needs them, or when it stopped out of sight without one); once its terminal is gone, the copy
// MoltenTerm made goes when nothing is left in it. False when the follow ends.
func (r *Restarter) followRelease(ctx context.Context, f agentFollow, st *followState) bool {
	if r.env.BlockExists != nil && !r.env.BlockExists(ctx, f.blockId) {
		r.removeReleaseTree(ctx, f)
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
	if running && (run.State == molten.AgentStateWaiting || run.State == molten.AgentStateError) {
		// Its question is its own notification, with Go to the terminal.
		return true
	}
	stopped := (st.sawRun && !running) || st.sawWorking || run.State == molten.AgentStateDone
	if !stopped {
		return true
	}
	name := agentName(run, f.agent)
	outcome := readOutcome(f.outcomePath)
	if outcome == "" {
		if f.origin.Mode != AgentModeBackground || st.notice == "-" {
			return true
		}
		st.notice = "-"
		r.notifyRelease(ctx, f, "warning", name+" stopped on "+f.origin.Tag+" without saying what it did: its terminal says.",
			uimsg.Make("notif.release.silent", "name", name, "tag", f.origin.Tag), uimsg.Make("notif.release.needsTitle", "name", name, "tag", f.origin.Tag))
		return true
	}
	if st.notice == outcome {
		return true
	}
	st.notice = outcome
	if reason, needs := outcomeNeedsYou(outcome); needs {
		r.notifyRelease(ctx, f, "warning", name+": "+reason, uimsg.Make("notif.release.outcome", "name", name, "outcome", reason),
			uimsg.Make("notif.release.needsTitle", "name", name, "tag", f.origin.Tag))
		return true
	}
	r.notifyRelease(ctx, f, "success", name+": "+outcome, uimsg.Make("notif.release.outcome", "name", name, "outcome", outcome),
		uimsg.Make("notif.release.doneTitle", "tag", f.origin.Tag, "step", f.origin.Step))
	return true
}

func (r *Restarter) notifyRelease(ctx context.Context, f agentFollow, kind string, message string, text *uimsg.Text, title *uimsg.Text) {
	english := map[string]string{
		"notif.release.needsTitle": title.Vars["name"] + " needs you on the release " + f.origin.Tag,
		"notif.release.doneTitle":  "Release " + f.origin.Tag + ": " + f.origin.Step + " looked into",
	}[title.Code]
	r.notify(ctx, molten.NotificationInput{
		Key:         releaseNoticeKey(f),
		Source:      "agent",
		Kind:        kind,
		Title:       english,
		TitleText:   title,
		Message:     message,
		MessageText: text,
		WorkspaceId: f.req.WorkspaceId,
		TabId:       f.tabId,
		BlockId:     f.blockId,
		Actions:     []molten.NotificationAction{f.terminalAction()},
	})
}

// removeReleaseTree: the agent's terminal is gone; its copy goes when nothing is left in it (no change, no commit
// that is not on origin), else it stays for the developer.
func (r *Restarter) removeReleaseTree(ctx context.Context, f agentFollow) {
	if !f.created || !pathExists(f.tree) {
		return
	}
	facts, err := r.readTree(ctx, f)
	if err != nil || !facts.clean() {
		return
	}
	if _, err := r.git(ctx, f.req.Dir, "worktree", "remove", f.tree); err != nil {
		log.Printf("%s release %s: the worktree %s is kept: %v\n", logPrefix, f.origin.Tag, f.tree, err)
		return
	}
	os.RemoveAll(f.tree)
}

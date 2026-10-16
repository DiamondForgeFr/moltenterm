// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The batch's agent (FR-REV-025): needed only when a PR of the batch conflicts. The developer's agent starts once per
// run, out of sight (#758: a hidden tab of the workspace, its terminal saying where it comes from), in a detached
// worktree of its own under MoltenTerm's data folder: the developer's main checkout is never touched. Each conflicting
// PR gets one brief, typed through the guarded typing path (#595) once the agent is idle. The agent rebases, resolves,
// runs the project's checks, pushes with lease and writes one line to a result file: "pushed <oid>", or "stopped <why>"
// when a conflict's right resolution is unclear. wavesrv never merges on the agent's word: it reads the PR again and
// waits for the checks on the pushed head.

const (
	batchResultPushed  = "pushed"
	batchResultStopped = "stopped"
	batchNoteMax       = 300
)

type batchAgent struct {
	tabName string
	tree    string
	blockId string
	tabId   string
	agent   string
	sawRun  bool
}

func (b *BatchRunner) briefDir(repo string) string {
	return filepath.Join(b.env.DataDir, "molten", "reviews", RepoKey(repo), batchDirName)
}

// makeTree adds the agent's detached worktree on the base, beside MoltenTerm's review worktrees of the project.
func (b *BatchRunner) makeTree(run BatchRun) (string, error) {
	r := b.env.Agents
	ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
	defer cancel()
	parent := reviewsession.ReviewTreesDir(b.env.DataDir, run.Dir)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	tree := filepath.Join(parent, batchTreeName)
	for i := 2; pathExists(tree); i++ {
		tree = filepath.Join(parent, batchTreeName+"-"+strconv.Itoa(i))
	}
	remote := "refs/remotes/origin/" + run.Base
	r.git(ctx, run.Dir, "fetch", "--quiet", "origin", "+refs/heads/"+run.Base+":"+remote)
	if _, err := r.git(ctx, run.Dir, "worktree", "add", "--detach", "--quiet", tree, remote); err != nil {
		return "", fmt.Errorf("the agent's worktree could not be created: %v", err)
	}
	return tree, nil
}

func batchPromptLine(item BatchItem, base string, tree string, result string, brief string) string {
	return fmt.Sprintf("MoltenTerm batch merge: rebase PR #%d (%s) on origin/%s in %s, resolve the conflicts, run the "+
		"project's checks, push with --force-with-lease, then write the result to %s. Never merge the PR. Brief: %s",
		item.Number, item.HeadRef, base, tree, result, brief)
}

func renderBatchBrief(run BatchRun, item BatchItem, tree string, result string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Batch merge: rebase PR #%d on %s\n\n", item.Number, run.Base)
	fmt.Fprintf(&b, "MoltenTerm wrote this brief: the developer started a batch merge of %d PRs into %s and confirmed it. ", len(run.Items), run.Base)
	fmt.Fprintf(&b, "PR #%d conflicts with %s now that the PRs before it are merged. MoltenTerm merges each PR itself once "+
		"its checks pass; your part is the rebase. You work under the developer's usual permissions, in a worktree of "+
		"your own: the developer's main checkout is not touched.\n\n", item.Number, run.Base)
	fmt.Fprintf(&b, "- Pull request: #%d", item.Number)
	if item.Title != "" {
		fmt.Fprintf(&b, " %s", item.Title)
	}
	if item.Url != "" {
		fmt.Fprintf(&b, " (%s)", item.Url)
	}
	fmt.Fprintf(&b, "\n- Repository: %s\n- Branch: %s into %s\n- Head when asked: %s\n- Worktree: %s (detached HEAD)\n",
		run.Repo, item.HeadRef, run.Base, item.Head, tree)
	fmt.Fprintf(&b, "- Result file: %s\n\n## Steps\n\n", result)
	fmt.Fprintf(&b, "1. Work in %s. `git fetch origin`, then `git checkout --detach %s` (the PR's head). If the worktree has "+
		"uncommitted changes from an earlier PR, discard them only if they are yours from that PR.\n", tree, item.Head)
	fmt.Fprintf(&b, "2. `git rebase origin/%s`. Never merge %s into the branch (no `git merge`, no `git pull`).\n", run.Base, run.Base)
	fmt.Fprintf(&b, "3. Resolve each conflict keeping the intent of both sides, then `git rebase --continue`. When a conflict's "+
		"right resolution is unclear, `git rebase --abort`, write `stopped <one line: which files and why>` to the result "+
		"file and stop there: the developer decides.\n")
	b.WriteString("4. Run the project's checks the resolution touches (build, tests, lint) and fix what the rebase broke, in a commit on top.\n")
	fmt.Fprintf(&b, "5. Push: `git push --force-with-lease=refs/heads/%s:%s origin HEAD:refs/heads/%s` (never a plain "+
		"`--force`). If the lease refuses (someone pushed meanwhile), write `stopped the branch moved on origin` to the "+
		"result file and stop.\n", item.HeadRef, item.Head, item.HeadRef)
	fmt.Fprintf(&b, "6. Write `pushed <the full commit id of HEAD>` (`git rev-parse HEAD`) to %s.\n", result)
	b.WriteString("7. Do not merge, approve or close the PR, and do not change the ticket's status: MoltenTerm waits for the " +
		"checks on your push and merges the PR itself. Then wait: the next PR, if any, comes the same way.\n")
	return b.String()
}

// writeBatchBrief writes the PR's brief in MoltenTerm's data folder and clears its result file.
func (b *BatchRunner) writeBatchBrief(run BatchRun, item BatchItem, tree string) (string, string, error) {
	dir := b.briefDir(run.Repo)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", "", err
	}
	name := fmt.Sprintf("%s-%d-%d", shortId(run.Id), item.Number, item.Rebases+1)
	brief := filepath.Join(dir, name+".md")
	result := filepath.Join(dir, name+".result")
	os.Remove(result)
	if err := os.WriteFile(brief, []byte(renderBatchBrief(run, item, tree, result)), 0600); err != nil {
		return "", "", err
	}
	return brief, result, nil
}

// readBatchResult: the agent's line, ok false while it wrote none.
func readBatchResult(path string) (pushed string, note string, stopped bool, ok bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", false, false
	}
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)[0])
	if line == "" {
		return "", "", false, false
	}
	if rest, found := strings.CutPrefix(line, batchResultPushed); found && isOid(strings.TrimSpace(rest)) {
		return strings.TrimSpace(rest), "", false, true
	}
	note = strings.TrimSpace(strings.TrimPrefix(line, batchResultStopped))
	if len(note) > batchNoteMax {
		note = note[:batchNoteMax] + "…"
	}
	return "", note, true, true
}

func (b *BatchRunner) startBatchAgent(ctl *batchCtl, agent *batchAgent, k PrKey, line string) (batchStop, bool) {
	r := b.env.Agents
	run := b.read(ctl)
	ctx, cancel := context.WithTimeout(context.Background(), restartTimeout)
	defer cancel()
	id := r.pickAgent(ctx, RestartRequest{PrKey: k, Dir: run.Dir})
	if id == "" {
		return batchStop{reason: BatchReasonNoAgent}, false
	}
	if r.env.AgentTab == nil || r.env.OpenTerminal == nil {
		return batchStop{reason: BatchReasonAgentStart, detail: "MoltenTerm cannot open terminals yet"}, false
	}
	name := agent.tabName
	if name == "" {
		name = "Batch merge"
	}
	tabId, err := r.env.AgentTab(ctx, run.WorkspaceId, name, waveobj.MetaMapType{AgentTabMetaKey: "batch:" + strings.ToLower(run.Repo)}, true)
	if err != nil {
		return batchStop{reason: BatchReasonAgentStart, detail: err.Error()}, false
	}
	origin := AgentOrigin{Kind: AgentOriginBatch, Repo: run.Repo, Base: run.Base, Count: len(run.Items), Mode: AgentModeBackground,
		At: b.env.Now().UnixMilli()}
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "shell",
		waveobj.MetaKey_CmdCwd:     agent.tree,
		molten.WorktreeMetaKey:     agent.tree,
		OriginMetaKey:              origin,
	}
	command := reviewsession.CommandLine(id, []string{"--", line})
	blockId, err := r.env.OpenTerminal(ctx, tabId, "", meta, command)
	if blockId == "" {
		if r.env.CloseTab != nil {
			r.env.CloseTab(ctx, tabId)
		}
		detail := "the agent's terminal could not be opened"
		if err != nil {
			detail = err.Error()
		}
		return batchStop{reason: BatchReasonAgentStart, detail: detail}, false
	}
	agent.blockId, agent.tabId, agent.agent = blockId, tabId, id
	b.change(ctl, func(run *BatchRun) {
		run.Agent, run.AgentName, run.BlockId, run.TabId = id, molten.AgentDisplayName(id), blockId, tabId
	})
	if err != nil {
		return batchStop{reason: BatchReasonAgentStart, detail: fmt.Sprintf("%v; start it in its terminal with: %s", err, command)}, false
	}
	return batchStop{}, true
}

// typeBatchLine hands the next brief to the batch's agent once it can take it.
func (b *BatchRunner) typeBatchLine(ctl *batchCtl, agent *batchAgent, line string) (batchStop, int) {
	r := b.env.Agents
	if r.env.TypePrompt == nil {
		return batchStop{reason: BatchReasonAgentStart, detail: "MoltenTerm cannot type in terminals yet"}, batchStopped
	}
	start := b.env.Now()
	for {
		if b.env.Agents.env.BlockExists != nil && !b.env.Agents.env.BlockExists(context.Background(), agent.blockId) {
			return batchStop{reason: BatchReasonAgentExited}, batchStopped
		}
		ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
		out := r.env.TypePrompt(ctx, agent.blockId, line)
		cancel()
		if out.Sent {
			return batchStop{}, batchMerged
		}
		if !out.Retry {
			return batchStop{reason: BatchReasonAgentStart, detail: out.Message}, batchStopped
		}
		if b.cancelAsked(ctl) {
			return batchStop{}, batchCancelled
		}
		if b.env.Now().Sub(start) > b.env.AgentLimit {
			return batchStop{reason: BatchReasonAgentTimeout}, batchStopped
		}
		b.env.Sleep(context.Background(), b.env.AgentEvery)
	}
}

// rebase hands PR i to the agent and waits for its result; batchMerged here means pushed, the caller reads the PR
// again and waits for its checks.
func (b *BatchRunner) rebase(ctl *batchCtl, agent *batchAgent, i int, pr ghMergePr) (batchStop, int) {
	if b.env.Agents == nil {
		return batchStop{reason: BatchReasonNoAgent}, batchStopped
	}
	b.setItem(ctl, i, func(it *BatchItem) {
		it.State, it.Waiting, it.Head = BatchItemRebasing, false, pr.HeadRefOid
	})
	run := b.read(ctl)
	item := run.Items[i]
	k := PrKey{Repo: run.Repo, Number: item.Number}
	if agent.tree == "" {
		tree, err := b.makeTree(run)
		if err != nil {
			return batchStop{reason: BatchReasonAgentStart, detail: err.Error()}, batchStopped
		}
		agent.tree = tree
		b.change(ctl, func(run *BatchRun) { run.Worktree = tree })
	}
	brief, result, err := b.writeBatchBrief(run, item, agent.tree)
	if err != nil {
		return batchStop{reason: BatchReasonAgentStart, detail: fmt.Sprintf("the brief could not be written: %v", err)}, batchStopped
	}
	line := batchPromptLine(item, run.Base, agent.tree, result, brief)
	if agent.blockId == "" {
		if stop, ok := b.startBatchAgent(ctl, agent, k, line); !ok {
			return stop, batchStopped
		}
	} else if stop, out := b.typeBatchLine(ctl, agent, line); out != batchMerged {
		return stop, out
	}
	log.Printf("%s batch %s: #%d handed to %s\n", logPrefix, run.Id, item.Number, agent.agent)
	return b.waitAgent(ctl, agent, i, result)
}

func (b *BatchRunner) waitAgent(ctl *batchCtl, agent *batchAgent, i int, result string) (batchStop, int) {
	env := b.env.Agents.env
	start := b.env.Now()
	for {
		if pushed, note, stopped, ok := readBatchResult(result); ok {
			b.setItem(ctl, i, func(it *BatchItem) { it.Waiting = false })
			if stopped {
				return batchStop{reason: BatchReasonAmbiguous, note: note}, batchStopped
			}
			b.setItem(ctl, i, func(it *BatchItem) { it.Head = pushed })
			return batchStop{}, batchMerged
		}
		if env.BlockExists != nil && !env.BlockExists(context.Background(), agent.blockId) {
			return batchStop{reason: BatchReasonAgentExited}, batchStopped
		}
		info, known := b.env.Agents.agentRunOf(agent.blockId)
		running := known && info.Running
		if running {
			agent.sawRun = true
		}
		if agent.sawRun && !running {
			// The result may have been written just before the session ended.
			if _, _, _, ok := readBatchResult(result); !ok {
				return batchStop{reason: BatchReasonAgentExited}, batchStopped
			}
			continue
		}
		waiting := running && (info.State == molten.AgentStateWaiting || info.State == molten.AgentStateError)
		if b.read(ctl).Items[i].Waiting != waiting {
			b.setItem(ctl, i, func(it *BatchItem) { it.Waiting = waiting })
		}
		if b.cancelAsked(ctl) && !(running && info.State == molten.AgentStateWorking) {
			return batchStop{}, batchCancelled
		}
		if b.env.Now().Sub(start) > b.env.AgentLimit {
			return batchStop{reason: BatchReasonAgentTimeout}, batchStopped
		}
		b.env.Sleep(context.Background(), b.env.AgentEvery)
	}
}

// cleanAgent is the clean end (#758): with nothing uncommitted, no rebase stopped halfway and nothing unpushed, the
// agent's terminal closes (its hidden tab with it) and its worktree goes; otherwise both stay and the run says why.
func (b *BatchRunner) cleanAgent(ctl *batchCtl, agent *batchAgent) {
	if agent.tree == "" {
		return
	}
	r := b.env.Agents
	ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
	defer cancel()
	kept := b.treeKept(ctx, agent)
	if kept != "" {
		b.change(ctl, func(run *BatchRun) { run.Kept = kept })
		return
	}
	if agent.blockId != "" && r.env.CloseTerminal != nil {
		if err := r.env.CloseTerminal(ctx, agent.blockId); err != nil {
			log.Printf("%s batch: the agent's terminal could not be closed: %v\n", logPrefix, err)
			b.change(ctl, func(run *BatchRun) { run.Kept = BatchKeptWorking })
			return
		}
	}
	run := b.read(ctl)
	if _, err := r.git(ctx, run.Dir, "worktree", "remove", "--force", agent.tree); err != nil {
		log.Printf("%s batch: the worktree %s is kept: %v\n", logPrefix, agent.tree, err)
	}
	os.RemoveAll(agent.tree)
	r.git(ctx, run.Dir, "worktree", "prune")
	b.change(ctl, func(run *BatchRun) { run.Cleaned = true })
}

// treeKept: why the agent's worktree must stay, "" when nothing would be lost.
func (b *BatchRunner) treeKept(ctx context.Context, agent *batchAgent) string {
	r := b.env.Agents
	if agent.blockId != "" {
		if info, ok := r.agentRunOf(agent.blockId); ok && info.Running && info.State == molten.AgentStateWorking {
			return BatchKeptWorking
		}
	}
	status, err := r.git(ctx, agent.tree, "status", "--porcelain", "--untracked-files=normal")
	if err != nil {
		return BatchKeptUnread
	}
	for _, name := range []string{"rebase-merge", "rebase-apply"} {
		path, err := r.git(ctx, agent.tree, "rev-parse", "--git-path", name)
		if err != nil || path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(agent.tree, path)
		}
		if pathExists(path) {
			return BatchKeptRebasing
		}
	}
	if strings.TrimSpace(status) != "" {
		return BatchKeptChanges
	}
	count, err := r.git(ctx, agent.tree, "rev-list", "--count", "HEAD", "--not", "--remotes")
	if err != nil {
		return BatchKeptUnread
	}
	if n, _ := strconv.Atoi(count); n > 0 {
		return BatchKeptUnpushed
	}
	return ""
}

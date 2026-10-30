// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentsign"
)

// Who works in a linked worktree no agent terminal is placed in (#1603, FR-REV-022 AC4), for any agent CLI and
// wherever the worktree lives: first a live agent panel whose process, or a process under it, works inside the
// worktree (that panel's agent, with Go to); then the work's signature, the newest Molten-Agent trailer of the
// branch's commits after the PR target, else the open PR's molten:agents block; then the agent's own worktrees
// folder (BackgroundAgents); else nobody is named.

const (
	// The processes whose folder is read per answer, over every agent panel: an agent's tree (its MCP servers, its
	// tools' commands) is far smaller.
	liveTreeMaxProcs = 256
	// The branch's commits read for a signature trailer.
	signatureMaxCommits = 50
	commitSep           = "\x1e"
)

type backgroundFacts struct {
	// procs: the answer's one process-table read (procsReader), nil without one.
	procs     func() ProcFacts
	targetRef string
	// prBodies: the open PRs' bodies by head branch.
	prBodies map[string]string
}

func hasAgentPids(places []AgentPlace) bool {
	for _, p := range places {
		if !p.Review && p.Agent != "" && p.Pid > 0 {
			return true
		}
	}
	return false
}

// LiveTreeAgents places an agent panel in each candidate worktree its process, or one of its descendants, works in:
// the agent works there even when its terminal's folder is elsewhere. The first panel found wins a worktree.
func LiveTreeAgents(cands []treeEntry, places []AgentPlace, procs ProcFacts) []BranchAgent {
	if procs == nil || len(cands) == 0 {
		return nil
	}
	taken := map[string]bool{}
	var rtn []BranchAgent
	read := 0
	for _, p := range places {
		if p.Review || p.Agent == "" || p.Pid <= 0 || read >= liveTreeMaxProcs {
			continue
		}
		for _, pid := range append([]int32{p.Pid}, procs.Descendants(p.Pid)...) {
			if read >= liveTreeMaxProcs {
				break
			}
			read++
			cwd := procs.Cwd(pid)
			if !filepath.IsAbs(cwd) {
				continue
			}
			tree, ok := treeOf(cands, filepath.Clean(cwd))
			if !ok || taken[tree.path] {
				continue
			}
			taken[tree.path] = true
			rtn = append(rtn, BranchAgent{
				Branch: tree.branch, Worktree: tree.path, Kind: UpcomingAgentPanel, BlockId: p.BlockId, Agent: p.Agent,
				FirstName: p.FirstName, Started: p.Started,
			})
		}
	}
	return rtn
}

// openPrBodies: the bodies of the snapshot's open PRs, by head branch (none from a fork).
func openPrBodies(snap Snapshot) map[string]string {
	gh := snap.Github
	if gh == nil || len(gh.Prs) == 0 {
		return nil
	}
	var prs []ghReviewPr
	if err := json.Unmarshal(gh.Prs, &prs); err != nil {
		return nil
	}
	rtn := map[string]string{}
	for _, pr := range prs {
		if !pr.IsCrossRepository && pr.Body != "" {
			rtn[pr.HeadRefName] = pr.Body
		}
	}
	return rtn
}

// treeSignature: the last agent who signed the worktree's branch, its commits after targetRef first, then body.
// Without a target no commit is read: the trunk's commits carry other agents' trailers.
func (u *Upcoming) treeSignature(ctx context.Context, tree string, targetRef string, body string) (agentsign.Signature, bool) {
	var messages []string
	if targetRef != "" {
		g := &gitReader{ctx: ctx, run: u.env.Run, dir: tree}
		if out, err := g.out("log", "-n", strconv.Itoa(signatureMaxCommits), "--format=%B"+commitSep, targetRef+"..HEAD"); err == nil {
			messages = commitMessagesOldestFirst(out)
		}
	}
	return LastSigner(messages, body)
}

func commitMessagesOldestFirst(out string) []string {
	var rtn []string
	parts := strings.Split(out, commitSep)
	for i := len(parts) - 1; i >= 0; i-- {
		if msg := strings.TrimSpace(parts[i]); msg != "" {
			rtn = append(rtn, msg)
		}
	}
	if len(rtn) > signatureMaxCommits {
		rtn = rtn[len(rtn)-signatureMaxCommits:]
	}
	return rtn
}

// LastSigner: the newest commit trailer of messages (oldest first), else the body's "Made by".
func LastSigner(messages []string, body string) (agentsign.Signature, bool) {
	agents, _ := agentsign.PrAgents(messages, body)
	for _, a := range agents {
		if !a.IsZero() {
			return a, true
		}
	}
	return agentsign.Signature{}, false
}

// agentIdOfName: the catalog's id of a CLI named as a signature names it, "" when the catalog does not know it.
func agentIdOfName(name string) string {
	for _, kind := range molten.AgentKinds {
		if strings.EqualFold(kind.Name, strings.TrimSpace(name)) || strings.EqualFold(kind.Id, strings.TrimSpace(name)) {
			return kind.Id
		}
	}
	return ""
}

// SignedAgent names a background agent by its signature. The signature wins over the worktrees folder's guess, so
// the guessed parent goes; the signer's own session, when a panel still runs it, becomes the bar's Go to.
func SignedAgent(agent BranchAgent, sig agentsign.Signature, places []AgentPlace) BranchAgent {
	agent.Signed = true
	agent.FirstName = strings.TrimSpace(sig.FirstName)
	agent.AgentName = strings.TrimSpace(sig.Agent)
	if id := agentIdOfName(sig.Agent); id != "" {
		agent.Agent = id
	} else if agent.AgentName != "" {
		agent.Agent = ""
	}
	agent.ParentBlockId, agent.ParentFirstName = "", ""
	if agent.FirstName == "" {
		return agent
	}
	for _, p := range places {
		if p.Review || !strings.EqualFold(p.FirstName, agent.FirstName) {
			continue
		}
		if agent.Agent != "" && p.Agent != agent.Agent {
			continue
		}
		agent.BlockId = p.BlockId
		if agent.Agent == "" {
			agent.Agent = p.Agent
		}
		break
	}
	return agent
}

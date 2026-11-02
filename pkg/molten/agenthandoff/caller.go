// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
)

// Who in a pane made a call (#1756). A session's sub-agents run their tools in its terminal, with its token and its
// environment (Claude Code gives a sub-agent's Bash no agent id), so `molten agent whoami` from a sub-agent would sign
// with the session's model. The call sends its folder; the pane's running sub-agents, as their own files describe
// them (companion.PaneSubagents), say whose it is:
//   - the folder is a running sub-agent's own worktree (one that does not hold the session's folder): the call is that
//     sub-agent's, signed with its model and effort, under the session's first name;
//   - running sub-agents share the session's folder (or their folder is unknown): the call may be theirs, so only what
//     all of them and the session say alike is kept;
//   - else the call is the session's own.
//
// A session that runs a command in its sub-agent's worktree while the sub-agent runs signs as that sub-agent: the
// folder is the one fact the call carries.

// SubagentEnv is an Env that lists a pane's sub-agents. Without it no call is told apart from its session's.
type SubagentEnv interface {
	Subagents(blockId string) []companion.SubagentIdentity
}

func (m *Manager) callerOf(blockId string, folder string, sessionFolder string) *CallerEntry {
	if strings.TrimSpace(folder) == "" {
		return nil
	}
	env, ok := m.env.(SubagentEnv)
	if !ok {
		return nil
	}
	return callerOf(folder, sessionFolder, env.Subagents(blockId))
}

// callerOf: nil when the call is the session's own.
func callerOf(folder string, sessionFolder string, subs []companion.SubagentIdentity) *CallerEntry {
	folder = canonicalFolder(folder)
	if folder == "" {
		return nil
	}
	sessionFolder = canonicalFolder(sessionFolder)
	var own, shared []companion.SubagentIdentity
	best := ""
	for _, s := range subs {
		if s.State != companion.SubagentRunning {
			continue
		}
		wt := canonicalFolder(s.Worktree)
		switch {
		case wt == "":
			shared = append(shared, s)
		case !inFolder(wt, folder):
			continue
		case sessionFolder == "" || inFolder(wt, sessionFolder):
			shared = append(shared, s)
		default:
			if len(wt) > len(best) {
				best, own = wt, nil
			}
			if wt == best {
				own = append(own, s)
			}
		}
	}
	if len(own) > 0 {
		rtn := alikeOf(own)
		rtn.Subagent = true
		return rtn
	}
	if len(shared) == 0 {
		return nil
	}
	rtn := alikeOf(shared)
	rtn.Shared = true
	return rtn
}

// alikeOf keeps the kind, model and effort the sub-agents all have alike.
func alikeOf(subs []companion.SubagentIdentity) *CallerEntry {
	first := subs[0]
	rtn := &CallerEntry{Kind: first.Kind, Model: first.Model, Effort: first.Effort}
	for _, s := range subs[1:] {
		if s.Kind != rtn.Kind {
			rtn.Kind = ""
		}
		if handoffwire.ModelKey(s.Model) != handoffwire.ModelKey(rtn.Model) {
			rtn.Model = ""
		}
		if s.Effort != rtn.Effort {
			rtn.Effort = ""
		}
	}
	return rtn
}

func canonicalFolder(folder string) string {
	folder = strings.TrimSpace(folder)
	if folder == "" || !filepath.IsAbs(folder) {
		return ""
	}
	folder = filepath.Clean(folder)
	if real, err := filepath.EvalSymlinks(folder); err == nil {
		return real
	}
	return folder
}

// inFolder: path is dir or inside it.
func inFolder(dir string, path string) bool {
	return path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, string(os.PathSeparator))+string(os.PathSeparator))
}

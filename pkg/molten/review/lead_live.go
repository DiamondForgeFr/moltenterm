// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package review

import (
	"context"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The live side of the lead agents (#1779, lead.go): the running agents and the handoffs of wavesrv, and the sessions
// the agents' adapters know how to resume.

func liveLeadEnv(env *RestartEnv) {
	env.FindLead = agenthandoff.FindLead
	env.SendLead = agenthandoff.SendFromApp
	env.LeadSession = liveLeadSession
	env.PreferName = attention.PreferAgentName
}

// liveLeadSession says how a lead that no longer runs is resumed: its CLI's resume on the session MoltenTerm knows for
// sure, else on the CLI's most recent session of the folder (Guessed). The folder is the one the lead's terminal was
// in, when that terminal is still there and the folder is in the project; else the project's.
func liveLeadSession(ctx context.Context, name string, agent string, dir string) (LeadSession, bool) {
	adapter := agentcontinuity.Find(agent)
	if adapter == nil || adapter.Capabilities()[agentcontinuity.CapResume].Support == agentcontinuity.SupportUnavailable {
		return LeadSession{}, false
	}
	sess := LeadSession{Agent: agent, AgentName: adapter.Name(), Program: adapter.Executable(), Args: adapter.LastSessionArgs(),
		Folder: dir, Guessed: true}
	block := leadTerminal(ctx, name)
	if block == nil {
		return sess, true
	}
	if cwd := filepath.Clean(wavebase.ExpandHomeDirSafe(block.Meta.GetString(waveobj.MetaKey_CmdCwd, ""))); filepath.IsAbs(cwd) && pathInside(cwd, dir) {
		sess.Folder = cwd
	}
	if known := companion.KnownResumeSession(block.OID, agent); known.Sure {
		if id := companion.SessionIdFromPath(agent, known.Path); id != "" {
			if args, err := adapter.ResumeArgs(id); err == nil {
				sess.Args, sess.Guessed = args, false
			}
		}
	}
	return sess, true
}

// leadTerminal is the local terminal that last held the lead's first name (its block meta keeps it), nil when none
// does.
func leadTerminal(ctx context.Context, name string) *waveobj.Block {
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return nil
	}
	for _, block := range blocks {
		if block.Meta.GetString(molten.AgentFirstNameMetaKey, "") != name || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
			continue
		}
		if conncontroller.IsLocalConnName(block.Meta.GetString(waveobj.MetaKey_Connection, "")) {
			return block
		}
	}
	return nil
}

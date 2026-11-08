// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// Settling an agent's stop (#1876, FR-REV-022 AC20): an agent that stopped for a decision shows "waits for you" in the
// Integration panel until the decision is made. The lead (or the developer from a terminal) says it is made with
// `molten agent decision settle <ticket|agent> --note "..."`; a reply delivered to the agent says it too. The call
// works the same for every agent CLI: it names a ticket or a first name, nothing of the agent's own tooling.

const (
	errSettleSelf = "You cannot settle your own stop: the lead or the developer does."
)

// BranchTicket reads the ticket a branch names with the project's branch patterns; Mission Control sets it at its start
// (this package cannot import it). Nil: type/N-description, the default naming.
var BranchTicket func(dir string, branch string) int

// FolderBranch reads the branch checked out in a folder, from its files; replaced in tests.
var FolderBranch = companion.FolderBranch

var defaultBranchTicketRe = regexp.MustCompile(`^[A-Za-z0-9_.-]+/(\d+)(?:-|$)`)

func ticketOfBranch(dir string, branch string) int {
	if branch == "" {
		return 0
	}
	if BranchTicket != nil {
		return BranchTicket(dir, branch)
	}
	m := defaultBranchTicketRe.FindStringSubmatch(branch)
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0
	}
	return n
}

// settleTarget: a ticket number ("1872", "#1872"), else an agent's first name.
func settleTarget(raw string) (ticket int, name string) {
	target := strings.TrimSpace(cleanLine(raw))
	digits := strings.TrimPrefix(target, "#")
	if n, err := strconv.Atoi(digits); err == nil && n > 0 {
		return n, ""
	}
	return 0, target
}

// Settle says the stop of the agent(s) the target names is decided. Only a stop MoltenTerm holds can be settled: an
// agent blocked on a prompt of its own terminal is answered there.
func (m *Manager) Settle(ctx context.Context, req SettleRequest) (SettleResult, error) {
	senderId, senderLoc, err := m.sender(ctx, req.Token)
	if err != nil {
		return SettleResult{}, err
	}
	by := ""
	if run, ok := m.env.Run(senderId); ok && run.Running {
		by = run.FirstName
	}
	note := cleanLine(req.Note)
	ticket, name := settleTarget(req.Target)
	if ticket == 0 && name == "" {
		return SettleResult{}, errors.New("name a ticket number or an agent's first name to settle")
	}
	active := m.activeParties(ctx)
	rtn := SettleResult{Settled: []SettledEntry{}, By: by, Note: note}
	if ticket == 0 {
		target, ok := resolve(active, name)
		if !ok {
			return SettleResult{}, fmt.Errorf("No active agent is named %q: %s.", name, activeNames(active, senderId))
		}
		if target.blockId == senderId {
			return SettleResult{}, errors.New(errSettleSelf)
		}
		status := m.env.SettleStop(target.blockId, by, note)
		if err := settleRefusal(status, target.FirstName); err != nil {
			return SettleResult{}, err
		}
		rtn.Settled = append(rtn.Settled, settledEntry(target))
		m.logf("%s %s settled the stop of %s\n", logPrefix, byLabel(by), target.FirstName)
		return rtn, nil
	}
	var refusals []string
	for _, e := range active {
		if e.blockId == senderId || (senderLoc.ProjectDir != "" && e.ProjectDir != senderLoc.ProjectDir) {
			continue
		}
		if ticketOfBranch(e.ProjectDir, m.folderBranch(e.Folder)) != ticket {
			continue
		}
		switch status := m.env.SettleStop(e.blockId, by, note); status {
		case molten.AgentSettleDone:
			rtn.Settled = append(rtn.Settled, settledEntry(e))
			m.logf("%s %s settled the stop of %s on #%d\n", logPrefix, byLabel(by), e.FirstName, ticket)
		case molten.AgentSettleOwnPrompt:
			refusals = append(refusals, settleRefusal(status, e.FirstName).Error())
		}
	}
	if len(rtn.Settled) > 0 {
		return rtn, nil
	}
	if len(refusals) > 0 {
		return SettleResult{}, errors.New(strings.Join(refusals, " "))
	}
	return SettleResult{}, fmt.Errorf("No agent on #%d has a stop that waits for the developer: nothing to settle.", ticket)
}

func (m *Manager) folderBranch(folder string) string {
	if folder == "" {
		return ""
	}
	return FolderBranch(folder)
}

func settledEntry(e activeAgent) SettledEntry {
	return SettledEntry{FirstName: e.FirstName, Agent: e.Agent, AgentName: e.AgentName}
}

func byLabel(by string) string {
	if by == "" {
		return "the developer"
	}
	return by
}

func settleRefusal(status string, name string) error {
	switch status {
	case molten.AgentSettleDone:
		return nil
	case molten.AgentSettleOwnPrompt:
		return fmt.Errorf("%s is blocked on a prompt of its own terminal: answer it there, or send it your answer with molten agent send.", name)
	}
	return fmt.Errorf("%s has no stop that waits for the developer: nothing to settle.", name)
}

// settleByReply settles the stop of the agent a reply was just delivered to (#1876): the sender decided it. A receiver
// with no stop to settle is the usual case, and silent.
func (m *Manager) settleByReply(d *delivery) {
	if d.from.App || d.receipt || d.from.FirstName == "" {
		return
	}
	m.env.SettleStop(d.to.BlockId, d.from.FirstName, cleanLine(d.brief.Goal))
}

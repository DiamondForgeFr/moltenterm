// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// An MCP server's link to MoltenTerm dies when MoltenTerm restarts under a running agent (#1029, FR-BRW-008). The
// server reconnects by itself; when calls failed in the meantime, the agent may have told the developer that
// MoltenTerm does not answer, so the developer learns here that the link is back. One notification per pane: a later
// outage updates it.

const maxLinkNoticeName = 40

// LinkNotice tells the developer, on the pane of the verified token, that its agent's link came back.
func (m *Manager) LinkNotice(ctx context.Context, req LinkNoticeRequest) error {
	blockId, loc, err := m.sender(ctx, req.Token)
	if err != nil {
		return err
	}
	if req.Failed <= 0 {
		return nil
	}
	// Right after a restart MoltenTerm may not have seen the agent again yet: wait a little for its name, then take
	// the one it had before.
	run, hasRun := m.waitRun(blockId, true)
	p := m.party(blockId, run, hasRun, loc)
	if p.FirstName == "" {
		p.FirstName = cut(cleanLine(req.FirstName), maxLinkNoticeName)
	}
	m.logf("molten agent link: %s's %s server reconnected, %d calls failed meanwhile\n", p.callName(), req.Server, req.Failed)
	m.env.Notify(linkNoticeInput(p, req.Failed))
	return nil
}

func linkNoticeInput(p Party, failed int) molten.NotificationInput {
	input := molten.NotificationInput{
		Key:         LinkNoticeKeyPrefix + p.BlockId,
		Source:      NotificationSource,
		Kind:        "warning",
		WorkspaceId: p.WorkspaceId,
		TabId:       p.TabId,
		BlockId:     p.BlockId,
	}
	count := fmt.Sprintf("%d", failed)
	calls := count + " calls failed"
	one := failed == 1
	if one {
		calls = "1 call failed"
	}
	// The action opens the terminal's connections menu on the agent (FR-CONT-022, #1050), where the link's state and
	// its Reconnect are.
	gotoAction := func(label string, text *uimsg.Text) []molten.NotificationAction {
		return []molten.NotificationAction{{Id: "goto", Label: label, LabelText: text, Kind: "gesture", Gesture: LinksGesture,
			Args: map[string]any{"workspaceid": p.WorkspaceId, "tabid": p.TabId, "blockid": p.BlockId}}}
	}
	name := p.FirstName
	if name == "" {
		name = p.AgentName
	}
	if name == "" {
		input.Title = "An agent lost its link to MoltenTerm"
		input.TitleText = uimsg.Make("agentlink.restored.anontitle")
		input.Message = calls + " while MoltenTerm could not be reached. The link is back: ask the agent to try again."
		input.MessageText = uimsg.Make("agentlink.restored.anonmessageother", "count", count)
		if one {
			input.MessageText = uimsg.Make("agentlink.restored.anonmessageone")
		}
		input.Actions = gotoAction("See its connections", uimsg.Make("agentlink.restored.anonconnections"))
		return input
	}
	input.Title = capitalize(name) + " lost its link to MoltenTerm"
	input.TitleText = uimsg.Make("agentlink.restored.title", "name", capitalize(name))
	input.Message = fmt.Sprintf("%s while MoltenTerm could not be reached. The link is back: ask %s to try again.", calls, name)
	input.MessageText = uimsg.Make("agentlink.restored.messageother", "count", count, "name", name)
	if one {
		input.MessageText = uimsg.Make("agentlink.restored.messageone", "name", name)
	}
	input.Actions = gotoAction("See "+name+"'s connections", uimsg.Make("agentlink.restored.connections", "name", name))
	return input
}

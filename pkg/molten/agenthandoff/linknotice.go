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

// LinkNotice tells the developer, on the pane of the verified token, that its agent's link came back.
func (m *Manager) LinkNotice(ctx context.Context, req LinkNoticeRequest) error {
	blockId, loc, err := m.sender(ctx, req.Token)
	if err != nil {
		return err
	}
	if req.Failed <= 0 {
		return nil
	}
	run, hasRun := m.env.Run(blockId)
	p := m.party(blockId, run, hasRun, loc)
	m.logf("molten agent link: %s's %s server reconnected, %d calls failed meanwhile\n", p.callName(), req.Server, req.Failed)
	m.env.Notify(linkNoticeInput(p, req.Failed))
	return nil
}

func linkNoticeInput(p Party, failed int) molten.NotificationInput {
	name := p.callName()
	message := fmt.Sprintf("%d calls failed while MoltenTerm could not be reached. The link is back: ask %s to try again.", failed, name)
	messageText := uimsg.Make("agentlink.restored.messageother", "count", fmt.Sprintf("%d", failed), "name", name)
	if failed == 1 {
		message = fmt.Sprintf("1 call failed while MoltenTerm could not be reached. The link is back: ask %s to try again.", name)
		messageText = uimsg.Make("agentlink.restored.messageone", "name", name)
	}
	return molten.NotificationInput{
		Key:         LinkNoticeKeyPrefix + p.BlockId,
		Source:      NotificationSource,
		Title:       capitalize(fmt.Sprintf("%s lost its link to MoltenTerm", name)),
		TitleText:   uimsg.Make("agentlink.restored.title", "name", capitalize(name)),
		Message:     message,
		MessageText: messageText,
		Kind:        "warning",
		WorkspaceId: p.WorkspaceId,
		TabId:       p.TabId,
		BlockId:     p.BlockId,
		Actions: []molten.NotificationAction{{
			Id: "goto", Label: "Go to " + name, LabelText: uimsg.Make("agentlink.restored.goto", "name", name),
			Kind: "open", WorkspaceId: p.WorkspaceId, TabId: p.TabId, BlockId: p.BlockId,
		}},
	}
}

// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A request MoltenTerm itself writes to an agent (#1143): the developer's click in a window is its approval, so no
// pair approval is asked, and its text is MoltenTerm's own, never taken from a page or a file. It goes the handoffs'
// way: a brief in MoltenTerm's data folder, a short prompt typed when the receiver's prompt is idle, queued until then
// (#1092), whatever the agentic CLI. The receiver ends with one outcome line next to the brief, which tells MoltenTerm
// what became of the request.

const (
	// AppName is how a request MoltenTerm writes signs itself.
	AppName = "MoltenTerm"
	// OutcomeFileName: the receiver's one outcome line, next to the brief.
	OutcomeFileName = "outcome.txt"

	errAppNotStarted = "the agent handoffs are not started"
)

// AppRequest is a request MoltenTerm writes to the agent in ToBlockId.
type AppRequest struct {
	ToBlockId string
	Goal      string
	Context   string
}

// AppSent is where a request went: its delivery status (StatusDelivered, StatusTyped or StatusQueued), the receiver's
// first name, the brief and the outcome line's path.
type AppSent struct {
	Status      string
	To          string
	BriefPath   string
	OutcomePath string
}

var shared = struct {
	lock    sync.Mutex
	manager *Manager
}{}

func setShared(m *Manager) {
	shared.lock.Lock()
	defer shared.lock.Unlock()
	shared.manager = m
}

func sharedManager() *Manager {
	shared.lock.Lock()
	defer shared.lock.Unlock()
	return shared.manager
}

// SendFromApp sends MoltenTerm's own request through the running handoffs.
func SendFromApp(ctx context.Context, req AppRequest) (AppSent, error) {
	Start()
	m := sharedManager()
	if m == nil {
		return AppSent{}, errors.New(errAppNotStarted)
	}
	return m.SendFromApp(ctx, req)
}

// OutcomePathOf is the outcome line's path of a brief.
func OutcomePathOf(briefPath string) string {
	if briefPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(briefPath), OutcomeFileName)
}

// SendFromApp delivers MoltenTerm's request to a running local agent; a pane without one cannot take it.
func (m *Manager) SendFromApp(ctx context.Context, req AppRequest) (AppSent, error) {
	run, ok := m.env.Run(req.ToBlockId)
	if !ok || !run.Running {
		return AppSent{}, errors.New("no agent runs in that terminal")
	}
	loc, err := m.env.Locate(ctx, req.ToBlockId)
	if err != nil {
		return AppSent{}, fmt.Errorf("the agent's terminal could not be found")
	}
	if !loc.Local {
		return AppSent{}, errors.New(errRemote)
	}
	brief, err := cleanBrief(Brief{Goal: req.Goal, Context: req.Context}, loc.Folder)
	if err != nil {
		return AppSent{}, err
	}
	from := Party{FirstName: AppName, App: true}
	to := m.party(req.ToBlockId, run, true, loc)
	path, err := writeBrief(m.env.DataDir(), from, to, brief, m.now())
	if err != nil {
		return AppSent{}, fmt.Errorf("MoltenTerm could not write the brief: %v", err)
	}
	d := &delivery{from: from, to: to, line: promptLine(from, brief, path), briefPath: path, queuedAt: m.now()}
	res, err := m.deliver(ctx, d)
	if err != nil {
		return AppSent{}, err
	}
	m.logf("%s MoltenTerm to=%q %s: %s\n", logPrefix, to.callName(), res.Status, path)
	return AppSent{Status: res.Status, To: to.FirstName, BriefPath: path, OutcomePath: OutcomePathOf(path)}, nil
}

// renderAppBrief: MoltenTerm's request, its goal and context, and the outcome line that ends it.
func renderAppBrief(to Party, b Brief, now time.Time, outcomePath string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "# Request from %s to %s\n\n", AppName, to.callName())
	fmt.Fprintf(&sb, "- **From:** %s itself, on the developer's click\n", AppName)
	fmt.Fprintf(&sb, "- **To:** %s (you)\n", partyLine(to))
	fmt.Fprintf(&sb, "- **Sent:** %s\n", now.Format("2006-01-02 15:04"))
	sb.WriteString("\nMoltenTerm wrote this request itself when the developer clicked in its window; no other agent and no page wrote it. ")
	sb.WriteString("It lives in MoltenTerm's data folder, outside every project: do not copy it into a project.\n")
	sb.WriteString("\n## Goal\n\n")
	sb.WriteString(b.Goal)
	sb.WriteString("\n")
	if b.Context != "" {
		sb.WriteString("\n## Context\n\n")
		sb.WriteString(b.Context)
		sb.WriteString("\n")
	}
	sb.WriteString("\n## Then\n\n")
	fmt.Fprintf(&sb, "Last, write one line to %s: what you did. When you leave something for the developer (a question, "+
		"a decision, work to finish first), start the line with `needs you:` and say why in a few words, in the developer's "+
		"language. Then end your turn: MoltenTerm shows the developer that line and takes them to your terminal.\n", outcomePath)
	return sb.String()
}

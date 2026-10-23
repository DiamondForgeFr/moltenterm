// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

// A run refused from a terminal for untrusted commands (DS-MC-005, #1017) asks the developer: one notification per
// folder whose action opens the trust sheet in approve-only mode. The approval stays the developer's click in a window
// (TrustCommand is window-only); once given, the agents that were refused are told in their prompt to run again.

// must match frontend/moltenterm-shell/mission/trust-approval.tsx
const (
	TrustNotificationSource    = "trust"
	TrustNotificationKeyPrefix = "molten:trust:"
	TrustReviewGesture         = "trust:review"
	UntrustedCommand           = "moltenmissionuntrusted"
	trustAskTimeout            = 10 * time.Second
	// What MoltenTerm types in an agent's prompt starts with this, so the agent tells it from the developer's words.
	trustReceiptPrefix = "[MoltenTerm]"
)

// The command a refused terminal runs again, by the request it sent.
var trustRerunHints = map[string]string{
	CiRunCommand:   "molten ci run",
	DepSyncCommand: "molten project sync",
}

type trustAsk struct {
	// blocks: the terminals refused since the last grant, with the command each should run again ("" when unknown).
	blocks map[string]string
}

type TrustAsks struct {
	lock sync.Mutex
	asks map[string]*trustAsk

	notify  func(ctx context.Context, input molten.NotificationInput) error
	resolve func(ctx context.Context, key string) error
	// workspaceOf: the workspace linked to a project folder, "" when none.
	workspaceOf func(ctx context.Context, dir string) string
	// tell types a line into the prompt of the agent in blockId; false when it could not.
	tell func(ctx context.Context, blockId string, line string) bool
}

func MakeTrustAsks() *TrustAsks {
	return &TrustAsks{asks: map[string]*trustAsk{}}
}

func TrustNotificationKey(dir string) string {
	return TrustNotificationKeyPrefix + filepath.Clean(dir)
}

// record notes the refused terminal and returns every terminal refused for the folder since the last grant.
func (a *TrustAsks) record(dir string, blockId string, rerun string) []string {
	a.lock.Lock()
	defer a.lock.Unlock()
	ask := a.asks[dir]
	if ask == nil {
		ask = &trustAsk{blocks: map[string]string{}}
		a.asks[dir] = ask
	}
	if blockId != "" {
		ask.blocks[blockId] = rerun
	}
	blocks := make([]string, 0, len(ask.blocks))
	for b := range ask.blocks {
		blocks = append(blocks, b)
	}
	sort.Strings(blocks)
	return blocks
}

func (a *TrustAsks) take(dir string) map[string]string {
	a.lock.Lock()
	defer a.lock.Unlock()
	ask := a.asks[dir]
	delete(a.asks, dir)
	if ask == nil {
		return nil
	}
	return ask.blocks
}

// trustNotice is the one notification of a folder whose commands wait for the developer's approval.
func trustNotice(dir string, blocks []string, workspaceId string) molten.NotificationInput {
	project := filepath.Base(dir)
	args := map[string]any{"dir": dir}
	if len(blocks) > 0 {
		args["blockids"] = blocks
	}
	return molten.NotificationInput{
		Key:         TrustNotificationKey(dir),
		Source:      TrustNotificationSource,
		Kind:        "warning",
		Title:       fmt.Sprintf("%s's commands need your approval", project),
		TitleText:   uimsg.Make("notif.trust.title", "project", project),
		Message:     fmt.Sprintf("A run was refused: MoltenTerm runs the commands declared in %s only once you trusted them. Nothing ran.", dir),
		MessageText: uimsg.Make("notif.trust.message", "dir", dir),
		WorkspaceId: workspaceId,
		Actions: []molten.NotificationAction{{Id: "review", Label: "Review the commands", Kind: "gesture", Gesture: TrustReviewGesture,
			Args: args, LabelText: uimsg.Make("notif.trust.review")}},
	}
}

// Refused tells the developer that a run from a terminal waits for their approval of the folder's commands.
func (a *TrustAsks) Refused(dir string, blockId string, command string) {
	if a == nil || dir == "" {
		return
	}
	dir = filepath.Clean(dir)
	blocks := a.record(dir, blockId, trustRerunHints[command])
	if a.notify == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), trustAskTimeout)
	defer cancel()
	workspaceId := ""
	if a.workspaceOf != nil {
		workspaceId = a.workspaceOf(ctx, dir)
	}
	if err := a.notify(ctx, trustNotice(dir, blocks, workspaceId)); err != nil {
		log.Printf("molten: asking to trust %s: %v\n", dir, err)
	}
}

func trustReceipt(dir string, rerun string) string {
	if rerun == "" {
		return fmt.Sprintf("%s The developer trusted the commands of %s (%s): run the refused command again.", trustReceiptPrefix, filepath.Base(dir), dir)
	}
	return fmt.Sprintf("%s The developer trusted the commands of %s (%s): run `%s` again.", trustReceiptPrefix, filepath.Base(dir), dir, rerun)
}

// Granted closes the folder's question once the developer trusted its commands, and tells the refused agents.
func (a *TrustAsks) Granted(dir string) {
	if a == nil || dir == "" {
		return
	}
	dir = filepath.Clean(dir)
	blocks := a.take(dir)
	ctx, cancel := context.WithTimeout(context.Background(), trustAskTimeout)
	defer cancel()
	if a.resolve != nil {
		if err := a.resolve(ctx, TrustNotificationKey(dir)); err != nil {
			log.Printf("molten: closing the trust question of %s: %v\n", dir, err)
		}
	}
	if a.tell == nil {
		return
	}
	ids := make([]string, 0, len(blocks))
	for b := range blocks {
		ids = append(ids, b)
	}
	sort.Strings(ids)
	for _, blockId := range ids {
		if !a.tell(ctx, blockId, trustReceipt(dir, blocks[blockId])) {
			log.Printf("molten: the agent in %s could not be told that %s is trusted\n", blockId, dir)
		}
	}
}

// refusedDir reads the folder a request was refused for, when its answer says its commands are not trusted.
func refusedDir(command string, data any, answer any) string {
	var untrusted *UntrustedInfo
	switch v := answer.(type) {
	case CiRunResult:
		untrusted = v.Untrusted
	case RunResult:
		untrusted = v.Untrusted
	}
	if untrusted == nil {
		return ""
	}
	if _, ok := trustRerunHints[command]; !ok && command != RunCommand {
		return ""
	}
	return requestDir(data)
}

func requestDir(data any) string {
	var req struct {
		Dir string `json:"dir"`
	}
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return ""
	}
	return req.Dir
}

// Untrusted reads the folder's commands as a run would, and returns them when they are not trusted yet (nil when they
// are): what the approve-only sheet shows and the hash it trusts.
func (r *Runs) Untrusted(dir string) (*UntrustedInfo, error) {
	if err := checkDir(dir); err != nil {
		return nil, err
	}
	dir = filepath.Clean(dir)
	report := molten.ValidatePipeline(canonicalRunDir(dir))
	if !report.Valid {
		return nil, pipelineError(report)
	}
	commands := PipelineCommands(report.Pipeline)
	hash := CommandsHash(commands)
	if r.trust.IsTrusted(dir, hash) {
		return nil, nil
	}
	return &UntrustedInfo{Hash: hash, Commands: commands}, nil
}

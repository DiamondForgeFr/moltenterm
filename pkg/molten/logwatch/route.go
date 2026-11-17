// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package logwatch

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The card's gestures reach the watch through a leaf of wavesrv's router answering plain command names, for MoltenTerm's
// windows only (FR-BOSS-012 AC12): a terminal or an agent never asks, nor ignores, for the developer.

const (
	// RouteId and the commands must match frontend/moltenterm-shell/logwatch/logwatch-model.ts.
	RouteId     = "molten:logwatch"
	AskCommand  = "moltenlogwatchask"
	MuteCommand = "moltenlogwatchmute"

	gitTimeout   = 5 * time.Second
	storeTimeout = 10 * time.Second
)

func (w *Watcher) route() localroute.Route {
	return localroute.Route{
		Id:     RouteId,
		Policy: localroute.Policy{Default: localroute.AllowWindow},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			return w.handle(ctx, command, data)
		},
	}
}

func (w *Watcher) handle(ctx context.Context, command string, data any) (any, error) {
	if !w.env.Enabled() {
		return nil, ErrOff
	}
	switch command {
	case AskCommand:
		var req AskRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return w.Ask(ctx, req)
	case MuteCommand:
		var req MuteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, w.Mute(ctx, req)
	}
	return nil, fmt.Errorf("unknown log watch command %q", command)
}

// shouldStart: the watch starts only on an internal channel; a release candidate, a public release and a wavesrv that
// does not know its channel never read the log (FR-BOSS-012 AC1).
func shouldStart(channel string) bool {
	return buildchannel.InternalChannel(channel)
}

var moltenRepo = GithubRepoOf(wavebase.MoltentermRepoURL)

// repoCache remembers which project folders are MoltenTerm's repository, read once each from their origin.
var repoCache = struct {
	lock sync.Mutex
	seen map[string]bool
}{seen: map[string]bool{}}

func cachedRepo(dir string) (bool, bool) {
	repoCache.lock.Lock()
	defer repoCache.lock.Unlock()
	ours, ok := repoCache.seen[dir]
	return ours, ok
}

func cacheRepo(dir string, ours bool) {
	repoCache.lock.Lock()
	defer repoCache.lock.Unlock()
	repoCache.seen[dir] = ours
}

func liveIsMoltenTerm(ctx context.Context, dir string) bool {
	if ours, ok := cachedRepo(dir); ok {
		return ours
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "config", "--get", "remote.origin.url").Output()
	if ctx.Err() != nil {
		return false
	}
	ours := err == nil && moltenRepo != "" && GithubRepoOf(strings.TrimSpace(string(out))) == moltenRepo
	cacheRepo(dir, ours)
	return ours
}

// ownSession: the terminal is Brokk's own session, which never takes work on MoltenTerm's code.
func ownSession(ctx context.Context, blockId string) bool {
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	return err == nil && block != nil && molten.IsOwnSession(block.Meta)
}

func liveAgents(ctx context.Context) []Agent {
	var out []Agent
	for _, a := range agenthandoff.AppAgents(ctx) {
		if ownSession(ctx, a.BlockId) {
			continue
		}
		out = append(out, Agent{BlockId: a.BlockId, FirstName: a.FirstName, AgentName: a.AgentName, Workspace: a.WorkspaceName,
			WorkspaceId: a.WorkspaceId, Folder: a.Folder, ProjectDir: a.ProjectDir})
	}
	return out
}

func livePublish(ctx context.Context, input molten.NotificationInput) error {
	ctx, cancel := context.WithTimeout(ctx, storeTimeout)
	defer cancel()
	return attention.PublishNotification(ctx, input)
}

func liveEnv() Env {
	return Env{
		DataDir:      wavebase.GetWaveDataDir(),
		Home:         wavebase.GetHomeDir(),
		Location:     time.Local,
		Now:          time.Now,
		Enabled:      buildchannel.LogWatchEnabled,
		Publish:      livePublish,
		Agents:       liveAgents,
		Locks:        agenthandoff.NameLocks,
		IsMoltenTerm: liveIsMoltenTerm,
		Send:         agenthandoff.SendFromApp,
		Channel:      buildchannel.Current(),
		Version:      wavebase.WaveVersion,
		Logf:         log.Printf,
	}
}

var startOnce sync.Once

// Start runs the watch with Mission Control (mission.UseStarter): its route and its looks, on an internal channel only.
func Start() {
	startOnce.Do(func() {
		if !shouldStart(buildchannel.Current()) {
			return
		}
		w := MakeWatcher(liveEnv())
		if _, err := localroute.Register(wshutil.DefaultRouter, w.route()); err != nil {
			log.Printf("%s route not started: %v\n", ownMark, err)
			return
		}
		go func() {
			defer func() {
				panichandler.PanicHandler("molten:logwatch", recover())
			}()
			w.Run(context.Background(), LookEvery)
		}()
	})
}

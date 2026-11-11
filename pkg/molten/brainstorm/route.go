// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows reach the mode through a leaf of wavesrv's router answering plain command names, like Brokk's session
// (brokksession/live.go). Any wsh client can publish an event under any name, so molten:brainstorm only says the state
// changed: the views read it back from this route, which answers MoltenTerm's windows and Electron main only, and only
// on a channel that has brainstorms (FR-BOSS-010 AC1, the second lock behind the window's own gate).

const (
	// RouteId and the commands must match frontend/moltenterm-shell/brainstorm/brainstorm-store.ts.
	RouteId      = "molten:brainstorm"
	StateCommand = "moltenbrainstormstate"
	OpenCommand  = "moltenbrainstormopen"
	CloseCommand = "moltenbrainstormclose"
	TurnCommand  = "moltenbrainstormturn"
	Event        = "molten:brainstorm"

	stateDirName = "brainstorm"
)

// ErrNotOnThisChannel is the plain reason every command gets on a release candidate or a public release.
var ErrNotOnThisChannel = errors.New(buildchannel.BrainstormRefusal)

type eventSignal struct {
	Version int64 `json:"version"`
}

// BrainstormsDir is the folder the brainstorms go to: boss:brainstormsdir, ~ expanded, or ~/MoltenTerm/Brainstorms.
func BrainstormsDir(setting string, home string) string {
	value := strings.TrimSpace(setting)
	if value == "" {
		return filepath.Join(home, filepath.FromSlash(DefaultDirName))
	}
	if value == "~" {
		return home
	}
	if strings.HasPrefix(value, "~/") {
		return filepath.Join(home, value[2:])
	}
	if !filepath.IsAbs(value) {
		return filepath.Join(home, value)
	}
	return filepath.Clean(value)
}

func liveRoot() string {
	settings := wconfig.GetWatcher().GetFullConfig().Settings
	return BrainstormsDir(settings.BossBrainstormsDir, wavebase.GetHomeDir())
}

func livePublish(version int64) {
	wps.Broker.Publish(wps.WaveEvent{Event: Event, Data: eventSignal{Version: version}})
}

// route lets in the windows and Electron main only, and only where the channel has brainstorms.
func (s *Service) route(allowed func() bool) localroute.Route {
	return localroute.Route{
		Id:     RouteId,
		Policy: localroute.Policy{Default: localroute.AllowUi},
		Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
			if !allowed() {
				return nil, ErrNotOnThisChannel
			}
			return s.handle(command, data)
		},
	}
}

func (s *Service) handle(command string, data any) (any, error) {
	switch command {
	case StateCommand:
		return s.State(), nil
	case OpenCommand:
		var req OpenRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Open(req), nil
	case CloseCommand:
		return s.Close(), nil
	case TurnCommand:
		var req TurnRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Turn(req), nil
	}
	return nil, fmt.Errorf("unknown brainstorm command %q", command)
}

// Live is wavesrv's service: the folder the setting names and MoltenTerm's own data folder.
func Live() *Service {
	store := MakeStore(liveRoot, filepath.Join(wavebase.GetWaveDataDir(), stateDirName))
	return MakeService(store, time.Now, livePublish, log.Printf)
}

var startOnce sync.Once

// Start registers the route; wavesrv calls it once, with Mission Control's start. On a release channel the route still
// answers, with the refusal, so a window built for another channel gets a plain reason rather than no route.
func Start() {
	startOnce.Do(func() {
		if _, err := localroute.Register(wshutil.DefaultRouter, Live().route(buildchannel.BrainstormEnabled)); err != nil {
			log.Printf("[brainstorm] route not started: %v\n", err)
		}
	})
}

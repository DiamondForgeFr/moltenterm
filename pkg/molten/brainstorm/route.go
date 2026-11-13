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
	"github.com/wavetermdev/waveterm/pkg/molten/i18nlang"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/onboarding"
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
	// The folders (#2248).
	ListCommand   = "moltenbrainstormlist"
	FindCommand   = "moltenbrainstormfind"
	LoadCommand   = "moltenbrainstormload"
	NewCommand    = "moltenbrainstormnew"
	RenameCommand = "moltenbrainstormrename"
	DeleteCommand = "moltenbrainstormdelete"
	ForkCommand   = "moltenbrainstormfork"
	// The developer's changes to the graph (#2247).
	EditCommand = "moltenbrainstormedit"
	UndoCommand = "moltenbrainstormundo"
	ToldCommand = "moltenbrainstormtold"
	Event       = "molten:brainstorm"

	// BriefTitles: how many saved titles Brokk's brief lists.
	BriefTitles = 30

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
	case ListCommand:
		return s.List(), nil
	case FindCommand:
		var req FindRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Find(req), nil
	case LoadCommand:
		var req SlugRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Load(req), nil
	case NewCommand:
		return s.New(), nil
	case RenameCommand:
		var req RenameRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Rename(req), nil
	case DeleteCommand:
		var req DeleteRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Delete(req), nil
	case ForkCommand:
		var req ForkRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Fork(req), nil
	case EditCommand:
		var req EditRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Edit(req), nil
	case UndoCommand:
		var req UndoRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Undo(req), nil
	case ToldCommand:
		var req ToldRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.Told(req), nil
	case ProjectPreviewCommand:
		var req ProjectRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.ProjectPreview(req), nil
	case ProjectCreateCommand:
		var req ProjectRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.ProjectCreate(req), nil
	case ProjectLinkedCommand:
		var req LinkedRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return s.ProjectLinked(req), nil
	}
	return nil, fmt.Errorf("unknown brainstorm command %q", command)
}

func liveTrash(path string) (string, error) {
	return onboarding.MoveToTrash(wavebase.GetHomeDir(), path)
}

// liveLanguage is the interface's language as wavesrv resolves app:language (DS-I18N-006).
func liveLanguage() string {
	return i18nlang.Resolve(wconfig.GetWatcher().GetFullConfig().Settings.AppLanguage, i18nlang.SystemLocale(), nil)
}

// liveProjectsDir is the parent folder of the last project (boss:projectsdir), "" until the developer chose one.
func liveProjectsDir() string {
	return ProjectsDir(wconfig.GetWatcher().GetFullConfig().Settings.BossProjectsDir, wavebase.GetHomeDir())
}

// Live is wavesrv's service: the folder the setting names, MoltenTerm's own data folder, the system trash, Brokk's own
// folder for the resume brief, the interface's language and the projects' parent folder.
func Live() *Service {
	store := MakeStore(liveRoot, filepath.Join(wavebase.GetWaveDataDir(), stateDirName))
	store.UseTrash(liveTrash, func() bool { return onboarding.TrashAvailable(wavebase.GetHomeDir()) })
	svc := MakeService(store, time.Now, livePublish, log.Printf)
	svc.UseResumeDir(filepath.Join(wavebase.GetWaveDataDir(), BrokkFolderName))
	svc.UseLanguage(liveLanguage)
	svc.UseProjects(liveProjectsDir, execGit)
	return svc
}

// LiveTitles are the saved brainstorms' titles Brokk's brief lists, the titles alone (AC10b); none where the channel has
// no brainstorms.
func LiveTitles() []string {
	if !buildchannel.BrainstormEnabled() {
		return nil
	}
	return MakeStore(liveRoot, "").Titles(BriefTitles)
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

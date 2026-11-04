// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package learning

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The windows and `molten learn` reach the store through a leaf of wavesrv's router answering plain command names,
// like the materials and the bookmarks (nothing is declared in pkg/wshrpc). Windows and local terminals read, record
// and forget; changing a value and resetting a workflow are the developer's, from a window. A remote host reaches
// nothing (DS-LRN-002).

type routeLink struct {
	s *Store
}

func (l *routeLink) route() localroute.Route {
	return localroute.Route{
		Id: molten.LearningRoute,
		Policy: localroute.Policy{
			Default: localroute.AllowUi,
			Commands: map[string]string{
				molten.LearningListCommand:     localroute.AllowLocal,
				molten.LearningDefaultsCommand: localroute.AllowLocal,
				molten.LearningRecordCommand:   localroute.AllowLocal,
				molten.LearningForgetCommand:   localroute.AllowLocal,
			},
		},
		Handler: func(_ context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return l.handle(command, caller, data)
		},
	}
}

// recordedBy is who records, as the router proved it: never taken from the request.
func recordedBy(caller localroute.Caller) string {
	if caller.IsLocalTerminal {
		return molten.LearningByAgent
	}
	return molten.LearningByView
}

func (l *routeLink) handle(command string, caller localroute.Caller, data any) (any, error) {
	var req molten.LearningRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	switch command {
	case molten.LearningListCommand:
		if req.Workflow == "" {
			return l.s.ListAll(), nil
		}
		items, err := l.s.List(req.Workflow)
		if err != nil {
			return nil, err
		}
		return molten.LearningList{Workflows: []molten.LearningWorkflow{{Workflow: req.Workflow, Items: items}}}, nil
	case molten.LearningDefaultsCommand:
		return l.s.Defaults(req.Workflow)
	case molten.LearningRecordCommand:
		return l.s.Record(req.Workflow, req, recordedBy(caller))
	case molten.LearningForgetCommand:
		if err := l.s.Forget(req.Workflow, req.Id); err != nil {
			return nil, err
		}
		return molten.LearningRecorded{Cleared: true}, nil
	case molten.LearningEditCommand:
		return l.s.Edit(req.Workflow, req.Id, req.Value)
	case molten.LearningResetCommand:
		n, err := l.s.Reset(req.Workflow)
		if err != nil {
			return nil, err
		}
		return map[string]int{"forgotten": n}, nil
	}
	return nil, fmt.Errorf("unknown learning command %q", command)
}

func publishChanged(workflow string) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  molten.LearningEvent,
		Scopes: []string{workflow, molten.LearningAllScope},
		Data:   molten.LearningChanged{Workflow: workflow},
	})
}

// StoreRoot is <data dir>/molten/learning.
func StoreRoot() string {
	return filepath.Join(wavebase.GetWaveDataDir(), "molten", "learning")
}

var startOnce sync.Once

// StartRoute opens the store and registers the route; wavesrv calls it once.
func StartRoute() {
	startOnce.Do(start)
}

func start() {
	store := MakeStore(StoreRoot())
	store.SetOnChange(publishChanged)
	if _, err := localroute.Register(wshutil.DefaultRouter, (&routeLink{s: store}).route()); err != nil {
		log.Printf("molten: learning route not started: %v\n", err)
	}
}

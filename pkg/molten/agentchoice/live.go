// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentchoice

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	RouteId    = "molten:agentchoice"
	GetCommand = "moltenagentchoice"

	readTimeout = 5 * time.Second
)

// GetRequest asks the agent for a folder; Agent is the developer's pick for one run.
type GetRequest struct {
	Dir   string `json:"dir"`
	Agent string `json:"agent,omitempty"`
}

// Installed looks the agent's program up on the login shell's PATH, as the flows that start it do.
func Installed(id string) bool {
	adapter := agentcontinuity.Find(id)
	return adapter != nil && molten.LookPathIn(adapter.Executable(), molten.LoginPath()) != ""
}

func globalChoice() string {
	return wconfig.GetWatcher().GetFullConfig().Settings.MoltentermCodingAgent
}

func projectChoice(dir string) string {
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return ""
	}
	projects, _ := client.Meta[ProjectsMetaKey].(map[string]any)
	return ProjectChoiceIn(projects, dir)
}

// Live is wavesrv's resolver: the registry's order, the login PATH, the settings and the client meta.
func Live() Resolver {
	return Resolver{
		Order:     agentcontinuity.Default().Ids(),
		Installed: Installed,
		Global:    globalChoice,
		Project:   projectChoice,
	}
}

// Resolve is Live().Resolve.
func Resolve(dir string, run string) Choice {
	return Live().Resolve(dir, run)
}

var startOnce sync.Once

// Start registers the route the windows (the panels' options, the agent choice dialog) and local terminals (`molten
// release notes`) read the choice on.
func Start() {
	startOnce.Do(func() {
		route := localroute.Route{
			Id:     RouteId,
			Policy: localroute.Policy{Default: localroute.AllowLocal},
			Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
				return handle(command, data)
			},
		}
		if _, err := localroute.Register(wshutil.DefaultRouter, route); err != nil {
			log.Printf("[agentchoice] route not started: %v\n", err)
		}
	})
}

func handle(command string, data any) (any, error) {
	if command != GetCommand {
		return nil, fmt.Errorf("unknown agent choice command %q", command)
	}
	var req GetRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	return Resolve(req.Dir, req.Agent), nil
}

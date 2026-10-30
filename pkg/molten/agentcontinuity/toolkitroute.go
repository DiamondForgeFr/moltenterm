// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenttoolkit"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The route the agent window reads a session's toolkit on, when it opens (#1543): no poller.
const (
	ToolkitRouteId    = "molten:agenttoolkit"
	ToolkitGetCommand = "moltenagenttoolkit"
)

type ToolkitRequest struct {
	Agent string `json:"agent"`
	Cwd   string `json:"cwd,omitempty"`
}

var toolkitOnce sync.Once

// StartToolkitRoute registers the toolkit route on wavesrv's router.
func StartToolkitRoute() {
	toolkitOnce.Do(func() {
		route := localroute.Route{
			Id:     ToolkitRouteId,
			Policy: localroute.Policy{Default: localroute.AllowLocal},
			Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
				return handleToolkit(command, data)
			},
		}
		if _, err := localroute.Register(wshutil.DefaultRouter, route); err != nil {
			log.Printf("[agenttoolkit] route not started: %v\n", err)
		}
	})
}

func handleToolkit(command string, data any) (any, error) {
	if command != ToolkitGetCommand {
		return nil, fmt.Errorf("unknown agent toolkit command %q", command)
	}
	var req ToolkitRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return agenttoolkit.Toolkit{}, nil
	}
	return ReadToolkit(req.Agent, molten.AgentEnv{Home: home, Getenv: os.Getenv}, req.Cwd), nil
}

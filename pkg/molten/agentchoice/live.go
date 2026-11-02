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

// PathCacheTtl bounds how stale a PATH lookup may be: the choice is asked each time a panel's options or a companion
// opens, and an agent installed since shows within this time.
const PathCacheTtl = 10 * time.Second

// pathCache remembers which programs the login PATH holds. A lookup only stats the PATH's folders: no agent is run.
type pathCache struct {
	lock   sync.Mutex
	at     time.Time
	found  map[string]bool
	now    func() time.Time
	lookup func(exe string) bool
}

func (c *pathCache) has(exe string) bool {
	c.lock.Lock()
	defer c.lock.Unlock()
	now := c.now()
	if c.found == nil || now.Sub(c.at) > PathCacheTtl {
		c.found = map[string]bool{}
		c.at = now
	}
	if v, ok := c.found[exe]; ok {
		return v
	}
	v := c.lookup(exe)
	c.found[exe] = v
	return v
}

var livePathCache = &pathCache{
	now:    time.Now,
	lookup: func(exe string) bool { return molten.LookPathIn(exe, molten.LoginPath()) != "" },
}

// Roster lists the agents MoltenTerm knows: the adapters of the registry, then the planned ones that have none yet.
func Roster() []KnownAgent {
	var rtn []KnownAgent
	for _, a := range agentcontinuity.Default().Adapters() {
		rtn = append(rtn, KnownAgent{Id: a.Id(), Name: a.Name(), Executable: a.Executable()})
	}
	for _, p := range agentcontinuity.PlannedAgents {
		rtn = append(rtn, KnownAgent{Id: p.Id, Name: p.Name, Executable: p.Executable})
	}
	return rtn
}

// Installed looks the agent's program up on the login shell's PATH, as the flows that start it do.
func Installed(id string) bool {
	for _, k := range Roster() {
		if k.Id == id {
			return livePathCache.has(k.Executable)
		}
	}
	return false
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
		Roster:    Roster(),
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

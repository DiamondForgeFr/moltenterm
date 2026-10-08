// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	// The first build waits for wavesrv's startup to settle; the first window does not wait for it.
	firstBuildDelay = time.Second
	// Durable jobs reconnect at startup one after the other, this far apart.
	reconnectSpacing = 50 * time.Millisecond
	reconnectTimeout = 10 * time.Second
)

// The events after which the list may have changed. What raises none (a session no pane shows exiting, its output)
// is caught by the tick.
var watchedEvents = []string{
	wps.Event_BlockJobStatus,
	wps.Event_BlockClose,
	wps.Event_ConnChange,
	wps.Event_RouteUp,
	wps.Event_RouteDown,
	wps.Event_WorkspaceUpdate,
	wps.Event_WaveObjUpdate,
	molten.AgentStateEvent,
}

var objUpdateScopes = []string{waveobj.OType_Block + ":*", waveobj.OType_Tab + ":*", waveobj.OType_Workspace + ":*"}

var startOnce sync.Once

func publishSessions(data molten.DurableSessionsData) {
	wps.Broker.Publish(wps.WaveEvent{Event: molten.DurableSessionsEvent, Data: data})
}

// relevantEvent filters the events that cannot change the list: route events of other things than jobs, object
// updates of other objects than blocks, tabs and workspaces.
func relevantEvent(event *wps.WaveEvent) bool {
	switch event.Event {
	case wps.Event_RouteUp, wps.Event_RouteDown:
		for _, scope := range event.Scopes {
			if strings.HasPrefix(scope, wshutil.RoutePrefix_Job) {
				return true
			}
		}
		return false
	case wps.Event_WaveObjUpdate:
		for _, scope := range event.Scopes {
			if strings.HasPrefix(scope, waveobj.OType_Block+":") || strings.HasPrefix(scope, waveobj.OType_Tab+":") || strings.HasPrefix(scope, waveobj.OType_Workspace+":") {
				return true
			}
		}
		return false
	}
	return true
}

func watch(model *Model) {
	rpcClient := wshclient.GetBareRpcClient()
	for _, event := range watchedEvents {
		rpcClient.EventListener.On(event, func(e *wps.WaveEvent) {
			if relevantEvent(e) {
				model.Trigger()
			}
		})
		sub := wps.SubscriptionRequest{Event: event, AllScopes: true}
		if event == wps.Event_WaveObjUpdate {
			// The broker filters the other objects (layouts, windows, jobs) before they are sent.
			sub = wps.SubscriptionRequest{Event: event, Scopes: objUpdateScopes}
		}
		wshclient.EventSubCommand(rpcClient, sub, nil)
	}
}

// StartupReconnects picks the sessions to reconnect at startup: not connected, whose host is up (an SSH host
// reconnects its jobs itself when it comes up), and either in a pane MoltenTerm can reattach to or being ended (the
// reconnect ends it). A pane in the active tab of its workspace is left to its terminal, which mounts at once and
// reconnects with its own size.
func StartupReconnects(data molten.DurableSessionsData, hostUp func(connection string) bool, activeTab func(workspaceId string) string) []string {
	var rtn []string
	for _, s := range data.Sessions {
		if s.ConnState == molten.SessionConnConnected {
			continue
		}
		ending := s.Reason == molten.SessionReasonEnding
		if !ending && (!s.Shown || !s.CanShow || (s.TabId != "" && activeTab(s.WorkspaceId) == s.TabId)) {
			continue
		}
		if s.Connection != "" && !hostUp(s.Connection) {
			continue
		}
		rtn = append(rtn, s.Id)
	}
	return rtn
}

func activeTabs() func(workspaceId string) string {
	ctx, cancel := context.WithTimeout(context.Background(), reconnectTimeout)
	defer cancel()
	active := map[string]string{}
	// Only a window mounts its workspace's active tab.
	windows, _ := wstore.DBGetAllObjsByType[*waveobj.Window](ctx, waveobj.OType_Window)
	for _, win := range windows {
		ws, err := wstore.DBGet[*waveobj.Workspace](ctx, win.WorkspaceId)
		if err == nil && ws != nil {
			active[ws.OID] = ws.ActiveTabId
		}
	}
	return func(workspaceId string) string {
		return active[workspaceId]
	}
}

func hostUp(connection string) bool {
	up, err := conncontroller.IsConnected(connection)
	return err == nil && up
}

// reconnectAtStartup reconnects the durable jobs of tabs nobody opened yet, so their output keeps reaching MoltenTerm
// (it would otherwise wait in the job manager's buffer until the pane mounts) and their state is known.
func reconnectAtStartup(data molten.DurableSessionsData) {
	ids := StartupReconnects(data, hostUp, activeTabs())
	if len(ids) == 0 {
		return
	}
	ok := 0
	for i, id := range ids {
		if i > 0 {
			time.Sleep(reconnectSpacing)
		}
		ctx, cancel := context.WithTimeout(context.Background(), reconnectTimeout)
		err := jobcontroller.ReconnectJob(ctx, id, nil)
		cancel()
		if err != nil {
			log.Printf("molten: session %s not reconnected at startup: %v\n", molten.ShortSessionId(id), err)
			continue
		}
		ok++
	}
	log.Printf("molten: %d/%d durable sessions reconnected at startup\n", ok, len(ids))
}

func firstBuild(model *Model) {
	defer func() {
		panichandler.PanicHandler("molten:sessions:firstbuild", recover())
	}()
	time.Sleep(firstBuildDelay)
	started := time.Now()
	data, err := model.Rebuild()
	if err != nil {
		log.Printf("molten: sessions not built: %v\n", err)
		return
	}
	log.Printf("molten: %d durable sessions, first build in %dms\n", len(data.Sessions), time.Since(started).Milliseconds())
	reconnectAtStartup(data)
	model.Trigger()
}

// Start registers the route and the listeners (microseconds), then builds the list in the background; wavesrv calls it
// at startup, from Mission Control's start.
func Start() {
	startOnce.Do(func() {
		src := makeLiveSources()
		model := MakeModel(src.Build, publishSessions)
		link := &routeLink{output: make(chan []byte, routeQueueSize), model: model, actions: MakeActions(model, liveOps{}), localSource: localSourceOnLink}
		if _, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, molten.DurableSessionsRoute); err != nil {
			log.Printf("molten: sessions route not started: %v\n", err)
		}
		watch(model)
		go model.Run(context.Background())
		go firstBuild(model)
	})
}

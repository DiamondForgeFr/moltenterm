// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The panels reach the collector through a leaf of wavesrv's router answering plain command names, so Mission Control
// declares nothing in pkg/wshrpc, the package upstream changes most (the molten command does the same towards tabs).

const routeQueueSize = 64

type routeLink struct {
	collector *Collector
	runs      *Runs
	output    chan []byte
}

func (l *routeLink) GetPeerInfo() string {
	return RouteId
}

func (l *routeLink) RecvRpcMessage() ([]byte, bool) {
	msg, ok := <-l.output
	return msg, ok
}

func (l *routeLink) SendRpcMessage(msg []byte, ingressLinkId baseds.LinkId, debugStr string) bool {
	var req wshutil.RpcMessage
	if err := json.Unmarshal(msg, &req); err != nil {
		return true
	}
	if req.Command == "" || req.ReqId == "" {
		return true
	}
	go l.answer(req)
	return true
}

func (l *routeLink) answer(req wshutil.RpcMessage) {
	defer func() {
		panichandler.PanicHandler("molten:mission:route", recover())
	}()
	resp := wshutil.RpcMessage{ResId: req.ReqId}
	data, err := l.handle(req.Command, req.Source, req.Data)
	if err != nil {
		resp.Error = err.Error()
	} else {
		resp.Data = data
	}
	out, err := json.Marshal(resp)
	if err != nil {
		return
	}
	l.output <- out
}

type runIdRequest struct {
	Dir   string `json:"dir"`
	RunId string `json:"runid"`
	From  int64  `json:"from,omitempty"`
}

type trustRequest struct {
	Dir  string `json:"dir"`
	Hash string `json:"hash"`
}

// isWindowSource tells a request from a MoltenTerm window apart from one sent by a terminal: the router stamps the
// source of every link that has a route of its own (wsh in a shell), so a terminal cannot pass for a tab.
func isWindowSource(source string) bool {
	return strings.HasPrefix(source, wshutil.RoutePrefix_Tab)
}

func (l *routeLink) handleRun(command string, source string, data any) (any, error) {
	switch command {
	case RunCommand:
		var req RunRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return l.runs.Start(req)
	case RunsCommand:
		var req GetRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		return l.runs.List(req.Dir), nil
	case LogCommand, CancelCommand, CloseCommand:
		var req runIdRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		if err := checkDir(req.Dir); err != nil {
			return nil, err
		}
		if command == CancelCommand {
			return nil, l.runs.Cancel(req.Dir, req.RunId)
		}
		if command == CloseCommand {
			return nil, l.runs.Close(req.Dir, req.RunId)
		}
		return l.runs.ReadLog(req.Dir, req.RunId, req.From)
	case TrustCommand:
		if !isWindowSource(source) {
			return nil, fmt.Errorf("a project's commands can only be trusted from a MoltenTerm window")
		}
		var req trustRequest
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
		return nil, l.runs.GrantTrust(req.Dir, req.Hash)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func (l *routeLink) handle(command string, source string, data any) (any, error) {
	if command != GetCommand && command != RefreshCommand {
		return l.handleRun(command, source, data)
	}
	var req GetRequest
	if err := utilfn.ReUnmarshal(&req, data); err != nil {
		return nil, fmt.Errorf("reading the request: %w", err)
	}
	maxAge := time.Duration(req.MaxAgeSec) * time.Second
	if req.MaxAgeSec <= 0 {
		maxAge = DefaultMaxAgeSec * time.Second
	}
	switch command {
	case GetCommand:
		return l.collector.Get(req.Dir, maxAge, false)
	case RefreshCommand:
		return l.collector.Get(req.Dir, 0, true)
	}
	return nil, fmt.Errorf("unknown mission control command %q", command)
}

func registerRoute(collector *Collector, runs *Runs) error {
	link := &routeLink{collector: collector, runs: runs, output: make(chan []byte, routeQueueSize)}
	_, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId)
	return err
}

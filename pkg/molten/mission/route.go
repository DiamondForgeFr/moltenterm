// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"fmt"
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
	data, err := l.handle(req.Command, req.Data)
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

func (l *routeLink) handle(command string, data any) (any, error) {
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

func registerRoute(collector *Collector) error {
	link := &routeLink{collector: collector, output: make(chan []byte, routeQueueSize)}
	_, err := wshutil.DefaultRouter.RegisterTrustedLeaf(link, RouteId)
	return err
}

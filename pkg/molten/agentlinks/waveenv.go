// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlinks

import (
	"context"
	"errors"
	"log"
	"time"

	goproc "github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlinkwire"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const metaTimeout = 5 * time.Second

type waveEnv struct{}

// MakeWaveEnv is the Env of a running wavesrv.
func MakeWaveEnv() Env {
	return waveEnv{}
}

func (waveEnv) VerifyToken(token string) (string, error) {
	rpcCtx, err := wshutil.ValidateAndExtractRpcContextFromToken(token)
	if err != nil {
		return "", err
	}
	if rpcCtx == nil || rpcCtx.BlockId == "" || rpcCtx.IsRouter {
		return "", errors.New("the token is not a terminal's")
	}
	return rpcCtx.BlockId, nil
}

func (waveEnv) Run(blockId string) (molten.AgentRunInfo, bool) {
	return attention.AgentRun(blockId)
}

func (waveEnv) Runs() []molten.AgentRunInfo {
	return attention.AgentRuns()
}

func (waveEnv) Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	alive, err := goproc.PidExists(int32(pid))
	return err != nil || alive
}

func (waveEnv) Stops(blockId string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), metaTimeout)
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return nil
	}
	return block.Meta.GetStringList(agentlinkwire.StopsMetaKey)
}

func (waveEnv) SetStops(blockId string, keys []string) {
	ctx, cancel := context.WithTimeout(context.Background(), metaTimeout)
	defer cancel()
	var value any
	if len(keys) > 0 {
		list := make([]any, 0, len(keys))
		for _, key := range keys {
			list = append(list, key)
		}
		value = list
	}
	oref := waveobj.MakeORef(waveobj.OType_Block, blockId)
	if err := wstore.UpdateObjectMeta(ctx, oref, waveobj.MetaMapType{agentlinkwire.StopsMetaKey: value}, false); err != nil {
		log.Printf("%s keeping the stopped links of %s: %v\n", logPrefix, blockId, err)
	}
}

func (waveEnv) Publish(state agentlinkwire.BlockLinks) {
	wps.Broker.Publish(wps.WaveEvent{
		Event:  agentlinkwire.Event,
		Scopes: []string{waveobj.MakeORef(waveobj.OType_Block, state.BlockId).String()},
		Data:   state,
	})
}

func (waveEnv) Version() string {
	return wavebase.WaveVersion
}

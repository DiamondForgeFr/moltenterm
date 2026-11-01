// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// The route a window reads the compatibility matrix on (FR-AGC-001, DS-AGC-002): the interface asks it instead of
// keeping its own agent lists (FR-AGC-003). The matrix is static data: no poller, no event.
const (
	FeaturesRouteId    = "molten:agentfeatures"
	FeaturesGetCommand = "moltenagentfeatures"
)

var featuresOnce sync.Once

// StartFeaturesRoute registers the compatibility matrix route on wavesrv's router.
func StartFeaturesRoute() {
	featuresOnce.Do(func() {
		route := localroute.Route{
			Id:     FeaturesRouteId,
			Policy: localroute.Policy{Default: localroute.AllowLocal},
			Handler: func(ctx context.Context, command string, _ localroute.Caller, data any) (any, error) {
				return handleFeatures(command)
			},
		}
		if _, err := localroute.Register(wshutil.DefaultRouter, route); err != nil {
			log.Printf("[agentfeatures] route not started: %v\n", err)
		}
	})
}

func handleFeatures(command string) (any, error) {
	if command != FeaturesGetCommand {
		return nil, fmt.Errorf("unknown agent features command %q", command)
	}
	return Default().Matrix(), nil
}

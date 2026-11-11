// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package featuresintest is wavesrv's side of the Features in test page (FR-BOSS-011, #2254): the developer's switches
// live in the client's meta (buildchannel.NarrowingMetaKey), in this computer's database, and wavesrv reads them at each
// call, so a switch applies to the next request without a restart. The window writes them: the metaguard refuses a
// terminal's write to a molten:* key of the client.
package featuresintest

import (
	"context"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const readTimeout = 2 * time.Second

type clientReader func(ctx context.Context) (*waveobj.Client, error)

func readClient(ctx context.Context) (*waveobj.Client, error) {
	return wstore.DBGetSingleton[*waveobj.Client](ctx)
}

// narrowingFrom reads the switches through read. A client that cannot be read narrows nothing: the switches are the
// developer's preview, and what a build allows is decided by its channel before they are read, so this never opens
// anything the channel closed.
func narrowingFrom(read clientReader) buildchannel.Narrowing {
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	client, err := read(ctx)
	if err != nil || client == nil {
		return buildchannel.Narrowing{}
	}
	return buildchannel.ParseNarrowing(client.Meta[buildchannel.NarrowingMetaKey])
}

// Live reads the developer's switches from the client object.
func Live() buildchannel.Narrowing {
	return narrowingFrom(readClient)
}

// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package featuresintest

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/metaguard"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func clientWith(meta waveobj.MetaMapType) clientReader {
	return func(ctx context.Context) (*waveobj.Client, error) {
		return &waveobj.Client{Meta: meta}, nil
	}
}

func TestTheSwitchesAreReadFromTheClientsMeta(t *testing.T) {
	t.Parallel()
	got := narrowingFrom(clientWith(waveobj.MetaMapType{
		buildchannel.NarrowingMetaKey: map[string]any{"public": true, "off": []any{buildchannel.FeatureBrainstorm}},
	}))
	if !got.Public || !got.Closes(buildchannel.FeatureBrainstorm) {
		t.Errorf("read %+v, want the public version and the brainstorm off", got)
	}
	if none := narrowingFrom(clientWith(waveobj.MetaMapType{"molten:other": true})); none.Public || len(none.Off) != 0 {
		t.Errorf("a client with no switches narrows %+v", none)
	}
}

// A client that cannot be read narrows nothing: the channel's own answer stays.
func TestAnUnreadableClientNarrowsNothing(t *testing.T) {
	t.Parallel()
	failing := func(ctx context.Context) (*waveobj.Client, error) { return nil, errors.New("database is locked") }
	missing := func(ctx context.Context) (*waveobj.Client, error) { return nil, nil }
	for name, read := range map[string]clientReader{"an error": failing, "no client": missing} {
		if got := narrowingFrom(read); got.Public || len(got.Off) != 0 {
			t.Errorf("%s: narrowed %+v", name, got)
		}
	}
}

// FR-BOSS-011 AC7: only the window and wavesrv write the switches; an agent in a terminal cannot change what the
// developer previews.
func TestATerminalCannotWriteTheSwitches(t *testing.T) {
	t.Parallel()
	client := waveobj.MakeORef(waveobj.OType_Client, "client-1")
	meta := waveobj.MetaMapType{buildchannel.NarrowingMetaKey: map[string]any{"public": true}}
	terminal := metaguard.Caller{Local: true, BlockId: "terminal-1"}
	if err := metaguard.CheckWrite(terminal, client, meta); err == nil {
		t.Error("a terminal wrote the developer's switches")
	}
	if err := metaguard.CheckWrite(metaguard.Caller{}, client, meta); err == nil {
		t.Error("an unknown caller wrote the developer's switches")
	}
	if err := metaguard.CheckWrite(metaguard.Caller{Trusted: true}, client, meta); err != nil {
		t.Errorf("the window cannot write the developer's switches: %v", err)
	}
}

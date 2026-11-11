// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package buildchannel

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
)

// The features that ship gated to the build channel while they are tested (FR-BOSS-011, #2254) are declared once, in
// gated-features.json: the window imports the same file (frontend/moltenterm-shell/build/gated-features.ts). A gate
// names its feature with one of these constants, and TestEveryGateNamesARegistryFeature fails on any other.
const (
	FeatureBrainstorm = "brainstorm"
)

// NarrowingMetaKey is the key of the client's meta holding the developer's switches ({"public": bool, "off": [ids]}).
// The client object lives in this computer's database, so the state is never synced, and the metaguard refuses a
// terminal's write to a molten:* key of the client; must match frontend/moltenterm-shell/build/gated-features.ts.
const NarrowingMetaKey = "molten:featuresintest"

// Feature is one entry of the registry.
type Feature struct {
	Id             string   `json:"id"`
	LabelKey       string   `json:"labelkey"`
	DescriptionKey string   `json:"descriptionkey"`
	Channels       []string `json:"channels"`
	Ticket         int      `json:"ticket"`
}

//go:embed gated-features.json
var gatedFeaturesJSON []byte

var registry = mustParseRegistry(gatedFeaturesJSON)

func mustParseRegistry(data []byte) []Feature {
	var doc struct {
		Features []Feature `json:"features"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		panic(fmt.Sprintf("buildchannel: gated-features.json is not valid: %v", err))
	}
	return doc.Features
}

// Registry returns the gated features, in the order of the file.
func Registry() []Feature {
	return append([]Feature(nil), registry...)
}

// FeatureById finds a feature of the registry.
func FeatureById(id string) (Feature, bool) {
	for _, feature := range registry {
		if feature.Id == id {
			return feature, true
		}
	}
	return Feature{}, false
}

// FeatureAllowed: the feature is open on this gate channel. A feature that is not in the registry and a channel that is
// not known open nothing.
func FeatureAllowed(id string, channel string) bool {
	feature, ok := FeatureById(id)
	if !ok || !known(channel) {
		return false
	}
	for _, open := range feature.Channels {
		if open == channel {
			return true
		}
	}
	return false
}

// Narrowing is what the developer switched off on this computer: every gated feature (Public, "See the public
// version"), or the ones named in Off. It can only close.
type Narrowing struct {
	Public bool
	Off    []string
}

// Closes: the developer switched this feature off.
func (n Narrowing) Closes(id string) bool {
	if n.Public {
		return true
	}
	for _, off := range n.Off {
		if off == id {
			return true
		}
	}
	return false
}

// ParseNarrowing reads the client's meta value of NarrowingMetaKey. What is not understood narrows nothing; it must
// read like readNarrowing in gated-features.ts.
func ParseNarrowing(raw any) Narrowing {
	if raw == nil {
		return Narrowing{}
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return Narrowing{}
	}
	var stored struct {
		Public bool     `json:"public"`
		Off    []string `json:"off"`
	}
	// A field of the wrong type is skipped and the others are still read, as the window does.
	_ = json.Unmarshal(data, &stored)
	narrowing := Narrowing{Public: stored.Public}
	for _, id := range stored.Off {
		if id != "" {
			narrowing.Off = append(narrowing.Off, id)
		}
	}
	return narrowing
}

// FeatureOn is the whole rule, for a channel and a state: the channel decides first, and the developer's switches only
// remove from what it opens. Whatever the state, FeatureOn never holds where FeatureAllowed does not, so a switch can
// not open a feature on a channel that does not list it, and a state stored on a release candidate or a public release
// changes nothing.
func FeatureOn(id string, channel string, narrowing Narrowing) bool {
	return FeatureAllowed(id, channel) && !narrowing.Closes(id)
}

var narrowingReader struct {
	lock sync.Mutex
	read func() Narrowing
}

// UseNarrowing registers how wavesrv reads the developer's switches (pkg/molten/featuresintest); without it, nothing
// is narrowed.
func UseNarrowing(read func() Narrowing) {
	narrowingReader.lock.Lock()
	defer narrowingReader.lock.Unlock()
	narrowingReader.read = read
}

func readerNow() func() Narrowing {
	narrowingReader.lock.Lock()
	defer narrowingReader.lock.Unlock()
	return narrowingReader.read
}

func currentNarrowing() Narrowing {
	read := readerNow()
	if read == nil {
		return Narrowing{}
	}
	return read()
}

// FeatureEnabled reads the gate for the channel this wavesrv runs on and the developer's switches. wavesrv reads its
// channel once, at start, but the switches at each call: turning a feature off applies to the next request, without a
// restart. The switches are not read at all where the channel does not open the feature.
func FeatureEnabled(id string) bool {
	if !started.given || !FeatureAllowed(id, started.channel) {
		return false
	}
	return !currentNarrowing().Closes(id)
}

// StartAsForTest makes this wavesrv look as if Electron main started it on a gate channel, with the developer's
// switches given by narrowing, and returns what puts the earlier state back. Tests only
// (TestStartAsForTestIsOnlyCalledFromTests): a test that uses it is not parallel.
func StartAsForTest(channel string, narrowing Narrowing) func() {
	before := started
	beforeRead := readerNow()
	started.given, started.channel = true, channel
	UseNarrowing(func() Narrowing { return narrowing })
	return func() {
		started = before
		UseNarrowing(beforeRead)
	}
}

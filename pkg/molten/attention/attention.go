// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package attention records coding agents' calls for the user (FR-SHELL-003, DS-SHELL-004). It lives apart from
// package molten, which wsh imports, because it needs wavesrv's object store.
//
// Coding agents ask for the user through the terminal: the bell,
// OSC 9 (iTerm2's notification; Codex, Claude Code set to iterm2) and OSC 777 (`notify;title;body`). wavesrv sees
// the output of every terminal, including those of workspaces no window shows, so the signals are read here, as the
// output is stored, and recorded as notifications of the terminal's workspace in the client object's meta, where
// the notification center reads them (frontend/moltenterm-shell/notifications-model.ts).
package attention

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// An agent rings or notifies several times for one event: one entry per block and text within this window.
const AttentionDedup = 5 * time.Second

// An OSC payload longer than this is not a notification; the scanner drops it rather than grow without bound.
const maxOscLength = 4096

const BellTitle = "A terminal needs your attention"

type AttentionSignal struct {
	Title   string
	Message string
}

const (
	scanNormal = iota
	scanEsc
	scanOsc
	scanOscEsc
	scanOther
	scanOtherEsc
)

// One scanner per block: an escape sequence may be split across two output chunks.
type attentionScanner struct {
	state int
	osc   []byte
}

func (s *attentionScanner) feed(data []byte, emit func(AttentionSignal)) {
	for _, b := range data {
		switch s.state {
		case scanNormal:
			if b == 0x1b {
				s.state = scanEsc
			} else if b == 0x07 {
				emit(AttentionSignal{Title: BellTitle, Message: "Bell"})
			}
		case scanEsc:
			switch b {
			case ']':
				s.state = scanOsc
				s.osc = s.osc[:0]
			case 'P', '_', '^', 'X':
				// DCS, APC, PM and SOS strings end with ST or BEL; their BEL is no bell.
				s.state = scanOther
			default:
				s.state = scanNormal
			}
		case scanOsc:
			if b == 0x07 {
				s.finishOsc(emit)
			} else if b == 0x1b {
				s.state = scanOscEsc
			} else if len(s.osc) < maxOscLength {
				s.osc = append(s.osc, b)
			}
		case scanOscEsc:
			if b == '\\' {
				s.finishOsc(emit)
			} else {
				s.state = scanEsc
			}
		case scanOther:
			if b == 0x07 {
				s.state = scanNormal
			} else if b == 0x1b {
				s.state = scanOtherEsc
			}
		case scanOtherEsc:
			if b == '\\' {
				s.state = scanNormal
			} else {
				s.state = scanOther
			}
		}
	}
}

func (s *attentionScanner) finishOsc(emit func(AttentionSignal)) {
	s.state = scanNormal
	signal, ok := ParseAttentionOsc(string(s.osc))
	if ok {
		emit(signal)
	}
}

// ParseAttentionOsc reads an OSC payload ("9;text" or "777;notify;title;body").
func ParseAttentionOsc(payload string) (AttentionSignal, bool) {
	code, rest, found := strings.Cut(payload, ";")
	if !found {
		return AttentionSignal{}, false
	}
	switch code {
	case "9":
		text := strings.TrimSpace(rest)
		// OSC 9;4 is ConEmu's progress report, not a notification.
		if text == "" || strings.HasPrefix(text, "4;") {
			return AttentionSignal{}, false
		}
		return AttentionSignal{Title: text}, true
	case "777":
		parts := strings.Split(rest, ";")
		if parts[0] != "notify" || len(parts) < 2 {
			return AttentionSignal{}, false
		}
		title := strings.TrimSpace(parts[1])
		message := strings.TrimSpace(strings.Join(parts[2:], ";"))
		if title == "" && message == "" {
			return AttentionSignal{}, false
		}
		if title == "" {
			return AttentionSignal{Title: message}, true
		}
		return AttentionSignal{Title: title, Message: message}, true
	}
	return AttentionSignal{}, false
}

type attentionWatcher struct {
	lock     sync.Mutex
	scanners map[string]*attentionScanner
	lastSeen map[string]time.Time
	record   func(blockId string, signal AttentionSignal)
	now      func() time.Time
}

func makeAttentionWatcher(record func(string, AttentionSignal)) *attentionWatcher {
	return &attentionWatcher{
		scanners: make(map[string]*attentionScanner),
		lastSeen: make(map[string]time.Time),
		record:   record,
		now:      time.Now,
	}
}

func (w *attentionWatcher) scan(blockId string, data []byte) []AttentionSignal {
	w.lock.Lock()
	defer w.lock.Unlock()
	scanner := w.scanners[blockId]
	if scanner == nil {
		scanner = &attentionScanner{}
		w.scanners[blockId] = scanner
	}
	var signals []AttentionSignal
	scanner.feed(data, func(signal AttentionSignal) {
		key := blockId + "\x00" + signal.Title + "\x00" + signal.Message
		now := w.now()
		if last, ok := w.lastSeen[key]; ok && now.Sub(last) < AttentionDedup {
			return
		}
		w.lastSeen[key] = now
		signals = append(signals, signal)
	})
	return signals
}

func (w *attentionWatcher) handle(blockId string, data []byte) {
	for _, signal := range w.scan(blockId, data) {
		w.record(blockId, signal)
	}
}

var defaultAttentionWatcher = makeAttentionWatcher(func(blockId string, signal AttentionSignal) {
	go recordAttention(blockId, signal)
})

// ScanTerminalOutput is called with every chunk of terminal output wavesrv stores. It never blocks the output: the
// notification is written from its own goroutine.
func ScanTerminalOutput(blockId string, data []byte) {
	defaultAttentionWatcher.handle(blockId, data)
}

func makeNotificationId(now time.Time) string {
	return strconv.FormatInt(now.UnixMilli(), 36) + "-" + strconv.FormatInt(rand.Int63n(2176782336), 36)
}

func recordAttention(blockId string, signal AttentionSignal) {
	defer func() {
		panichandler.PanicHandler("molten:recordAttention", recover())
	}()
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	err := writeAttention(ctx, blockId, signal, time.Now())
	if err != nil {
		log.Printf("molten: recording attention for block %s: %v\n", blockId, err)
	}
}

func writeAttention(ctx context.Context, blockId string, signal AttentionSignal, now time.Time) error {
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		return fmt.Errorf("finding the tab: %w", err)
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return fmt.Errorf("finding the workspace: %w", err)
	}
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return fmt.Errorf("reading the client: %w", err)
	}
	input := molten.NotificationInput{
		Source:      "agent",
		Title:       signal.Title,
		Message:     signal.Message,
		Kind:        "warning",
		WorkspaceId: workspaceId,
		TabId:       tabId,
		BlockId:     blockId,
	}
	oref := waveobj.MakeORef(waveobj.OType_Client, client.OID)
	err = wstore.UpdateObjectMeta(ctx, oref, molten.NotificationPublishUpdate(client.Meta, input, now, makeNotificationId(now)), false)
	if err != nil {
		return err
	}
	publishObjectUpdate(ctx, oref)
	return nil
}

// The same update event as wcore.SendWaveObjUpdate, which this package cannot import (wcore depends on the block
// controller that calls ScanTerminalOutput).
func publishObjectUpdate(ctx context.Context, oref waveobj.ORef) {
	obj, err := wstore.DBGetORef(ctx, oref)
	if err != nil {
		log.Printf("molten: reading %s for its update event: %v\n", oref, err)
		return
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_WaveObjUpdate,
		Scopes: []string{oref.String()},
		Data: waveobj.WaveObjUpdate{
			UpdateType: waveobj.UpdateType_Update,
			OType:      obj.GetOType(),
			OID:        waveobj.GetOID(obj),
			Obj:        obj,
		},
	})
}

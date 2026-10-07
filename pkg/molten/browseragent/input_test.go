// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// inputPage plays the page's side of the input tools on top of a fakePage: what Molten.inspect says of the focused
// element, of a point and of a node, the boxes of nodes, and the input events the page received.
type inputPage struct {
	lock    sync.Mutex
	focused targetInfo
	atPoint targetInfo
	nodes   map[int64]targetInfo
	boxes   map[int64][]float64
	gone    map[int64]bool
	setOut  setFieldResult
	// emulated answers screenshots the way emain does for an emulated viewport: the CSS area the panel shows.
	emulated []float64
	// viewport is the size Emulation.setDeviceMetricsOverride set, which the layout metrics then report.
	viewport []int
	events   []inputEvent
	// onEvent runs for each input event, outside the lock: a page navigating on a click, a slow page.
	onEvent func(e inputEvent) error
}

type inputEvent struct {
	method string
	params map[string]any
}

func (e inputEvent) kind() string {
	if t, ok := e.params["type"].(string); ok {
		return t
	}
	return e.method
}

func makeInputWorld(t *testing.T) (*pageWorld, *inputPage) {
	t.Helper()
	w := makePageWorld(t)
	ip := &inputPage{
		nodes:  map[int64]targetInfo{},
		boxes:  map[int64][]float64{7: {90, 190, 110, 190, 110, 210, 90, 210}},
		gone:   map[int64]bool{},
		setOut: setFieldResult{Ok: true},
	}
	ip.nodes[7] = targetInfo{Found: true, Kind: "button", Label: "Sign in", SubmitControl: true}
	w.env.lock.Lock()
	pageCdp := w.env.cdpFn
	w.env.cdpFn = func(key TabKey, method string, params any) (json.RawMessage, error) {
		if out, handled, err := ip.cdp(method, params); handled {
			return out, err
		}
		return pageCdp(key, method, params)
	}
	w.env.lock.Unlock()
	return w, ip
}

func (ip *inputPage) cdp(method string, params any) (json.RawMessage, bool, error) {
	args, _ := params.(map[string]any)
	switch method {
	case "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setDeviceMetricsOverride":
		e := inputEvent{method: method, params: args}
		ip.lock.Lock()
		ip.events = append(ip.events, e)
		if method == "Emulation.setDeviceMetricsOverride" {
			ip.viewport = []int{args["width"].(int), args["height"].(int)}
		}
		hook := ip.onEvent
		ip.lock.Unlock()
		if hook != nil {
			if err := hook(e); err != nil {
				return nil, true, err
			}
		}
		return json.RawMessage(`{}`), true, nil
	case "DOM.scrollIntoViewIfNeeded":
		ip.lock.Lock()
		defer ip.lock.Unlock()
		if ip.gone[args["backendNodeId"].(int64)] {
			return nil, true, errors.New("node is detached")
		}
		return json.RawMessage(`{}`), true, nil
	case "DOM.getBoxModel":
		ip.lock.Lock()
		defer ip.lock.Unlock()
		quad, ok := ip.boxes[args["backendNodeId"].(int64)]
		if !ok {
			return nil, true, errors.New("could not compute box model")
		}
		out, _ := json.Marshal(map[string]any{"model": map[string]any{"content": quad}})
		return out, true, nil
	case opInspect:
		ip.lock.Lock()
		defer ip.lock.Unlock()
		var info targetInfo
		switch {
		case args["focused"] == true:
			info = ip.focused
		case args["backendnodeid"] != nil:
			info = ip.nodes[args["backendnodeid"].(int64)]
		default:
			info = ip.atPoint
		}
		out, _ := json.Marshal(info)
		return out, true, nil
	case "Page.getLayoutMetrics":
		ip.lock.Lock()
		defer ip.lock.Unlock()
		if ip.viewport == nil {
			return nil, false, nil
		}
		out, _ := json.Marshal(map[string]any{"cssLayoutViewport": map[string]any{"clientWidth": ip.viewport[0], "clientHeight": ip.viewport[1]}})
		return out, true, nil
	case opCapture:
		ip.lock.Lock()
		defer ip.lock.Unlock()
		if ip.emulated == nil || args["clip"] != nil {
			return nil, false, nil
		}
		out, _ := json.Marshal(map[string]any{"data": "AAAA", "mimetype": "image/jpeg", "width": int(ip.emulated[0]), "height": int(ip.emulated[1]),
			"csswidth": ip.emulated[0], "cssheight": ip.emulated[1]})
		return out, true, nil
	case opSetField:
		ip.lock.Lock()
		defer ip.lock.Unlock()
		ip.events = append(ip.events, inputEvent{method: method, params: args})
		out, _ := json.Marshal(ip.setOut)
		return out, true, nil
	}
	return nil, false, nil
}

func (ip *inputPage) set(fn func(ip *inputPage)) {
	ip.lock.Lock()
	defer ip.lock.Unlock()
	fn(ip)
}

func (ip *inputPage) sent() []inputEvent {
	ip.lock.Lock()
	defer ip.lock.Unlock()
	return append([]inputEvent(nil), ip.events...)
}

func (ip *inputPage) count(method string) int {
	n := 0
	for _, e := range ip.sent() {
		if e.method == method {
			n++
		}
	}
	return n
}

func (ip *inputPage) kinds() string {
	var parts []string
	for _, e := range ip.sent() {
		parts = append(parts, e.kind())
	}
	return strings.Join(parts, ",")
}

func (w *pageWorld) agentTab(t *testing.T) PanelAgentTab {
	t.Helper()
	for _, tab := range w.m.panelState(w.key.PanelId).Tabs {
		if tab.BrowserTabId == w.key.BrowserTabId {
			return tab
		}
	}
	t.Fatalf("the agent tab is not in the panel's state")
	return PanelAgentTab{}
}

func TestClicksReachThePageWithModifiersByPointAndRef(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) {
		ip.atPoint = targetInfo{Found: true, Kind: "link", Label: "Forgot\nyour \"password\"?", Link: true}
	})
	r := w.call(mcpbrowser.ToolComputer, w.args(`"action":"left_click","coordinate":[100,200],"modifiers":"cmd+shift"`))
	if r.IsError || text(r) != "Clicked (100, 200)." {
		t.Fatalf("left_click: %s", text(r))
	}
	if got := ip.kinds(); got != "mouseMoved,mousePressed,mouseReleased" {
		t.Fatalf("events = %s", got)
	}
	pressed := ip.sent()[1].params
	if pressed["button"] != "left" || pressed["clickCount"] != 1 || pressed["modifiers"] != modMeta|modShift || pressed["x"] != 100.0 {
		t.Fatalf("pressed = %v", pressed)
	}
	tab := w.agentTab(t)
	if tab.Action != `Clicked link "Forgot your password ?"` || tab.Cue == nil || tab.Cue.Kind != "click" || tab.Cue.X != 100 {
		t.Fatalf("the bar shows the action and its point: %q %+v", tab.Action, tab.Cue)
	}

	ref := refIn(t, text(w.call(mcpbrowser.ToolFind, w.args(`"query":"sign in button"`))), `button "Sign in"`)
	ip.set(func(ip *inputPage) { ip.events = nil })
	r = w.call(mcpbrowser.ToolComputer, w.args(fmt.Sprintf(`"action":"double_click","ref":%q`, ref)))
	if r.IsError || !strings.Contains(text(r), "Double-clicked the element "+ref+" at (100, 200)") {
		t.Fatalf("double_click by ref: %s", text(r))
	}
	if got := ip.kinds(); got != "mouseMoved,mousePressed,mouseReleased,mousePressed,mouseReleased" {
		t.Fatalf("events = %s", got)
	}
	if ip.sent()[3].params["clickCount"] != 2 {
		t.Fatalf("the second press counts 2: %v", ip.sent()[3].params)
	}
	if tab := w.agentTab(t); tab.Action != `Double-clicked button "Sign in"` || tab.Cue.Kind != "box" || tab.Cue.Width != 20 {
		t.Fatalf("a ref's cue outlines the element: %q %+v", tab.Action, tab.Cue)
	}

	ip.set(func(ip *inputPage) { ip.events = nil })
	w.call(mcpbrowser.ToolComputer, w.args(`"action":"right_click","coordinate":[5,5]`))
	w.call(mcpbrowser.ToolComputer, w.args(`"action":"triple_click","coordinate":[5,5]`))
	w.call(mcpbrowser.ToolComputer, w.args(`"action":"hover","coordinate":[50,60]`))
	sent := ip.sent()
	if sent[1].params["button"] != "right" || sent[1].params["buttons"] != buttonsRight || sent[8].params["clickCount"] != 3 {
		t.Fatalf("right and triple clicks: %v", sent)
	}
	if last := sent[len(sent)-1]; last.kind() != "mouseMoved" || last.params["x"] != 50.0 {
		t.Fatalf("hover only moves: %v", last)
	}
}

func TestInputValidationSendsNothing(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	cases := map[string]string{
		`"action":"left_click","coordinate":[1280,10]`:                   mcpbrowser.ErrCoordinateOutside,
		`"action":"left_click","coordinate":[-1,10]`:                     mcpbrowser.ErrCoordinateOutside,
		`"action":"left_click"`:                                          mcpbrowser.ErrTargetRequired,
		`"action":"left_click","coordinate":[1,1],"modifiers":"hyper"`:   mcpbrowser.ErrModifiers,
		`"action":"scroll","scroll_direction":"down","scroll_amount":11`: mcpbrowser.ErrScrollAmount,
		`"action":"scroll","scroll_direction":"down","scroll_amount":0`:  mcpbrowser.ErrScrollAmount,
		`"action":"scroll","scroll_direction":"sideways"`:                mcpbrowser.ErrScrollDirection,
		`"action":"scroll_to"`:                                           mcpbrowser.ErrRefRequired,
		`"action":"key","text":"Enter","repeat":101`:                     mcpbrowser.ErrRepeat,
		`"action":"key","text":"Enter","repeat":1.5`:                     mcpbrowser.ErrRepeat,
		`"action":"key","text":"Entr"`:                                   mcpbrowser.ErrUnknownKey,
		`"action":"key","text":"a b c d e f g h i j k","repeat":100`:     mcpbrowser.ErrTooManyKeys,
		`"action":"key"`:                                  mcpbrowser.ErrTextRequired,
		`"action":"type","text":""`:                       mcpbrowser.ErrTextRequired,
		`"action":"left_click_drag","coordinate":[10,10]`: mcpbrowser.ErrStartRequired,
		`"action":"left_click_drag","start_coordinate":[10,10],"coordinate":[10,900]`: mcpbrowser.ErrCoordinateOutside,
		`"action":"left_click","ref":"ref_999"`:                                       mcpbrowser.ErrRefUnknown,
	}
	for args, want := range cases {
		expectError(t, w.call(mcpbrowser.ToolComputer, w.args(args)), want)
	}
	long := strings.Repeat("x", maxTypedRunes+1)
	expectError(t, w.call(mcpbrowser.ToolComputer, w.args(fmt.Sprintf(`"action":"type","text":%q`, long))), mcpbrowser.ErrTextTooLong)
	if n := len(ip.sent()); n != 0 {
		t.Fatalf("a refused action sends nothing: %d events", n)
	}
}

func TestARefWhoseElementLeftThePage(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ref := refIn(t, text(w.call(mcpbrowser.ToolFind, w.args(`"query":"sign in button"`))), `button "Sign in"`)
	ip.set(func(ip *inputPage) { ip.gone[7] = true })
	expectError(t, w.call(mcpbrowser.ToolComputer, w.args(fmt.Sprintf(`"action":"left_click","ref":%q`, ref))), mcpbrowser.ErrElementGone)
	ip.set(func(ip *inputPage) {
		delete(ip.gone, 7)
		ip.boxes[7] = []float64{90, 2000, 110, 2000, 110, 2020, 90, 2020}
	})
	expectError(t, w.call(mcpbrowser.ToolComputer, w.args(fmt.Sprintf(`"action":"left_click","ref":%q`, ref))), mcpbrowser.ErrRefOutside)
}

func TestScrollScrollToKeyTypeAndDrag(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	r := w.call(mcpbrowser.ToolComputer, w.args(`"action":"scroll","scroll_direction":"down"`))
	wheel := ip.sent()[0].params
	if r.IsError || wheel["type"] != "mouseWheel" || wheel["deltaY"] != 300.0 || wheel["x"] != 640.0 || wheel["y"] != 400.0 {
		t.Fatalf("scroll: %s %v", text(r), wheel)
	}
	if w.agentTab(t).Action != "Scrolled down" {
		t.Fatalf("action %q", w.agentTab(t).Action)
	}
	ref := refIn(t, text(w.call(mcpbrowser.ToolFind, w.args(`"query":"sign in button"`))), `button "Sign in"`)
	if r := w.call(mcpbrowser.ToolComputer, w.args(fmt.Sprintf(`"action":"scroll_to","ref":%q`, ref))); r.IsError {
		t.Fatalf("scroll_to: %s", text(r))
	}
	if w.agentTab(t).Action != `Scrolled to button "Sign in"` {
		t.Fatalf("action %q", w.agentTab(t).Action)
	}

	ip.set(func(ip *inputPage) {
		ip.events = nil
		ip.focused = targetInfo{Found: true, Kind: "textbox", Label: "Search products", Editable: true, Rect: &rectValue{X: 1, Y: 2, Width: 30, Height: 10}}
	})
	text250 := strings.Repeat("é", 250)
	if r := w.call(mcpbrowser.ToolComputer, w.args(fmt.Sprintf(`"action":"type","text":%q`, text250))); r.IsError {
		t.Fatalf("type: %s", text(r))
	}
	if n := ip.count("Input.insertText"); n != 3 {
		t.Fatalf("250 characters go in 3 chunks: %d", n)
	}
	if tab := w.agentTab(t); tab.Action != `Typing in textbox "Search products"` || tab.Cue == nil || tab.Cue.Width != 30 {
		t.Fatalf("typing shows the field, never the text: %q %+v", tab.Action, tab.Cue)
	}

	ip.set(func(ip *inputPage) { ip.events = nil })
	if r := w.call(mcpbrowser.ToolComputer, w.args(`"action":"key","text":"ctrl+a Backspace","repeat":2`)); r.IsError || text(r) != "Pressed ctrl+a Backspace ×2." {
		t.Fatalf("key: %s", text(r))
	}
	sent := ip.sent()
	if len(sent) != 8 || sent[0].params["modifiers"] != modCtrl || sent[0].params["type"] != "rawKeyDown" || sent[1].params["type"] != "keyUp" {
		t.Fatalf("keys: %v", sent)
	}

	ip.set(func(ip *inputPage) { ip.events = nil })
	r = w.call(mcpbrowser.ToolComputer, w.args(`"action":"left_click_drag","start_coordinate":[10,10],"coordinate":[110,60]`))
	if r.IsError || ip.kinds() != "mouseMoved,mousePressed"+strings.Repeat(",mouseMoved", dragSteps)+",mouseReleased" {
		t.Fatalf("drag: %s %s", text(r), ip.kinds())
	}
	if held := ip.sent()[2].params; held["buttons"] != buttonsLeft || held["button"] != "left" {
		t.Fatalf("the button is held while moving: %v", held)
	}
}

func TestKeyParser(t *testing.T) {
	chords, ok := parseKeys("cmd+a Enter shift+Tab ctrl++ Space é A", true)
	if !ok || len(chords) != 7 {
		t.Fatalf("parse: %v %v", ok, chords)
	}
	if c := chords[0]; c.modifiers != modMeta || c.key != "a" || c.code != "KeyA" || c.text != "" || strings.Join(c.commands, ",") != "selectAll" || c.name != "cmd+a" {
		t.Fatalf("cmd+a: %+v", c)
	}
	if c := chords[1]; c.key != "Enter" || c.text != "\r" || c.producesText() || !c.isEnter() {
		t.Fatalf("Enter: %+v", c)
	}
	if c := chords[2]; c.modifiers != modShift || c.key != "Tab" || c.name != "shift+Tab" {
		t.Fatalf("shift+Tab: %+v", c)
	}
	if c := chords[3]; c.key != "+" || c.modifiers != modCtrl {
		t.Fatalf("ctrl++: %+v", c)
	}
	if c := chords[4]; c.key != " " || !c.isSpace() || c.text != " " || c.name != "Space" {
		t.Fatalf("Space: %+v", c)
	}
	if c := chords[5]; c.key != "é" || c.text != "é" || !c.producesText() {
		t.Fatalf("é: %+v", c)
	}
	if c := chords[6]; c.key != "A" || c.code != "KeyA" || c.text != "A" {
		t.Fatalf("A: %+v", c)
	}
	for _, bad := range []string{"", "Entr", "hyper+a", "ctrl+", "ab"} {
		if _, ok := parseKeys(bad, true); ok {
			t.Fatalf("%q should not parse", bad)
		}
	}
	for _, clipboard := range []string{"cmd+c", "cmd+v", "cmd+x", "cmd+shift+v"} {
		c, _ := parseChord(clipboard, true)
		if len(c.commands) != 0 {
			t.Fatalf("%s must never send a clipboard command: %v", clipboard, c.commands)
		}
	}
	if c, _ := parseChord("cmd+shift+z", true); strings.Join(c.commands, ",") != "redo" {
		t.Fatalf("redo: %v", c.commands)
	}
	if c, _ := parseChord("cmd+a", false); len(c.commands) != 0 {
		t.Fatalf("commands are for macOS only")
	}
	events := chords[1].keyEvents()
	if events[0]["type"] != "keyDown" || events[0]["text"] != "\r" || events[1]["type"] != "keyUp" {
		t.Fatalf("Enter events: %v", events)
	}
}

func TestSensitiveClassifier(t *testing.T) {
	enter, _ := parseChord("Enter", false)
	space, _ := parseChord("Space", false)
	letter, _ := parseChord("x", false)
	tab, _ := parseChord("Tab", false)
	shortcut, _ := parseChord("ctrl+a", false)
	password := targetInfo{Found: true, Kind: "textbox", Sensitive: true, Editable: true, FormSensitive: true}
	email := targetInfo{Found: true, Kind: "textbox", Editable: true, FormSensitive: true}
	plain := targetInfo{Found: true, Kind: "textbox", Editable: true}
	submit := targetInfo{Found: true, Kind: "button", SubmitControl: true, FormSensitive: true}
	searchButton := targetInfo{Found: true, Kind: "button", SubmitControl: true}
	file := targetInfo{Found: true, Kind: "file", FileInput: true}
	frame := targetInfo{Found: true, Kind: "frame", Frame: true}
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"type into a password", typeReason(password), reasonSensitiveField},
		{"type into a frame", typeReason(frame), reasonFrameField},
		{"type into what could not be inspected", typeReason(unknownTarget), reasonFrameField},
		{"type into an email field", typeReason(email), ""},
		{"click a sensitive form's submit", clickReason(submit, "left"), reasonSensitiveForm},
		{"click a search form's submit", clickReason(searchButton, "left"), ""},
		{"right-click a sensitive submit", clickReason(submit, "right"), ""},
		{"click a file input", clickReason(file, "left"), reasonFileChooser},
		{"click inside a frame", clickReason(frame, "left"), ""},
		{"a letter into a password", keyReason(password, letter), reasonSensitiveField},
		{"Enter in a sensitive form's field", keyReason(email, enter), reasonSensitiveForm},
		{"Enter in a plain field", keyReason(plain, enter), ""},
		{"Space on a sensitive submit", keyReason(submit, space), reasonSensitiveForm},
		{"Enter on a file input", keyReason(file, enter), reasonFileChooser},
		{"Tab out of a password", keyReason(password, tab), ""},
		{"a shortcut in a password", keyReason(password, shortcut), ""},
		{"Enter in a frame", keyReason(frame, enter), reasonFrameField},
	}
	for _, c := range cases {
		if c.got != c.want {
			t.Fatalf("%s: got %q, want %q", c.name, c.got, c.want)
		}
	}
	if keyNeedsInspection(tab) || !keyNeedsInspection(enter) || !keyNeedsInspection(letter) {
		t.Fatalf("only chords that can type or submit are inspected")
	}
	for _, reason := range []string{reasonSensitiveField, reasonSensitiveFill, reasonFrameField, reasonSensitiveForm, reasonFileChooser, reasonDownload} {
		if actionPromptText(reason) == actionPromptText("other") {
			t.Fatalf("%s has its own words", reason)
		}
	}
	if got := cleanLabel(strings.Repeat("a", 60)); len([]rune(got)) != maxLabelRunes {
		t.Fatalf("labels are cut: %q", got)
	}
}

// actionPrompt waits for a sensitive action request on the world's tab.
func (w *pageWorld) actionPrompt(t *testing.T) *PermissionPrompt {
	t.Helper()
	p := w.prompt(t)
	if p.Kind != PromptAction {
		t.Fatalf("expected an action request, got %+v", p)
	}
	return p
}

func TestTypingIntoAPasswordAsksEachTimeAndDenyTypesNothing(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) {
		ip.focused = targetInfo{Found: true, Kind: "textbox", Label: "Password", Sensitive: true, Editable: true}
	})
	pending := w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"type","text":"hunter2-PLANTED"`))
	p := w.actionPrompt(t)
	if p.Site != "example.com" || p.Action != "type into a password or payment field" {
		t.Fatalf("prompt %+v", p)
	}
	w.answer(t, p, DecisionDeny)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
	if n := ip.count("Input.insertText"); n != 0 {
		t.Fatalf("a denied action types nothing: %d", n)
	}

	pending = w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"type","text":"hunter2-PLANTED"`))
	p = w.actionPrompt(t)
	w.answer(t, p, DecisionAllow)
	if r := waitResult(t, pending); r.IsError {
		t.Fatalf("allowed: %s", text(r))
	}
	if n := ip.count("Input.insertText"); n != 1 {
		t.Fatalf("allowed typing: %d", n)
	}

	// Allow is never remembered.
	pending = w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"type","text":"again"`))
	w.answer(t, w.actionPrompt(t), DecisionDismiss)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
	if strings.Contains(w.sink.all(), "hunter2-PLANTED") || strings.Contains(w.agentTab(t).Action, "hunter2") {
		t.Fatalf("typed text never reaches the logs or the bar")
	}
	if !strings.Contains(w.sink.all(), "confirmation asked reason=sensitive-field site=example.com") {
		t.Fatalf("the log names the reason and the site: %s", w.sink.all())
	}
}

func TestSubmittingASensitiveFormAndOpeningAFileChooserAsk(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) {
		ip.atPoint = targetInfo{Found: true, Kind: "button", Label: "Sign in", SubmitControl: true, FormSensitive: true}
	})
	pending := w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"left_click","coordinate":[100,200]`))
	p := w.actionPrompt(t)
	if p.Action != "submit a form with a password or payment field" {
		t.Fatalf("prompt %+v", p)
	}
	if n := ip.count("Input.dispatchMouseEvent"); n != 0 {
		t.Fatalf("nothing is clicked before the answer: %d", n)
	}
	w.answer(t, p, DecisionAllow)
	if r := waitResult(t, pending); r.IsError {
		t.Fatalf("allowed submit: %s", text(r))
	}
	if ip.count("Input.dispatchMouseEvent") != 3 {
		t.Fatalf("the click happens after Allow: %s", ip.kinds())
	}

	ip.set(func(ip *inputPage) {
		ip.events = nil
		ip.atPoint = targetInfo{Found: true, Kind: "file", Label: "Attach", FileInput: true}
	})
	pending = w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"left_click","coordinate":[10,10]`))
	p = w.actionPrompt(t)
	if p.Action != "open a file chooser" {
		t.Fatalf("prompt %+v", p)
	}
	w.answer(t, p, DecisionDeny)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
	if len(ip.sent()) != 0 {
		t.Fatalf("a denied file chooser clicks nothing")
	}

	// Enter in the sign-in form's email field submits it: one question for the call.
	ip.set(func(ip *inputPage) {
		ip.focused = targetInfo{Found: true, Kind: "textbox", Editable: true, FormSensitive: true}
	})
	pending = w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"key","text":"Enter Enter"`))
	w.answer(t, w.actionPrompt(t), DecisionAllow)
	if r := waitResult(t, pending); r.IsError {
		t.Fatalf("allowed Enter: %s", text(r))
	}
	if n := ip.count("Input.dispatchKeyEvent"); n != 4 {
		t.Fatalf("both Enters went after one Allow: %d", n)
	}
}

func TestTypingIntoAFrameAsks(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://shop.example/checkout")
	ip.set(func(ip *inputPage) { ip.focused = targetInfo{Found: true, Kind: "frame", Frame: true} })
	pending := w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"type","text":"4242 4242 4242 4242"`))
	if p := w.actionPrompt(t); p.Action != actionPromptText(reasonFrameField) || p.Site != "shop.example" {
		t.Fatalf("prompt %+v", p)
	}
	w.answer(t, w.actionPrompt(t), DecisionDeny)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
}

func TestActionAnswersComeFromAWindowAndFitTheRequest(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) { ip.focused = targetInfo{Found: true, Sensitive: true} })
	pending := w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"type","text":"x"`))
	p := w.actionPrompt(t)
	if err := w.m.Answer("proc:a", AnswerRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, RequestId: p.RequestId, Decision: DecisionAllow}); err == nil {
		t.Fatalf("a terminal cannot allow an action")
	}
	for _, siteAnswer := range []string{DecisionOnce, DecisionAlways, DecisionBlock} {
		w.answer(t, p, siteAnswer)
	}
	if still := w.actionPrompt(t); still.RequestId != p.RequestId {
		t.Fatalf("site answers do not answer an action request")
	}
	if len(w.env.siteWrites) != 1 {
		t.Fatalf("an action answer never writes a site decision: %v", w.env.siteWrites)
	}
	w.answer(t, p, DecisionDeny)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
}

func TestACancelledOrStoppedCallAsksNothing(t *testing.T) {
	w, _ := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	s, _ := w.m.sessionFor(w.sid, "proc:a")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.m.askAction(ctx, s, w.tab, w.key, "example.com", reasonSensitiveField); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled call: %v", err)
	}
	w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Action: ControlStop})
	err := w.m.askAction(context.Background(), s, w.tab, w.key, "example.com", reasonSensitiveField)
	if text, _ := refusalText(err); text != mcpbrowser.ErrStopped {
		t.Fatalf("a stopped tab: %v", err)
	}
	if strings.Contains(w.sink.all(), "confirmation asked") || len(w.m.requests) != 0 {
		t.Fatalf("no request is made or logged")
	}
}

func TestAnUnansweredActionTimesOut(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.m.permissionTimeout = 150 * time.Millisecond
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) { ip.focused = targetInfo{Found: true, Sensitive: true} })
	expectError(t, w.call(mcpbrowser.ToolComputer, w.args(`"action":"type","text":"x"`)), mcpbrowser.ErrActionTimeout)
	if tab := w.agentTab(t); tab.Permission != nil {
		t.Fatalf("the bar goes with the timeout")
	}
}

func TestInputAsksTheSiteFirst(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.page.lock.Lock()
	w.page.goTo("https://unknown.example/")
	w.page.lock.Unlock()
	pending := w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"left_click","coordinate":[10,10]`))
	p := w.prompt(t)
	if p.Kind != PromptSite || p.Site != "unknown.example" {
		t.Fatalf("the site permission comes first: %+v", p)
	}
	if len(ip.sent()) != 0 {
		t.Fatalf("nothing reaches the page before the site is allowed")
	}
	w.answer(t, p, DecisionBlock)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrSiteBlocked)
	if len(ip.sent()) != 0 {
		t.Fatalf("a blocked site gets no input")
	}
}

func TestStopInterruptsTypingAndDragWithin200ms(t *testing.T) {
	for _, action := range []string{
		fmt.Sprintf(`"action":"type","text":%q`, strings.Repeat("a", 1000)),
		`"action":"left_click_drag","start_coordinate":[10,10],"coordinate":[500,500]`,
	} {
		w, ip := makeInputWorld(t)
		w.navigateAllowed(t, "https://example.com/login")
		// The first chunk or held move goes through; the next DevTools call hangs the way a slow page does, honouring the
		// call's context as the real Env does.
		block := make(chan struct{})
		started := make(chan struct{}, 1)
		ip.set(func(ip *inputPage) {
			ip.onEvent = func(e inputEvent) error {
				if e.method == "Input.insertText" || e.kind() == "mouseMoved" && e.params["buttons"] == buttonsLeft {
					w.env.lock.Lock()
					w.env.cdpBlock = block
					w.env.lock.Unlock()
					select {
					case started <- struct{}{}:
					default:
					}
				}
				return nil
			}
		})
		pending := w.callAsync(mcpbrowser.ToolComputer, w.args(action))
		<-started
		ip.set(func(ip *inputPage) { ip.onEvent = nil })
		time.Sleep(20 * time.Millisecond)
		stopAt := time.Now()
		if err := w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Action: ControlStop}); err != nil {
			t.Fatalf("stop: %v", err)
		}
		r := waitResult(t, pending)
		if elapsed := time.Since(stopAt); elapsed > 200*time.Millisecond {
			t.Fatalf("Stop took %v", elapsed)
		}
		close(block)
		expectError(t, r, mcpbrowser.ErrStopped)
		before := len(ip.sent())
		time.Sleep(30 * time.Millisecond)
		if after := len(ip.sent()); after != before || ip.count("Input.insertText") > 1 {
			t.Fatalf("nothing more is sent after Stop: %d → %d", before, after)
		}
	}
}

func TestAClickThatLeavesTheSiteSaysTheNextActionAsks(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) {
		ip.atPoint = targetInfo{Found: true, Kind: "link", Link: true}
		ip.onEvent = func(e inputEvent) error {
			if e.kind() == "mouseReleased" {
				w.page.lock.Lock()
				w.page.goTo("https://other.example/")
				w.page.lock.Unlock()
			}
			return nil
		}
	})
	r := w.call(mcpbrowser.ToolComputer, w.args(`"action":"left_click","coordinate":[10,10]`))
	if r.IsError || !strings.Contains(text(r), "The page moved to other.example") {
		t.Fatalf("the click happened and says the next action asks: %s", text(r))
	}
}

func TestFormInputSetsFieldsAndAsksForSensitiveOnes(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	out := text(w.call(mcpbrowser.ToolReadPage, w.args(`"filter":"interactive"`)))
	emailRef := refIn(t, out, `textbox "Email"`)
	passwordRef := refIn(t, out, `textbox "Password"`)
	ip.set(func(ip *inputPage) {
		ip.nodes[4] = targetInfo{Found: true, Kind: "textbox", Label: "Email", Editable: true}
		ip.nodes[5] = targetInfo{Found: true, Kind: "textbox", Label: "Password", Editable: true, Sensitive: true}
	})
	r := w.call(mcpbrowser.ToolFormInput, w.args(fmt.Sprintf(`"ref":%q,"value":"me@example.org"`, emailRef)))
	if r.IsError || !strings.Contains(text(r), "input and change events") {
		t.Fatalf("form_input: %s", text(r))
	}
	set := ip.sent()[0]
	if set.method != opSetField || set.params["value"] != "me@example.org" || set.params["backendnodeid"] != int64(4) {
		t.Fatalf("setField: %+v", set)
	}
	if strings.Contains(text(r), "me@example.org") || w.agentTab(t).Action != `Set textbox "Email"` {
		t.Fatalf("the value is not echoed: %s / %q", text(r), w.agentTab(t).Action)
	}
	if r := w.call(mcpbrowser.ToolFormInput, w.args(fmt.Sprintf(`"ref":%q,"value":true`, emailRef))); r.IsError {
		t.Fatalf("booleans pass: %s", text(r))
	}
	expectError(t, w.call(mcpbrowser.ToolFormInput, w.args(fmt.Sprintf(`"ref":%q,"value":{"a":1}`, emailRef))), mcpbrowser.ErrValueRequired)
	expectError(t, w.call(mcpbrowser.ToolFormInput, w.args(`"value":"x"`)), mcpbrowser.ErrRefRequired)

	pending := w.callAsync(mcpbrowser.ToolFormInput, w.args(fmt.Sprintf(`"ref":%q,"value":"PLANTED-PW"`, passwordRef)))
	p := w.actionPrompt(t)
	if p.Action != "fill in a password or payment field" {
		t.Fatalf("prompt %+v", p)
	}
	w.answer(t, p, DecisionDeny)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
	if ip.count(opSetField) != 2 {
		t.Fatalf("a denied fill sets nothing")
	}

	ip.set(func(ip *inputPage) { ip.nodes[4] = targetInfo{Found: true, Kind: "file", FileInput: true} })
	expectError(t, w.call(mcpbrowser.ToolFormInput, w.args(fmt.Sprintf(`"ref":%q,"value":"/etc/passwd"`, emailRef))), mcpbrowser.ErrFileInput)
	ip.set(func(ip *inputPage) {
		ip.nodes[4] = targetInfo{Found: true, Kind: "select"}
		ip.setOut = setFieldResult{Ok: false, Error: "option"}
	})
	expectError(t, w.call(mcpbrowser.ToolFormInput, w.args(fmt.Sprintf(`"ref":%q,"value":"Mars"`, emailRef))), mcpbrowser.ErrOptionNotFound)
}

func TestResizeShowsTheSizeUntilControlEnds(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	expectError(t, w.call(mcpbrowser.ToolResize, w.args(`"width":50,"height":844`)), mcpbrowser.ErrResizeBounds)
	expectError(t, w.call(mcpbrowser.ToolResize, w.args(`"width":390`)), mcpbrowser.ErrResizeBounds)
	r := w.call(mcpbrowser.ToolResize, w.args(`"width":390,"height":844`))
	if r.IsError {
		t.Fatalf("resize: %s", text(r))
	}
	params := ip.sent()[0].params
	if params["width"] != 390 || params["height"] != 844 || params["mobile"] != false {
		t.Fatalf("emulation: %v", params)
	}
	tab := w.agentTab(t)
	if tab.Viewport == nil || tab.Viewport.Width != 390 || tab.Action != "Resized the page to 390×844" {
		t.Fatalf("the bar shows the size: %+v %q", tab.Viewport, tab.Action)
	}
	// The panel shows the emulated page from its top-left corner, as far as it reaches: the screenshot says so, at the
	// right scale.
	ip.set(func(ip *inputPage) { ip.emulated = []float64{390, 274} })
	shot := w.call(mcpbrowser.ToolComputer, w.args(`"action":"screenshot"`))
	if !strings.Contains(shot.Content[0].Text, "the viewport is 390×844 CSS pixels, shown as a 390×274 image (1 CSS pixel = 1 image pixels)") ||
		!strings.Contains(shot.Content[0].Text, "top-left 390×274 CSS pixels") {
		t.Fatalf("emulated screenshot: %s", shot.Content[0].Text)
	}
	w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Action: ControlStop})
	if w.env.controlled(w.key) {
		t.Fatalf("Stop releases the tab, and emain clears the emulation with it")
	}
	if len(w.m.panelState(w.key.PanelId).Tabs) != 0 {
		t.Fatalf("no bar, no size after Stop")
	}
}

func TestBatchRunsInOrderAndStopsAtTheFirstError(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/login")
	ip.set(func(ip *inputPage) { ip.focused = targetInfo{Found: true, Kind: "textbox", Editable: true} })
	batch := fmt.Sprintf(`{"actions":[
		{"name":"computer","input":{"tabId":%d,"action":"left_click","coordinate":[10,10]}},
		{"name":"computer","input":{"tabId":%d,"action":"screenshot"}},
		{"name":"computer","input":{"tabId":%d,"action":"left_click","ref":"ref_999"}},
		{"name":"computer","input":{"tabId":%d,"action":"type","text":"never"}}]}`, w.tab, w.tab, w.tab, w.tab)
	r := w.call(mcpbrowser.ToolBatch, batch)
	if !r.IsError {
		t.Fatalf("the batch fails at its bad ref")
	}
	all := text(r)
	if !strings.Contains(all, "Item 1 (computer):\nClicked (10, 10).") || !strings.Contains(all, "Item 3 (computer) failed: "+mcpbrowser.ErrRefUnknown) {
		t.Fatalf("results so far: %s", all)
	}
	images := 0
	for _, c := range r.Content {
		if c.Type == mcpbrowser.ContentImage {
			images++
		}
	}
	if images != 1 || ip.count("Input.insertText") != 0 || strings.Contains(all, "Item 4") {
		t.Fatalf("the screenshot is kept and the item after the error never runs: %d images, %s", images, all)
	}
	expectError(t, w.call(mcpbrowser.ToolBatch, `{"actions":[]}`), mcpbrowser.ErrBatchActions)
	nested := w.call(mcpbrowser.ToolBatch, `{"actions":[{"name":"browser_batch","input":{"actions":[]}}]}`)
	if !nested.IsError || !strings.Contains(text(nested), mcpbrowser.ErrBatchNested) {
		t.Fatalf("nesting: %s", text(nested))
	}
	foreign := w.call(mcpbrowser.ToolBatch, `{"actions":[{"name":"computer","input":{"tabId":999,"action":"left_click","coordinate":[1,1]}}]}`)
	if !strings.Contains(text(foreign), mcpbrowser.ErrNotYourTab) {
		t.Fatalf("each item has its own scope: %s", text(foreign))
	}
}

func TestADownloadAsksAndItsDenyFailsTheClickThatStartedIt(t *testing.T) {
	w, ip := makeInputWorld(t)
	w.navigateAllowed(t, "https://example.com/files")
	if _, err := w.m.AskDownload(context.Background(), "proc:a", DownloadRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Host: "x"}); err == nil {
		t.Fatalf("only emain asks about downloads")
	}
	answers := make(chan DownloadAnswer, 1)
	ip.set(func(ip *inputPage) {
		ip.atPoint = targetInfo{Found: true, Kind: "link", Link: true}
		ip.onEvent = func(e inputEvent) error {
			if e.kind() == "mouseReleased" {
				go func() {
					a, _ := w.m.AskDownload(context.Background(), wshutil.ElectronRoute, DownloadRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Host: "Files.Example.com"})
					answers <- a
				}()
			}
			return nil
		}
	})
	pending := w.callAsync(mcpbrowser.ToolComputer, w.args(`"action":"left_click","coordinate":[10,10]`))
	p := w.actionPrompt(t)
	if p.Action != "start a download" || p.Site != "files.example.com" {
		t.Fatalf("prompt %+v", p)
	}
	w.answer(t, p, DecisionDeny)
	expectError(t, waitResult(t, pending), mcpbrowser.ErrActionDenied)
	if a := <-answers; a.Allow {
		t.Fatalf("emain hears the Deny")
	}
	w.m.Control(wshutil.ElectronRoute, ControlRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId, Action: ControlTakeOver})
	if a, _ := w.m.AskDownload(context.Background(), wshutil.ElectronRoute, DownloadRequest{BlockId: w.key.PanelId, BrowserTabId: w.key.BrowserTabId}); a.Allow {
		t.Fatalf("a tab the user took over gets no download through the agent's question")
	}
}

// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package termupdate

import (
	"context"
	"errors"
	"testing"
)

// FR-REV-004: the review session's command is typed once the new shell shows its first prompt, with Enter.
func TestStartAndTypeAtFirstPrompt(t *testing.T) {
	f := &fakeTerm{}
	u := MakeUpdater(f.env())
	started := false
	start := func(ctx context.Context) error {
		started = true
		f.prompts <- struct{}{}
		return nil
	}
	if err := u.StartAndType(context.Background(), "b1", start, "claude --permission-mode default\x1b[A"); err != nil {
		t.Fatalf("StartAndType: %v", err)
	}
	if !started || len(f.input) != 1 || f.input[0] != "claude --permission-mode default[A\r" {
		t.Fatalf("typed %q (started %v)", f.input, started)
	}
}

// Without a prompt (a question of the startup files), nothing is typed.
func TestStartAndTypeWithoutPrompt(t *testing.T) {
	f := &fakeTerm{}
	u := MakeUpdater(f.env())
	ctx, cancel := context.WithCancel(context.Background())
	start := func(ctx context.Context) error {
		cancel()
		return nil
	}
	if err := u.StartAndType(ctx, "b1", start, "claude"); !errors.Is(err, errNoPrompt) || len(f.input) != 0 {
		t.Fatalf("err %v, typed %q", err, f.input)
	}
	failing := func(ctx context.Context) error { return errors.New("no shell") }
	if err := u.StartAndType(context.Background(), "b1", failing, "claude"); err == nil || len(f.input) != 0 {
		t.Fatalf("a terminal that did not start: err %v, typed %q", err, f.input)
	}
}

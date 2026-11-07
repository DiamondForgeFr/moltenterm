// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wavebase

import (
	"errors"
	"strings"
	"testing"
)

func lookPathFinding(path string) func(string) (string, error) {
	return func(name string) (string, error) {
		if name != "node" {
			return "", errors.New("unexpected lookup " + name)
		}
		return path, nil
	}
}

func lookPathFindingNothing(string) (string, error) {
	return "", errors.New("not found")
}

// A dev run keeps running Node scripts with its Electron binary.
func TestNodeRunnerIsTheElectronBinaryWhenWavesrvHasIt(t *testing.T) {
	got, err := pickNodeRunner("/dev/electron", lookPathFinding("/usr/bin/node"))
	if err != nil || got != "/dev/electron" {
		t.Fatalf("got %q, %v; want the Electron binary", got, err)
	}
}

// A packaged app hands wavesrv no Electron binary (its runAsNode fuse is off): the Node.js of the PATH runs the script.
func TestNodeRunnerIsNodeOnThePathInAPackagedApp(t *testing.T) {
	got, err := pickNodeRunner("", lookPathFinding("/usr/local/bin/node"))
	if err != nil || got != "/usr/local/bin/node" {
		t.Fatalf("got %q, %v; want node from the PATH", got, err)
	}
}

func TestNodeRunnerSaysWhenNodeIsMissing(t *testing.T) {
	got, err := pickNodeRunner("", lookPathFindingNothing)
	if err == nil || got != "" {
		t.Fatalf("got %q, %v; want an error", got, err)
	}
	if !strings.Contains(err.Error(), "Node.js was not found on the PATH") {
		t.Fatalf("the error must say Node.js is missing, got %q", err.Error())
	}
}

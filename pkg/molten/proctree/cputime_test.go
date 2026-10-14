// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package proctree

import (
	"os"
	"runtime"
	"testing"
	"time"
)

func TestParseStatCpu(t *testing.T) {
	line := []byte("4242 (my (odd) name) S 4000 4242 4000 34816 4242 4194304 1 0 0 0 150 50 300 25 20 0 1 0 1500 1000 100\n")
	cpu, ok := parseStatCpu(line)
	if !ok {
		t.Fatal("not parsed")
	}
	if cpu.Self != 2*time.Second || cpu.Children != 3250*time.Millisecond {
		t.Errorf("parsed %+v, want 2s own and 3.25s of children", cpu)
	}
	if _, ok := parseStatCpu([]byte("7 (x) Z 1 7")); ok {
		t.Error("a short line parsed")
	}
}

func TestReadCpuUnsupported(t *testing.T) {
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		t.Skip("supported platform: TestReadCpu")
	}
	if _, ok := ReadCpu(int32(os.Getpid())); ok {
		t.Error("unsupported platform read")
	}
}

// The cost of one CPU read, per process of a sampled tree.
func BenchmarkReadCpu(b *testing.B) {
	self := int32(os.Getpid())
	for i := 0; i < b.N; i++ {
		if _, ok := ReadCpu(self); !ok {
			b.Skip("unsupported")
		}
	}
}

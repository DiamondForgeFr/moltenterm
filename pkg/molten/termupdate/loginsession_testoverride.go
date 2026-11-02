// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build moltentestoverride

package termupdate

import (
	"log"
	"os"
	"strconv"
)

// Test-only build (`-tags moltentestoverride`, never in a release or a gold): MOLTENTERM_TEST_LOGIN_START_MS stands
// for the console login time, so a test app sees its terminals as started before a login it never had (#1194): a
// logout cannot be scripted. Without the tag this file does not exist.
func init() {
	value := os.Getenv("MOLTENTERM_TEST_LOGIN_START_MS")
	if value == "" {
		return
	}
	ms, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return
	}
	log.Printf("molten: TEST BUILD, login start %d\n", ms)
	LoginStartMs = func() int64 { return ms }
}

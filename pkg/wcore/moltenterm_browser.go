// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Every web page opens in Moltenterm's browser panel (#132). Applied where every block is created, so an older wsh on
// a remote host or a blockdef from user config cannot bring back Wave's web view without tabs; the block definition
// the caller passed is never modified.
func blockDefInBrowser(blockDef *waveobj.BlockDef) *waveobj.BlockDef {
	if blockDef == nil {
		return blockDef
	}
	meta, changed := molten.BrowserBlockMeta(blockDef.Meta)
	if !changed {
		return blockDef
	}
	rtn := *blockDef
	rtn.Meta = meta
	return &rtn
}

// legacyWebBlocksInBrowser returns the blocks of Wave's web view, switched to the browser panel. The blocks passed are
// never modified.
func legacyWebBlocksInBrowser(blocks []*waveobj.Block) []*waveobj.Block {
	var rtn []*waveobj.Block
	for _, block := range blocks {
		if block == nil {
			continue
		}
		meta, changed := molten.BrowserBlockMeta(block.Meta)
		if !changed {
			continue
		}
		migrated := *block
		migrated.Meta = meta
		rtn = append(rtn, &migrated)
	}
	return rtn
}

// MigrateLegacyWebBlocks moves the saved blocks of Wave's web view to the browser panel, keeping their URL. Run once at
// startup, before any window loads them; idempotent, since a migrated block no longer matches.
func MigrateLegacyWebBlocks() error {
	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return fmt.Errorf("reading blocks: %w", err)
	}
	migrated := legacyWebBlocksInBrowser(blocks)
	for _, block := range migrated {
		err = wstore.DBUpdate(ctx, block)
		if err != nil {
			return fmt.Errorf("migrating web block %s: %w", block.OID, err)
		}
	}
	if len(migrated) > 0 {
		log.Printf("moved %d web block(s) to the browser panel\n", len(migrated))
	}
	return nil
}

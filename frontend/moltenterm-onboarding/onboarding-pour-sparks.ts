// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sparks after a pour (FR-ONB-007 AC-2, NFR-ONB-003): a few dozen particles on one canvas, drawn by
// requestAnimationFrame only while some are alive, never under reduced motion or while the document is hidden. Nothing
// here reads the layout: the canvas size comes from a ResizeObserver, positions are fractions of it.

type Spark = { x: number; y: number; vx: number; vy: number; life: number; decay: number; r: number };

const Gravity = 0.12;
const Drag = 0.99;
const MaxSparks = 400;

export class SparkField {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    sparks: Spark[] = [];
    frame: number = null;
    ratio = 1;
    enabled = true;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        if (!enabled) {
            this.stop();
        }
    }

    resize(width: number, height: number, ratio: number) {
        this.ratio = ratio || 1;
        this.canvas.width = Math.max(1, Math.round(width * this.ratio));
        this.canvas.height = Math.max(1, Math.round(height * this.ratio));
    }

    // A burst at (fx, fy), fractions of the canvas.
    burst(fx: number, fy: number, count: number) {
        if (!this.enabled || this.ctx == null || document.hidden) {
            return;
        }
        const x = fx * this.canvas.width;
        const y = fy * this.canvas.height;
        const room = Math.max(0, MaxSparks - this.sparks.length);
        for (let i = 0; i < Math.min(count, room); i++) {
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
            const speed = (2 + Math.random() * 5) * this.ratio;
            this.sparks.push({
                x,
                y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1,
                decay: 0.012 + Math.random() * 0.02,
                r: (0.8 + Math.random() * 1.6) * this.ratio,
            });
        }
        if (this.frame == null) {
            this.frame = requestAnimationFrame(this.step);
        }
    }

    step = () => {
        this.frame = null;
        const { ctx, canvas } = this;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!this.enabled || document.hidden) {
            this.sparks = [];
            return;
        }
        ctx.globalCompositeOperation = "lighter";
        for (const s of this.sparks) {
            s.vy += Gravity * this.ratio;
            s.vx *= Drag;
            s.x += s.vx;
            s.y += s.vy;
            s.life -= s.decay;
            const hue = 22 + s.life * 22;
            ctx.fillStyle = `hsla(${hue}, 100%, ${50 + s.life * 30}%, ${Math.max(s.life, 0)})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }
        this.sparks = this.sparks.filter((s) => s.life > 0 && s.y < canvas.height + 20);
        if (this.sparks.length > 0) {
            this.frame = requestAnimationFrame(this.step);
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    stop() {
        if (this.frame != null) {
            cancelAnimationFrame(this.frame);
            this.frame = null;
        }
        this.sparks = [];
        this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
}

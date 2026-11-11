// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's thought in 3D (FR-BOSS-010 AC4 to AC6, AC17 to AC19, DS-BOSS-008, #2246): a WebGL scene written directly with
// three.js, loaded on demand behind one import() (brainstorm-stage.tsx), never in the entry chunk.
//
// - The central idea is a sphere of molten metal drawn by a shader, with its glow; its title is HTML under it.
// - The other nodes are riveted metal plates in an HTML layer over the canvas, placed each frame by the camera's
//   projection: their text stays crisp, translated and readable by screen readers. Each node grows out of its parent.
// - A node is tied to its parent by the app's rope (tether-model.ts): a fat line of 2 px that sags a little, with an
//   anchor where it leaves the parent and a knot where it reaches the child, cut at the plates' edges on screen. A
//   cross-link is a thinner dashed rope.
// - Embers rise through the scene on the graphics card.
// - The camera eases toward the newest node while he speaks and pulls back to the whole graph after about 5 s of quiet;
//   the scene turns slowly. Under reduced motion nothing turns, the core and the embers stand still, a node fades in
//   and the camera changes view by a short cross-fade (brainstorm-scene-model.ts holds every loop's still state).
//
// The scene draws only while the stage is mounted and the page is visible (requestAnimationFrame stops in a hidden page),
// and dispose() frees the graphics context.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { BrainstormGraph, BrainstormNode, NodeKind } from "./brainstorm-graph-model";
import { MaxLinks, MaxNodes } from "./brainstorm-graph-model";
import {
    arrival,
    CameraFov,
    CameraGoal,
    cameraGoal,
    CoreRadius,
    corePulse,
    CrossLinkColor,
    easeShare,
    KindLooks,
    Loops,
    plateLook,
    ropeCurve,
    Ropes,
    SceneColors,
    turnRate,
    Vec3,
} from "./brainstorm-scene-model";

export type SceneHost = {
    canvas: HTMLCanvasElement;
    // The layer the plates and the core's title are placed in, over the canvas.
    plates: HTMLElement;
    // The kind's name as the plates show it, in the interface language.
    kindLabel: (kind: NodeKind) => string;
    // Under reduced motion a change of view is a short cross-fade of the stage instead of a flight.
    onCrossFade?: () => void;
};

type PlateEntry = {
    node: BrainstormNode;
    el: HTMLDivElement;
    kindEl: HTMLSpanElement;
    textEl: HTMLSpanElement;
    halfW: number;
    halfH: number;
    // When this view saw it come, 0 for a node that was there when the stage opened.
    bornAt: number;
};

const EmberCount = 140;
const RopeCapacity = MaxNodes * Ropes.segments;
const CrossCapacity = MaxLinks * Ropes.segments;
const TiltRad = 0.28;
const Hidden = "translate3d(-9999px, -9999px, 0)";

function discTexture(ring: boolean): THREE.CanvasTexture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
    if (ring) {
        ctx.fillStyle = SceneColors.soot;
        ctx.fill();
        ctx.lineWidth = 10;
        ctx.strokeStyle = SceneColors.white;
        ctx.stroke();
    } else {
        ctx.fillStyle = SceneColors.white;
        ctx.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function glowTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255, 196, 120, 0.85)");
    g.addColorStop(0.18, "rgba(255, 140, 40, 0.55)");
    g.addColorStop(0.45, "rgba(255, 90, 0, 0.16)");
    g.addColorStop(1, "rgba(255, 80, 0, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// The molten core: a crust of dark metal cracked by flowing heat, brighter where it faces away from the eye (the rim).
const CoreVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
void main() {
    vLocal = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
}
`;

const CoreFragment = /* glsl */ `
uniform float uTime;
uniform float uPulse;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;

float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * noise(p);
        p = p * 2.03 + vec3(1.7, 9.2, 3.1);
        a *= 0.5;
    }
    return v;
}

void main() {
    vec3 p = normalize(vLocal) * 2.4;
    float flow = fbm(p + vec3(0.0, uTime * 0.12, uTime * 0.05));
    float veins = fbm(p * 2.2 - vec3(uTime * 0.07, 0.0, 0.0) + flow * 1.8);
    float heat = smoothstep(0.32, 0.78, veins) * (0.75 + 0.25 * uPulse);
    vec3 crust = vec3(0.35, 0.12, 0.04);
    vec3 ember = vec3(0.91, 0.38, 0.10);
    vec3 hot = vec3(1.0, 0.69, 0.29);
    vec3 white = vec3(1.0, 0.95, 0.84);
    vec3 col = mix(crust, ember, smoothstep(0.0, 0.45, heat));
    col = mix(col, hot, smoothstep(0.45, 0.8, heat));
    col = mix(col, white, smoothstep(0.82, 1.0, heat));
    float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.2);
    col += vec3(1.0, 0.55, 0.15) * rim * (0.55 + 0.45 * uPulse);
    gl_FragColor = vec4(col, 1.0);
}
`;

// Embers rise from under the graph, sway, glow and go out; their rise is the clock's on the graphics card.
const EmberVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uRise;
uniform float uHeight;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
    float t = fract(uRise + aSeed.z);
    vec3 p = position;
    p.y += t * uHeight;
    p.x += sin(t * 6.2831 * 1.5 + aSeed.x) * 14.0;
    p.z += cos(t * 6.2831 + aSeed.y) * 10.0;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vAlpha = sin(t * 3.14159) * (0.55 + 0.45 * sin(aSeed.x * 7.0 + t * 40.0));
    gl_PointSize = aSeed.w * uPixelRatio * clamp(600.0 / -mv.z, 0.6, 2.2);
    gl_Position = projectionMatrix * mv;
}
`;

const EmberFragment = /* glsl */ `
varying float vAlpha;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    float a = smoothstep(0.5, 0.0, r) * vAlpha;
    gl_FragColor = vec4(1.0, 0.55 + 0.25 * (1.0 - r * 2.0), 0.18, a);
}
`;

function makeLineMaterial(color: THREE.Color | string, width: number, vertexColors: boolean): LineMaterial {
    return new LineMaterial({
        color: new THREE.Color(color as any).getHex(),
        linewidth: width,
        worldUnits: false,
        vertexColors,
        transparent: true,
        depthWrite: false,
    });
}

function makeSegments(material: LineMaterial, capacity: number, colors: boolean): LineSegments2 {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(capacity * 6));
    if (colors) {
        geometry.setColors(new Float32Array(capacity * 6));
    }
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mesh = new LineSegments2(geometry, material);
    mesh.frustumCulled = false;
    return mesh;
}

function positionsOf(mesh: LineSegments2): Float32Array {
    return (mesh.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.array as Float32Array;
}

function colorsOf(mesh: LineSegments2): Float32Array {
    return (mesh.geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data.array as Float32Array;
}

function markSegments(mesh: LineSegments2, count: number, colors: boolean): void {
    const geometry = mesh.geometry;
    geometry.instanceCount = count;
    (geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    if (colors) {
        (geometry.attributes.instanceColorStart as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    }
}

export class BrainstormScene {
    host: SceneHost;
    renderer: THREE.WebGLRenderer;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(CameraFov, 1, 1, 20000);
    graph: BrainstormGraph = null;
    plates = new Map<string, PlateEntry>();
    coreTitle: HTMLDivElement;
    core: THREE.Mesh;
    coreMaterial: THREE.ShaderMaterial;
    coreGlow: THREE.Sprite;
    ropes: LineSegments2;
    outlines: LineSegments2;
    crossLinks: LineSegments2;
    anchors: THREE.Points;
    knots: THREE.Points;
    embers: THREE.Points;
    emberMaterial: THREE.ShaderMaterial;
    textures: THREE.Texture[] = [];
    width = 1;
    height = 1;
    // The left edge of the free space, right of Brokk's group, in the stage's pixels: the graph is centred in what is
    // left of the stage.
    freeLeft = 0;
    shownFreeLeft = 0;
    still = false;
    // When he last spoke or the graph last grew: the camera follows until OverviewAfterMs after it.
    talkAt = 0;
    target = new THREE.Vector3();
    distance = 900;
    azimuth = 0.5;
    mode: CameraGoal["mode"] = "overview";
    lastFrame = 0;
    lastNewest = "";
    frame = 0;
    raf = 0;
    disposed = false;
    tmp = new THREE.Vector3();

    constructor(host: SceneHost) {
        this.host = host;
        // Throws without WebGL: the stage then shows nothing rather than an error (the flat view is #2247's).
        this.renderer = new THREE.WebGLRenderer({
            canvas: host.canvas,
            alpha: true,
            antialias: true,
            powerPreference: "high-performance",
        });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.build();
    }

    private build(): void {
        const glow = glowTexture();
        const disc = discTexture(false);
        const ring = discTexture(true);
        this.textures.push(glow, disc, ring);

        this.coreMaterial = new THREE.ShaderMaterial({
            vertexShader: CoreVertex,
            fragmentShader: CoreFragment,
            uniforms: { uTime: { value: 0 }, uPulse: { value: 1 } },
        });
        this.core = new THREE.Mesh(new THREE.SphereGeometry(CoreRadius, 64, 48), this.coreMaterial);
        this.core.visible = false;
        this.scene.add(this.core);
        this.coreGlow = new THREE.Sprite(
            new THREE.SpriteMaterial({
                map: glow,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                transparent: true,
            })
        );
        this.coreGlow.visible = false;
        this.scene.add(this.coreGlow);

        this.outlines = makeSegments(makeLineMaterial(SceneColors.soot, Ropes.outline, false), RopeCapacity, false);
        this.outlines.renderOrder = 1;
        this.ropes = makeSegments(makeLineMaterial(SceneColors.white, Ropes.rope, true), RopeCapacity, true);
        this.ropes.renderOrder = 2;
        const crossMaterial = makeLineMaterial(CrossLinkColor, Ropes.cross, false);
        crossMaterial.dashed = true;
        crossMaterial.dashSize = Ropes.dash * 2;
        crossMaterial.gapSize = Ropes.gap * 2;
        crossMaterial.opacity = 0.7;
        this.crossLinks = makeSegments(crossMaterial, CrossCapacity, false);
        this.crossLinks.renderOrder = 2;
        this.scene.add(this.outlines, this.ropes, this.crossLinks);

        this.anchors = this.makeMarks(disc, Ropes.anchor);
        this.knots = this.makeMarks(ring, Ropes.knot + 2);
        this.scene.add(this.anchors, this.knots);

        this.embers = this.makeEmbers();
        this.scene.add(this.embers);

        this.coreTitle = document.createElement("div");
        this.coreTitle.className = "mt-bs-core-title";
        this.coreTitle.style.transform = Hidden;
        this.host.plates.appendChild(this.coreTitle);
    }

    private makeMarks(map: THREE.Texture, sizePx: number): THREE.Points {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MaxNodes * 3), 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MaxNodes * 3), 3));
        geometry.setDrawRange(0, 0);
        const points = new THREE.Points(
            geometry,
            new THREE.PointsMaterial({
                size: sizePx,
                sizeAttenuation: false,
                map,
                vertexColors: true,
                transparent: true,
                alphaTest: 0.05,
                depthWrite: false,
            })
        );
        points.frustumCulled = false;
        points.renderOrder = 3;
        return points;
    }

    private makeEmbers(): THREE.Points {
        const positions = new Float32Array(EmberCount * 3);
        const seeds = new Float32Array(EmberCount * 4);
        let s = 7;
        const rand = () => {
            s = (s * 16807) % 2147483647;
            return (s - 1) / 2147483646;
        };
        for (let i = 0; i < EmberCount; i++) {
            positions[i * 3] = (rand() - 0.5) * 1600;
            positions[i * 3 + 1] = -420 - rand() * 120;
            positions[i * 3 + 2] = (rand() - 0.5) * 1100;
            seeds[i * 4] = rand() * 6.28;
            seeds[i * 4 + 1] = rand() * 6.28;
            seeds[i * 4 + 2] = rand();
            seeds[i * 4 + 3] = 2 + rand() * 3;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
        this.emberMaterial = new THREE.ShaderMaterial({
            vertexShader: EmberVertex,
            fragmentShader: EmberFragment,
            uniforms: {
                uRise: { value: 0 },
                uHeight: { value: 900 },
                uPixelRatio: { value: this.renderer.getPixelRatio() },
            },
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthWrite: false,
        });
        const points = new THREE.Points(geometry, this.emberMaterial);
        points.frustumCulled = false;
        return points;
    }

    setSize(width: number, height: number): void {
        this.width = Math.max(1, Math.round(width));
        this.height = Math.max(1, Math.round(height));
        this.renderer.setSize(this.width, this.height, false);
        const resolution = new THREE.Vector2(this.width, this.height);
        for (const mesh of [this.ropes, this.outlines, this.crossLinks]) {
            (mesh.material as LineMaterial).resolution.copy(resolution);
        }
    }

    setFreeLeft(left: number): void {
        this.freeLeft = Math.max(0, Math.min(this.width * 0.6, left));
    }

    setStill(still: boolean): void {
        this.still = still;
    }

    // He spoke, or the graph grew: the camera follows the newest node again.
    talked(at: number): void {
        this.talkAt = Math.max(this.talkAt, at);
    }

    // A new state of the graph. Nodes this view had not seen arrive from their parent; the first graph of the stage is
    // shown as it stands.
    setGraph(graph: BrainstormGraph, now: number): void {
        const first = this.graph == null;
        this.graph = graph;
        const ids = new Set((graph?.nodes ?? []).map((n) => n.id));
        for (const [id, entry] of this.plates) {
            if (!ids.has(id)) {
                entry.el.remove();
                this.plates.delete(id);
            }
        }
        for (const node of graph?.nodes ?? []) {
            const known = this.plates.get(node.id);
            if (known != null) {
                known.node = node;
                if (known.textEl.textContent !== node.text) {
                    known.textEl.textContent = node.text;
                    known.halfW = 0;
                }
                continue;
            }
            this.plates.set(node.id, this.makePlate(node, first ? 0 : now));
        }
        if (!first && graph?.nodes?.length) {
            this.talked(now);
        }
        this.relabel();
    }

    private makePlate(node: BrainstormNode, bornAt: number): PlateEntry {
        const el = document.createElement("div");
        const kindEl = document.createElement("span");
        const textEl = document.createElement("span");
        if (node.kind === "topic") {
            // The centre is the core; its title is the core's own label.
            return { node, el, kindEl, textEl, halfW: 0, halfH: 0, bornAt };
        }
        el.className = "mt-bs-plate";
        el.dataset.kind = node.kind;
        el.dataset.nodeId = node.id;
        // The plate takes its kind's colours from the same table as its rope (brainstorm.css reads them).
        const look = KindLooks[node.kind] ?? KindLooks.idea;
        el.style.setProperty("--bs-edge", look.edge);
        el.style.setProperty("--bs-label", look.label);
        el.style.setProperty("--bs-plate", look.plate);
        el.style.setProperty("--bs-glow", String(look.glow));
        el.setAttribute("role", "listitem");
        el.style.transform = Hidden;
        kindEl.className = "mt-bs-plate-kind";
        textEl.className = "mt-bs-plate-text";
        textEl.textContent = node.text;
        el.append(kindEl, textEl);
        this.host.plates.appendChild(el);
        return { node, el, kindEl, textEl, halfW: 0, halfH: 0, bornAt };
    }

    // The kinds' names follow the interface language.
    relabel(): void {
        for (const entry of this.plates.values()) {
            if (entry.node.kind === "topic") {
                continue;
            }
            const label = this.host.kindLabel(entry.node.kind);
            if (entry.kindEl.textContent !== label) {
                entry.kindEl.textContent = label;
                entry.halfW = 0;
            }
        }
    }

    start(): void {
        const loop = (now: number) => {
            if (this.disposed) {
                return;
            }
            this.renderFrame(now);
            this.raf = requestAnimationFrame(loop);
        };
        this.raf = requestAnimationFrame(loop);
    }

    private nodePos(entry: PlateEntry, now: number): { pos: Vec3; scale: number; opacity: number } {
        const node = entry.node;
        const age = entry.bornAt === 0 ? Infinity : now - entry.bornAt;
        const a = arrival(age, this.still);
        if (node.from == null || node.from === "" || a.scale >= 1) {
            return { pos: node.pos, scale: a.scale, opacity: a.opacity };
        }
        const parent = this.plates.get(node.from)?.node;
        if (parent == null) {
            return { pos: node.pos, scale: a.scale, opacity: a.opacity };
        }
        const t = this.still ? 1 : Math.min(1, a.scale);
        return {
            pos: [
                parent.pos[0] + (node.pos[0] - parent.pos[0]) * t,
                parent.pos[1] + (node.pos[1] - parent.pos[1]) * t,
                parent.pos[2] + (node.pos[2] - parent.pos[2]) * t,
            ],
            scale: a.scale,
            opacity: a.opacity,
        };
    }

    private project(pos: Vec3): { x: number; y: number; depth: number; front: boolean } {
        this.tmp.set(pos[0], pos[1], pos[2]);
        const depth = this.tmp.distanceTo(this.camera.position);
        this.tmp.project(this.camera);
        return {
            x: ((this.tmp.x + 1) / 2) * this.width,
            y: ((1 - this.tmp.y) / 2) * this.height,
            depth,
            front: this.tmp.z < 1,
        };
    }

    private moveCamera(now: number, dt: number): void {
        const freeWidth = Math.max(1, this.width - this.shownFreeLeft);
        const goal = cameraGoal(this.graph, now - this.talkAt, freeWidth / this.height);
        const newest = this.graph?.nodes?.[this.graph.nodes.length - 1]?.id ?? "";
        const goalTarget = new THREE.Vector3(goal.target[0], goal.target[1], goal.target[2]);
        if (this.still) {
            if (goal.mode !== this.mode || newest !== this.lastNewest) {
                this.host.onCrossFade?.();
            }
            this.target.copy(goalTarget);
            this.distance = goal.distance;
        } else {
            const share = easeShare(dt);
            this.target.lerp(goalTarget, share);
            this.distance += (goal.distance - this.distance) * share;
            this.azimuth += (turnRate(goal.mode, false) * dt) / 1000;
        }
        this.mode = goal.mode;
        this.lastNewest = newest;
        const flat = Math.cos(TiltRad) * this.distance;
        this.camera.position.set(
            this.target.x + Math.sin(this.azimuth) * flat,
            this.target.y + Math.sin(TiltRad) * this.distance,
            this.target.z + Math.cos(this.azimuth) * flat
        );
        this.camera.lookAt(this.target);
        // The graph is centred in the free space right of Brokk's group: the view's middle moves by half of it.
        this.camera.aspect = this.width / this.height;
        this.camera.setViewOffset(this.width, this.height, -this.shownFreeLeft / 2, 0, this.width, this.height);
        this.camera.updateProjectionMatrix();
    }

    // One frame at `now` (ms): the loop's, or a capture's.
    renderFrame(now: number): void {
        const dt = this.lastFrame === 0 ? 16 : Math.min(100, now - this.lastFrame);
        this.lastFrame = now;
        this.frame++;
        this.shownFreeLeft += (this.freeLeft - this.shownFreeLeft) * (this.still ? 1 : easeShare(dt, 300));
        this.moveCamera(now, dt);
        const pulse = corePulse(now, this.still);
        this.coreMaterial.uniforms.uTime.value = this.still ? 0 : now / 1000;
        this.coreMaterial.uniforms.uPulse.value = pulse;
        this.emberMaterial.uniforms.uRise.value = this.still
            ? Loops.emberRise.still
            : now / Loops.emberRise.periodMs;
        this.emberMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
        this.placeCore(now, pulse);
        this.placeRopesAndPlates(now);
        this.renderer.render(this.scene, this.camera);
    }

    private placeCore(now: number, pulse: number): void {
        const centre = this.graph?.centre ? this.plates.get(this.graph.centre) : null;
        if (centre == null) {
            this.core.visible = false;
            this.coreGlow.visible = false;
            this.coreTitle.style.transform = Hidden;
            return;
        }
        const placed = this.nodePos(centre, now);
        this.core.visible = true;
        this.coreGlow.visible = true;
        this.core.position.set(placed.pos[0], placed.pos[1], placed.pos[2]);
        this.core.scale.setScalar(placed.scale);
        this.coreGlow.position.copy(this.core.position);
        this.coreGlow.scale.setScalar(CoreRadius * 7.5 * placed.scale * (0.85 + 0.25 * pulse));
        (this.coreGlow.material as THREE.SpriteMaterial).opacity = placed.opacity * (0.7 + 0.3 * pulse);
        if (this.coreTitle.textContent !== centre.node.text) {
            this.coreTitle.textContent = centre.node.text;
        }
        const p = this.project([placed.pos[0], placed.pos[1] - CoreRadius * 1.25, placed.pos[2]]);
        const look = plateLook(p.depth, this.distance);
        this.coreTitle.style.opacity = String(placed.opacity);
        this.coreTitle.style.transform = p.front
            ? `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, 0) scale(${look.scale.toFixed(3)})`
            : Hidden;
    }

    private placeRopesAndPlates(now: number): void {
        const ropePos = positionsOf(this.ropes);
        const ropeCol = colorsOf(this.ropes);
        const outlinePos = positionsOf(this.outlines);
        const anchorPos = this.anchors.geometry.attributes.position.array as Float32Array;
        const anchorCol = this.anchors.geometry.attributes.color.array as Float32Array;
        const knotPos = this.knots.geometry.attributes.position.array as Float32Array;
        const knotCol = this.knots.geometry.attributes.color.array as Float32Array;
        let segments = 0;
        let marks = 0;
        const placed = new Map<string, { pos: Vec3; x: number; y: number; hw: number; hh: number; opacity: number }>();
        const color = new THREE.Color();
        const measure = this.frame % 15 === 1;

        const centreId = this.graph?.centre ?? "";
        for (const entry of this.plates.values()) {
            const at = this.nodePos(entry, now);
            const p = this.project(at.pos);
            if (entry.node.id === centreId) {
                const edge = this.project([at.pos[0] + CoreRadius * at.scale, at.pos[1], at.pos[2]]);
                const r = Math.max(6, Math.hypot(edge.x - p.x, edge.y - p.y));
                placed.set(entry.node.id, { pos: at.pos, x: p.x, y: p.y, hw: r * 0.92, hh: r * 0.92, opacity: at.opacity });
                continue;
            }
            const look = plateLook(p.depth, this.distance);
            if (measure || entry.halfW === 0) {
                entry.halfW = entry.el.offsetWidth / 2;
                entry.halfH = entry.el.offsetHeight / 2;
            }
            const scale = look.scale * at.scale;
            const opacity = look.opacity * at.opacity;
            entry.el.style.opacity = opacity.toFixed(3);
            entry.el.style.zIndex = String(Math.max(1, Math.round(10000 - p.depth)));
            entry.el.style.filter = look.blur > 0 ? `blur(${look.blur}px)` : "";
            entry.el.style.transform = p.front
                ? `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`
                : Hidden;
            placed.set(entry.node.id, {
                pos: at.pos,
                x: p.x,
                y: p.y,
                hw: entry.halfW * scale,
                hh: entry.halfH * scale,
                opacity,
            });
        }

        for (const entry of this.plates.values()) {
            const node = entry.node;
            if (!node.from) {
                continue;
            }
            const child = placed.get(node.id);
            const parent = placed.get(node.from);
            if (child == null || parent == null) {
                continue;
            }
            const curve = ropeCurve(parent.pos, child.pos);
            const screen = curve.map((pt) => this.project(pt));
            const inside = (i: number, box: typeof parent) =>
                Math.abs(screen[i].x - box.x) <= box.hw && Math.abs(screen[i].y - box.y) <= box.hh;
            let first = 0;
            while (first < curve.length - 1 && inside(first, parent)) {
                first++;
            }
            let last = curve.length - 1;
            while (last > first && inside(last, child)) {
                last--;
            }
            if (last <= first) {
                continue;
            }
            const start = this.edgePoint(curve, screen, first, parent, -1);
            const end = this.edgePoint(curve, screen, last, child, 1);
            const points: Vec3[] = [start, ...curve.slice(first, last + 1), end];
            const look = KindLooks[node.kind] ?? KindLooks.idea;
            color.set(look.rope);
            const dim = Math.min(child.opacity, parent.opacity);
            for (let i = 0; i < points.length - 1 && segments < RopeCapacity; i++) {
                const o = segments * 6;
                const a = points[i];
                const b = points[i + 1];
                ropePos.set([a[0], a[1], a[2], b[0], b[1], b[2]], o);
                outlinePos.set([a[0], a[1], a[2], b[0], b[1], b[2]], o);
                ropeCol.set([color.r * dim, color.g * dim, color.b * dim, color.r * dim, color.g * dim, color.b * dim], o);
                segments++;
            }
            if (marks < MaxNodes) {
                anchorPos.set(start, marks * 3);
                anchorCol.set([color.r * dim, color.g * dim, color.b * dim], marks * 3);
                knotPos.set(end, marks * 3);
                knotCol.set([color.r * dim, color.g * dim, color.b * dim], marks * 3);
                marks++;
            }
        }
        markSegments(this.ropes, segments, true);
        markSegments(this.outlines, segments, false);
        (this.outlines.material as LineMaterial).opacity = 0.85;
        this.anchors.geometry.setDrawRange(0, marks);
        this.knots.geometry.setDrawRange(0, marks);
        this.anchors.geometry.attributes.position.needsUpdate = true;
        this.anchors.geometry.attributes.color.needsUpdate = true;
        this.knots.geometry.attributes.position.needsUpdate = true;
        this.knots.geometry.attributes.color.needsUpdate = true;
        this.placeCrossLinks(placed);
    }

    // Where the rope crosses the edge of a box on screen, between the point at `i` (outside) and its neighbour toward
    // the box (`dir` -1 toward the start, 1 toward the end), by halving the step.
    private edgePoint(
        curve: Vec3[],
        screen: { x: number; y: number }[],
        i: number,
        box: { x: number; y: number; hw: number; hh: number },
        dir: number
    ): Vec3 {
        const j = i + dir;
        if (j < 0 || j >= curve.length) {
            return curve[i];
        }
        let lo = 0;
        let hi = 1;
        for (let k = 0; k < 8; k++) {
            const mid = (lo + hi) / 2;
            const x = screen[i].x + (screen[j].x - screen[i].x) * mid;
            const y = screen[i].y + (screen[j].y - screen[i].y) * mid;
            if (Math.abs(x - box.x) <= box.hw && Math.abs(y - box.y) <= box.hh) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        const t = lo;
        const a = curve[i];
        const b = curve[j];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }

    private placeCrossLinks(placed: Map<string, { pos: Vec3 }>): void {
        const positions = positionsOf(this.crossLinks);
        let segments = 0;
        for (const link of this.graph?.links ?? []) {
            const a = placed.get(link.a);
            const b = placed.get(link.b);
            if (a == null || b == null) {
                continue;
            }
            const curve = ropeCurve(a.pos, b.pos, Ropes.segments, Ropes.sag * 0.6);
            for (let i = 0; i < curve.length - 1 && segments < CrossCapacity; i++) {
                const p = curve[i];
                const q = curve[i + 1];
                positions.set([p[0], p[1], p[2], q[0], q[1], q[2]], segments * 6);
                segments++;
            }
        }
        markSegments(this.crossLinks, segments, false);
        if (segments > 0) {
            this.crossLinks.computeLineDistances();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        cancelAnimationFrame(this.raf);
        this.scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            mesh.geometry?.dispose?.();
            const material = mesh.material as THREE.Material | THREE.Material[];
            if (Array.isArray(material)) {
                material.forEach((m) => m.dispose());
            } else {
                material?.dispose?.();
            }
        });
        this.textures.forEach((texture) => texture.dispose());
        for (const entry of this.plates.values()) {
            entry.el.remove();
        }
        this.plates.clear();
        this.coreTitle.remove();
        this.renderer.dispose();
        // The graphics context goes with the stage (FR-BOSS-010 AC19, NFR-BOSS-009): none while the mode is closed.
        this.renderer.forceContextLoss();
    }
}

export function makeBrainstormScene(host: SceneHost): BrainstormScene {
    return new BrainstormScene(host);
}

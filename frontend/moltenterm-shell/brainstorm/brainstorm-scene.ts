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
// and dispose() frees the graphics context. Under reduced motion nothing moves by itself, so it draws only when something
// asks (wake): a graph, a size, the free space, a label, the developer's hand (#2283).
//
// The developer may take the camera (pan, zoom about the pointer, Recentre): brainstorm-camera-model.ts decides who holds
// it and where it looks; this scene only follows its goal (#2283).
//
// The graph is living (FR-BOSS-010 AC26 to AC28, #2247): the nodes of one answer arrive one by one; an edit or a retype
// changes a plate in place; a removed plate cools and fades while its rope slackens and drops, and a merge pulls the
// folded plates into the one kept, while the others keep their places (the layout never jumps). Each plate is an item
// of the graph's outline: it takes the focus, carries a handle for its menu, and its text can be edited in place.

import { makeIconClass } from "@/util/util";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { HistoryNote } from "./brainstorm-boot";
import {
    CameraMode,
    CameraNav,
    cameraPosition,
    CameraView,
    drawsAgain,
    inView,
    InViewMarginPx,
    Lens,
    StillSettleMs,
} from "./brainstorm-camera-model";
import { editKey } from "./brainstorm-edit-model";
import type { BrainstormGraph, BrainstormNode, NodeKind } from "./brainstorm-graph-model";
import { MaxLinks, MaxNodes } from "./brainstorm-graph-model";
import {
    arrival,
    arrivalDelay,
    CameraFov,
    corePulse,
    CoreRadius,
    CrossLinkColor,
    declutter,
    easeShare,
    followDistance,
    FreeRect,
    KindLooks,
    leaveLook,
    Loops,
    OverviewAfterMs,
    plateLook,
    ropeCurve,
    Ropes,
    SceneColors,
    ScreenBox,
    swayAngle,
    Vec3,
} from "./brainstorm-scene-model";

// The tether's colour (tether.css --mt-action), read from the theme so that a rope here is the app's rope.
function tetherColor(): string {
    try {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--mt-action").trim();
        if (value !== "") {
            new THREE.Color(value);
            return value;
        }
    } catch {
        // An unreadable value falls back to the forge's ember.
    }
    return CrossLinkColor;
}

export type SceneHost = {
    canvas: HTMLCanvasElement;
    // The layer the plates and the core's title are placed in, over the canvas.
    plates: HTMLElement;
    // The kind's name as the plates show it, in the interface language.
    kindLabel: (kind: NodeKind) => string;
    // The name of a plate's handle, which opens its menu (#2247), in the interface language.
    gripLabel?: (text: string) => string;
    // Under reduced motion a change of view is a short cross-fade of the stage instead of a flight.
    onCrossFade?: () => void;
    // The camera turned to the newest topic or back to the whole graph, or the developer took it: the header says which
    // (#2257, the mockup's) and shows Follow Brokk while the developer holds it (#2283).
    onCameraMode?: (mode: CameraMode) => void;
    // Brokk added a plate out of the developer's view after a quiet stretch: the Follow Brokk chip pulses once.
    onFollowPulse?: () => void;
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
    // How far the plate stands from its node on screen, having made room for its neighbours (eased).
    offX: number;
    offY: number;
    gripEl?: HTMLButtonElement;
    // The developer edits its text in place: a new state of the graph does not overwrite what they type.
    editing?: boolean;
};

// A plate that left the graph (#2247), drawn until its leave ends: when it left, the plate a merge folded it into, and
// the parent its rope hung from.
type LeavingEntry = PlateEntry & { goneAt: number; into: string; parent: string };

// The plates folded by the merges of the history, each with the plate kept.
function mergedInto(history: HistoryNote[]): Map<string, string> {
    const into = new Map<string, string>();
    for (const note of history ?? []) {
        if (note?.op !== "merge" || note.undone || (note.nodes?.length ?? 0) < 2) {
            continue;
        }
        for (const folded of note.nodes.slice(1)) {
            into.set(folded.id, note.nodes[0].id);
        }
    }
    return into;
}

// Above this many plates they no longer make room for each other each frame (#2247 lays large graphs out).
const DeclutterLimit = 160;

const EmberCount = 180;
// A node made this recently still arrives when the stage opens on it.
const FreshMs = 4000;
const RopeCapacity = MaxNodes * Ropes.segments;
const CrossCapacity = MaxLinks * Ropes.segments;
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
    // The plates that left the graph and are still leaving (#2247).
    leaving = new Map<string, LeavingEntry>();
    lastLeftAt = 0;
    coreTitle: HTMLDivElement;
    // The core's title stands for the centre in the outline: its text edited in place too.
    coreEditing = false;
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
    // The free space beside or under Brokk's group, in the stage's pixels: the graph is centred and framed in it. The
    // shown one eases toward it when his conversation window grows.
    free: FreeRect = null;
    shownFree: FreeRect = null;
    still = false;
    // When he last spoke or the graph last grew: the camera follows until OverviewAfterMs after it.
    talkAt = 0;
    target = new THREE.Vector3();
    distance = 900;
    azimuth = 0;
    // Who holds the camera, Brokk or the developer, and the developer's view (#2283).
    nav = new CameraNav();
    mode: CameraMode = "overview";
    // The mode the host last heard: the first frame tells it, so a new stage never keeps an old stage's word.
    reportedMode: CameraMode = null;
    startedAt = Date.now();
    ropeColor = tetherColor();
    coreTitleHalfW = 0;
    coreTitleH = 0;
    lastFrame = 0;
    lastNewest = "";
    // The cross-links are drawn again only when the graph changed or a node is still arriving.
    lastBornAt = 0;
    crossRev = -1;
    frame = 0;
    raf = 0;
    running = false;
    // Under reduced motion the frames stop after this time, until the next wake.
    awakeUntil = 0;
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
        try {
            this.build();
        } catch (e) {
            // The stage never gets a scene that failed half-built, so it could not free its graphics context: free it
            // here, with what was built.
            this.dispose();
            throw e;
        }
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
        // The centre's item of the outline: first in it, and its text edited in place like a plate's (#2247).
        this.coreTitle.setAttribute("role", "listitem");
        this.coreTitle.tabIndex = -1;
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
            seeds[i * 4 + 3] = 3 + rand() * 4;
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
        this.wake();
    }

    setFreeRect(rect: FreeRect): void {
        const same =
            this.free != null &&
            rect != null &&
            this.free.left === rect.left &&
            this.free.top === rect.top &&
            this.free.width === rect.width &&
            this.free.height === rect.height;
        this.free = rect;
        if (this.shownFree == null) {
            this.shownFree = { ...rect };
        }
        // The stage measures the free space every 400 ms: only a change asks for frames.
        if (!same) {
            this.wake();
        }
    }

    private easeFree(share: number): FreeRect {
        const goal = this.free ?? { left: 0, top: 0, width: this.width, height: this.height };
        if (this.shownFree == null || share >= 1) {
            this.shownFree = { ...goal };
            return this.shownFree;
        }
        const s = this.shownFree;
        s.left += (goal.left - s.left) * share;
        s.top += (goal.top - s.top) * share;
        s.width += (goal.width - s.width) * share;
        s.height += (goal.height - s.height) * share;
        return s;
    }

    setStill(still: boolean): void {
        this.still = still;
        this.wake();
    }

    // He spoke, or the graph grew: the camera follows the newest node again (while Brokk holds it). Under reduced motion
    // the frames go on until the overview the pause brings.
    talked(at: number): void {
        this.talkAt = Math.max(this.talkAt, at);
        this.wakeUntil(this.talkAt + OverviewAfterMs + StillSettleMs);
    }

    // A new state of the graph. Nodes this view had not seen arrive from their parent, one after the other (AC5); the
    // first graph of the stage is shown as it stands. A node gone leaves (removed, or folded by a merge the history
    // names), and one changed in place keeps its plate. `history` is the state's (#2247).
    setGraph(graph: BrainstormGraph, now: number, history: HistoryNote[] = null): void {
        const first = this.graph == null;
        this.graph = graph;
        const ids = new Set((graph?.nodes ?? []).map((n) => n.id));
        const folded = mergedInto(history);
        for (const [id, entry] of this.plates) {
            if (ids.has(id)) {
                continue;
            }
            this.plates.delete(id);
            if (first || entry.node.kind === "topic") {
                entry.el.remove();
                continue;
            }
            this.leave(entry, folded.get(id) ?? null, now);
        }
        let born = 0;
        let lastBirth = now;
        for (const node of graph?.nodes ?? []) {
            const known = this.plates.get(node.id);
            if (known != null) {
                const kindChanged = known.node.kind !== node.kind;
                known.node = node;
                if (kindChanged) {
                    this.restyle(known);
                }
                if (!known.editing && known.textEl.textContent !== node.text) {
                    known.textEl.textContent = node.text;
                    known.halfW = 0;
                }
                continue;
            }
            // A plate put back by an undo leaves no ghost behind.
            this.leaving.get(node.id)?.el.remove();
            this.leaving.delete(node.id);
            // A node the stage opened with arrives too when it was just made (the answer that opened the mode).
            const fresh = !first || (node.at > 0 && now - node.at < FreshMs);
            const bornAt = fresh ? now + arrivalDelay(born, this.still) : 0;
            this.plates.set(node.id, this.makePlate(node, bornAt));
            if (fresh) {
                born++;
                lastBirth = bornAt;
                this.lastBornAt = Math.max(this.lastBornAt, bornAt);
            }
            // Out of the developer's view after a quiet stretch: the chip says so, the view stays (#2283).
            if (!first && this.nav.plateAdded(node.pos, this.shownView(), this.lens(), now)) {
                this.host.onFollowPulse?.();
            }
        }
        // A plate the developer put back is theirs: the camera stays where it is.
        if (!first && born > 0 && history?.[history.length - 1]?.by !== "you") {
            this.talked(now);
        }
        this.crossRev = -1;
        this.relabel();
        this.wake(lastBirth - now + Loops.arrival.ms + StillSettleMs);
        if (this.leaving.size > 0) {
            this.wake(Loops.leave.ms + StillSettleMs);
        }
    }

    // A plate leaves the graph: it stays drawn while it cools, drops or is pulled in, then goes.
    private leave(entry: PlateEntry, into: string, now: number): void {
        const gone: LeavingEntry = { ...entry, goneAt: now, into, parent: entry.node.from ?? "" };
        gone.el.classList.add("is-leaving");
        gone.el.removeAttribute("role");
        gone.el.tabIndex = -1;
        gone.el.setAttribute("aria-hidden", "true");
        this.leaving.get(entry.node.id)?.el.remove();
        this.leaving.set(entry.node.id, gone);
        this.lastLeftAt = now;
        if (this.still) {
            this.host.onCrossFade?.();
        }
    }

    // A retype: the plate takes its new kind's colours and name in place; a short flash says it changed (a cross-fade
    // under reduced motion).
    private restyle(entry: PlateEntry): void {
        if (entry.node.kind === "topic") {
            return;
        }
        const look = KindLooks[entry.node.kind] ?? KindLooks.idea;
        entry.el.dataset.kind = entry.node.kind;
        entry.el.style.setProperty("--bs-edge", look.edge);
        entry.el.style.setProperty("--bs-label", look.label);
        entry.el.style.setProperty("--bs-plate", look.plate);
        entry.el.style.setProperty("--bs-glow", String(look.glow));
        entry.el.classList.remove("is-retyped");
        // A reflow restarts the flash when the same plate changes twice.
        void entry.el.offsetWidth;
        entry.el.classList.add("is-retyped");
        entry.halfW = 0;
        if (this.still) {
            this.host.onCrossFade?.();
        }
    }

    private makePlate(node: BrainstormNode, bornAt: number): PlateEntry {
        const el = document.createElement("div");
        const kindEl = document.createElement("span");
        const textEl = document.createElement("span");
        if (node.kind === "topic") {
            // The centre is the core; its title is the core's own label.
            return { node, el, kindEl, textEl, halfW: 0, halfH: 0, bornAt, offX: 0, offY: 0 };
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
        // An item of the graph's outline (AC20): the stage moves the one focusable plate as the keyboard walks it.
        el.tabIndex = -1;
        el.style.transform = Hidden;
        kindEl.className = "mt-bs-plate-kind";
        textEl.className = "mt-bs-plate-text";
        textEl.textContent = node.text;
        // The handle that opens the plate's menu (AC27): the pointer's way; the keyboard's is the menu key on the plate.
        const gripEl = document.createElement("button");
        gripEl.type = "button";
        gripEl.className = "mt-bs-plate-grip";
        gripEl.tabIndex = -1;
        const icon = document.createElement("i");
        icon.className = makeIconClass("ellipsis", false);
        icon.setAttribute("aria-hidden", "true");
        gripEl.appendChild(icon);
        el.append(kindEl, textEl, gripEl);
        this.host.plates.appendChild(el);
        return { node, el, kindEl, textEl, halfW: 0, halfH: 0, bornAt, offX: 0, offY: 0, gripEl };
    }

    // The kinds' names follow the interface language, and so does each handle's name.
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
            const grip = this.host.gripLabel?.(entry.node.text) ?? "";
            if (entry.gripEl != null && entry.gripEl.getAttribute("aria-label") !== grip) {
                entry.gripEl.setAttribute("aria-label", grip);
                entry.gripEl.title = grip;
            }
        }
        this.wake();
    }

    // The element of a node in the outline: its plate, or the core's title for the centre.
    nodeElement(id: string): HTMLElement {
        if (id != null && id === this.graph?.centre) {
            return this.coreTitle;
        }
        return this.plates.get(id)?.el ?? null;
    }

    // A click on a node, or Enter on it in the outline (AC7, AC20): the camera glides to it.
    focusNode(id: string): void {
        const node = this.plates.get(id)?.node;
        if (node == null) {
            return;
        }
        this.nav.focusOn(node.pos as Vec3, this.graph, this.lens(), Date.now(), this.still);
        this.wake();
    }

    // The keyboard walked the outline to a node out of the free space: the camera goes to it; one in view stays put.
    revealNode(id: string): void {
        const node = this.plates.get(id)?.node;
        if (node == null || inView(node.pos as Vec3, this.shownView(), this.lens(), InViewMarginPx)) {
            return;
        }
        this.focusNode(id);
    }

    // Edit text (AC27): the node's text becomes editable in place; Enter or leaving the field saves it, Escape cancels.
    // done gets the typed text, or null when cancelled. Keys stay in the field: none pans, and Escape never ends the
    // brainstorm.
    beginEdit(id: string, done: (text: string) => void): void {
        const isCentre = id === this.graph?.centre;
        const entry = this.plates.get(id);
        const field = isCentre ? this.coreTitle : entry?.textEl;
        if (field == null || entry == null || entry.editing || (isCentre && this.coreEditing)) {
            return;
        }
        const before = entry.node.text;
        entry.editing = true;
        if (isCentre) {
            this.coreEditing = true;
        }
        const plate = isCentre ? this.coreTitle : entry.el;
        plate.classList.add("is-editing");
        try {
            field.contentEditable = "plaintext-only";
        } catch {
            field.contentEditable = "true";
        }
        field.spellcheck = true;
        let finished = false;
        const finish = (save: boolean) => {
            if (finished) {
                return;
            }
            finished = true;
            field.removeEventListener("keydown", onKey);
            field.removeEventListener("blur", onBlur);
            field.contentEditable = "false";
            field.removeAttribute("contenteditable");
            plate.classList.remove("is-editing");
            entry.editing = false;
            if (isCentre) {
                this.coreEditing = false;
            }
            const typed = field.textContent ?? "";
            // What shows until the graph says: the typed text when it is saved, the text as it was otherwise.
            if (!save) {
                field.textContent = before;
            }
            entry.halfW = 0;
            this.wake();
            done(save ? typed : null);
        };
        const onKey = (e: KeyboardEvent) => {
            e.stopPropagation();
            const action = editKey(e);
            if (action == null) {
                return;
            }
            e.preventDefault();
            finish(action === "save");
            plate.focus({ preventScroll: true });
        };
        const onBlur = () => finish(true);
        field.addEventListener("keydown", onKey);
        field.addEventListener("blur", onBlur);
        field.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(field);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        this.wake();
    }

    // Every time of the scene is the wall clock's (Date.now), the one the graph's arrivals and his talk are stamped with;
    // requestAnimationFrame's own time counts from the page's start and would never meet them.
    start(): void {
        this.running = true;
        this.wake();
    }

    // Asks for frames: the next one, and under reduced motion every one for `ms` more; while things move by themselves
    // the loop never stops (AC18: the thought is alive while it is visible).
    wake(ms: number = StillSettleMs): void {
        this.wakeUntil(Date.now() + ms);
    }

    private wakeUntil(at: number): void {
        this.awakeUntil = Math.max(this.awakeUntil, at);
        if (this.running && !this.disposed && this.raf === 0) {
            this.raf = requestAnimationFrame(this.tick);
        }
    }

    private tick = (): void => {
        this.raf = 0;
        if (this.disposed) {
            return;
        }
        const now = Date.now();
        this.renderFrame(now);
        if (drawsAgain(this.still, now, this.awakeUntil)) {
            this.raf = requestAnimationFrame(this.tick);
        }
    };

    // The camera as it shows, and what it sees with (brainstorm-camera-model.ts).
    shownView(): CameraView {
        return { target: [this.target.x, this.target.y, this.target.z], distance: this.distance };
    }

    lens(free: FreeRect = this.shownFree): Lens {
        return {
            width: this.width,
            height: this.height,
            free: free ?? { left: 0, top: 0, width: this.width, height: this.height },
            azimuth: this.azimuth,
        };
    }

    // The developer's hand (FR-BOSS-010 AC7a, #2283): the graph follows the pointer by (dx, dy) px.
    pan(dx: number, dy: number): void {
        this.nav.pan(this.shownView(), dx, dy, this.graph, this.lens(), Date.now());
        this.wake();
    }

    // A zoom by `factor` (above 1: closer) about the stage's point (x, y), which stays under the pointer.
    zoomAt(factor: number, x: number, y: number): void {
        this.nav.zoomAt(this.shownView(), factor, { x, y }, this.graph, this.lens(), Date.now());
        this.wake();
    }

    // A zoom with the keys, about the middle of the free space.
    zoomStep(factor: number): void {
        this.nav.zoomStep(this.shownView(), factor, this.graph, this.lens(), Date.now());
        this.wake();
    }

    // The whole graph framed; the developer keeps the camera.
    recentre(): void {
        this.nav.recentre(this.graph, this.lens(), Date.now(), this.still);
        this.wake();
    }

    // The camera goes back to Brokk (AC7b).
    followBrokk(): void {
        this.nav.follow(this.still);
        this.wake();
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

    private project(pos: Vec3): { x: number; y: number; depth: number; front: boolean; ndcZ: number } {
        this.tmp.set(pos[0], pos[1], pos[2]);
        const depth = this.tmp.distanceTo(this.camera.position);
        this.tmp.project(this.camera);
        return {
            x: ((this.tmp.x + 1) / 2) * this.width,
            y: ((1 - this.tmp.y) / 2) * this.height,
            depth,
            front: this.tmp.z < 1,
            ndcZ: this.tmp.z,
        };
    }

    // The world point shown at (x, y) on screen, at the depth `ndcZ`: where a rope meets a plate that made room.
    private unproject(x: number, y: number, ndcZ: number): Vec3 {
        this.tmp.set((x / this.width) * 2 - 1, 1 - (y / this.height) * 2, ndcZ).unproject(this.camera);
        return [this.tmp.x, this.tmp.y, this.tmp.z];
    }

    private moveCamera(now: number, dt: number, free: FreeRect): void {
        this.azimuth = swayAngle(now - this.startedAt, this.still);
        const goal = this.nav.goal(this.graph, now - this.talkAt, this.lens(free));
        const newest = this.graph?.nodes?.[this.graph.nodes.length - 1]?.id ?? "";
        const goalTarget = new THREE.Vector3(goal.target[0], goal.target[1], goal.target[2]);
        const jump = this.nav.takeJump();
        if (this.still || !goal.glide) {
            // A pan or a zoom follows the hand: only a change of view the developer did not draw by hand cross-fades.
            const turned = goal.mode !== this.mode || newest !== this.lastNewest;
            if (this.still && (jump || (goal.mode !== "free" && this.mode !== "free" && turned))) {
                this.host.onCrossFade?.();
            }
            this.target.copy(goalTarget);
            this.distance = goal.distance;
        } else {
            const share = easeShare(dt);
            this.target.lerp(goalTarget, share);
            this.distance += (goal.distance - this.distance) * share;
        }
        if (goal.mode !== this.reportedMode) {
            this.reportedMode = goal.mode;
            this.host.onCameraMode?.(goal.mode);
        }
        this.mode = goal.mode;
        this.lastNewest = newest;
        const position = cameraPosition(this.shownView(), this.azimuth);
        this.camera.position.set(position[0], position[1], position[2]);
        this.camera.lookAt(this.target);
        // The graph is centred in the free space: the view's middle moves to the free space's middle.
        const cx = free.left + free.width / 2;
        const cy = free.top + free.height / 2;
        this.camera.aspect = this.width / this.height;
        this.camera.setViewOffset(
            this.width,
            this.height,
            this.width / 2 - cx,
            this.height / 2 - cy,
            this.width,
            this.height
        );
        this.camera.updateProjectionMatrix();
    }

    // One frame at `now` (ms): the loop's, or a capture's.
    renderFrame(now: number): void {
        const dt = this.lastFrame === 0 ? 16 : Math.min(100, now - this.lastFrame);
        this.lastFrame = now;
        this.frame++;
        const free = this.easeFree(this.still ? 1 : easeShare(dt, 300));
        this.moveCamera(now, dt, free);
        const pulse = corePulse(now, this.still);
        // The shaders get small numbers: a float of the graphics card holds the epoch's milliseconds to the minute only.
        const elapsed = now - this.startedAt;
        this.coreMaterial.uniforms.uTime.value = this.still ? 0 : (elapsed / 1000) % 3600;
        this.coreMaterial.uniforms.uPulse.value = pulse;
        this.emberMaterial.uniforms.uRise.value = this.still
            ? Loops.emberRise.still
            : (elapsed / Loops.emberRise.periodMs) % 1;
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
        if (!this.coreEditing && this.coreTitle.textContent !== centre.node.text) {
            this.coreTitle.textContent = centre.node.text;
        }
        if (this.coreTitle.dataset.nodeId !== centre.node.id) {
            this.coreTitle.dataset.nodeId = centre.node.id;
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
        const color = new THREE.Color(this.ropeColor);
        const measure = this.frame % 15 === 1;
        const reference = followDistance(
            this.shownFree ?? { left: 0, top: 0, width: this.width, height: this.height },
            this.height
        );

        // Where each node falls on screen as the camera sees it.
        const centreId = this.graph?.centre ?? "";
        let coreRadiusPx = 0;
        const items: {
            entry: PlateEntry;
            at: ReturnType<BrainstormScene["nodePos"]>;
            p: ReturnType<BrainstormScene["project"]>;
            box: ScreenBox;
            scale: number;
            opacity: number;
            blur: number;
        }[] = [];
        for (const entry of this.plates.values()) {
            const at = this.nodePos(entry, now);
            const p = this.project(at.pos);
            if (entry.node.id === centreId) {
                const edge = this.project([at.pos[0] + CoreRadius * at.scale, at.pos[1], at.pos[2]]);
                const r = Math.max(6, Math.hypot(edge.x - p.x, edge.y - p.y));
                if (measure || this.coreTitleHalfW === 0) {
                    this.coreTitleHalfW = this.coreTitle.offsetWidth / 2;
                    this.coreTitleH = this.coreTitle.offsetHeight;
                }
                // The core and its title under it: an obstacle the plates keep clear of.
                const top = p.y - r * 1.15;
                const bottom = p.y + r * 1.3 + this.coreTitleH;
                items.push({
                    entry,
                    at,
                    p,
                    box: {
                        x: p.x,
                        y: (top + bottom) / 2,
                        hw: Math.max(r * 1.2, this.coreTitleHalfW),
                        hh: (bottom - top) / 2,
                        fixed: true,
                    },
                    scale: 1,
                    opacity: at.opacity,
                    blur: 0,
                });
                coreRadiusPx = r;
                continue;
            }
            const look = plateLook(p.depth, this.distance, reference);
            if (measure || entry.halfW === 0) {
                entry.halfW = entry.el.offsetWidth / 2;
                entry.halfH = entry.el.offsetHeight / 2;
            }
            const scale = look.scale * at.scale;
            items.push({
                entry,
                at,
                p,
                box: { x: p.x, y: p.y, hw: entry.halfW * scale, hh: entry.halfH * scale, fixed: !p.front },
                scale,
                opacity: look.opacity * at.opacity,
                blur: look.blur,
            });
        }
        // The plates make room for each other, and the shown places ease toward it (DeclutterLimit plates at most).
        const offsets =
            items.length <= DeclutterLimit
                ? declutter(
                      items.map((i) => i.box),
                      this.shownFree
                  )
                : items.map(() => [0, 0]);
        const ease = this.still ? 1 : 0.18;
        items.forEach((item, i) => {
            const entry = item.entry;
            entry.offX += (offsets[i][0] - entry.offX) * ease;
            entry.offY += (offsets[i][1] - entry.offY) * ease;
            const x = item.p.x + entry.offX;
            const y = item.p.y + entry.offY;
            if (entry.node.id === centreId) {
                // A rope leaves the core at its round edge.
                const r = coreRadiusPx * 0.92;
                placed.set(entry.node.id, {
                    pos: item.at.pos,
                    x: item.p.x,
                    y: item.p.y,
                    hw: r,
                    hh: r,
                    opacity: item.opacity,
                });
                return;
            }
            const pos = item.box.fixed ? item.at.pos : this.unproject(x, y, item.p.ndcZ);
            placed.set(entry.node.id, { pos, x, y, hw: item.box.hw, hh: item.box.hh, opacity: item.opacity });
            entry.el.style.opacity = item.opacity.toFixed(3);
            // A plate not born yet takes no click where it will appear.
            entry.el.style.visibility = item.opacity <= 0.01 ? "hidden" : "";
            entry.el.style.zIndex = String(Math.max(1, Math.round(10000 - item.p.depth)));
            entry.el.style.filter = item.blur > 0 ? `blur(${item.blur}px)` : "";
            entry.el.style.transform = item.p.front
                ? `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${item.scale.toFixed(3)})`
                : Hidden;
        });

        let outlineSegments = 0;
        type Box = { pos: Vec3; x: number; y: number; hw: number; hh: number; opacity: number };
        // A rope from parent to child cut at their edges on screen, in `tint` dimmed by `dim`; its dark under-rope only
        // while it is lit enough to need one (a leaving rope loses it as it fades).
        const drawRope = (
            parent: Box,
            child: Box,
            curve: Vec3[],
            tint: THREE.Color,
            dim: number,
            withOutline: boolean
        ) => {
            const screen = curve.map((pt) => this.project(pt));
            const inside = (i: number, box: Box) =>
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
                return;
            }
            const start = this.edgePoint(curve, screen, first, parent, -1);
            const end = this.edgePoint(curve, screen, last, child, 1);
            const points: Vec3[] = [start, ...curve.slice(first, last + 1), end];
            const r = tint.r * dim;
            const g = tint.g * dim;
            const b = tint.b * dim;
            for (let i = 0; i < points.length - 1 && segments < RopeCapacity; i++) {
                const p = points[i];
                const q = points[i + 1];
                ropePos.set([p[0], p[1], p[2], q[0], q[1], q[2]], segments * 6);
                ropeCol.set([r, g, b, r, g, b], segments * 6);
                segments++;
                if (withOutline) {
                    outlinePos.set([p[0], p[1], p[2], q[0], q[1], q[2]], outlineSegments * 6);
                    outlineSegments++;
                }
            }
            if (marks < MaxNodes) {
                anchorPos.set(start, marks * 3);
                anchorCol.set([r, g, b], marks * 3);
                knotPos.set(end, marks * 3);
                knotCol.set([r, g, b], marks * 3);
                marks++;
            }
        };
        for (const entry of this.plates.values()) {
            const node = entry.node;
            if (!node.from) {
                continue;
            }
            const child = placed.get(node.id);
            const parent = placed.get(node.from);
            // A node not born yet (the ones of an answer arrive one by one) has no rope yet.
            if (child == null || parent == null || child.opacity <= 0.01) {
                continue;
            }
            drawRope(
                parent,
                child,
                ropeCurve(parent.pos, child.pos),
                color,
                Math.min(child.opacity, parent.opacity),
                true
            );
        }
        this.placeLeaving(now, placed, reference, color, drawRope);
        markSegments(this.ropes, segments, true);
        markSegments(this.outlines, outlineSegments, false);
        (this.outlines.material as LineMaterial).opacity = 0.85;
        this.anchors.geometry.setDrawRange(0, marks);
        this.knots.geometry.setDrawRange(0, marks);
        this.anchors.geometry.attributes.position.needsUpdate = true;
        this.anchors.geometry.attributes.color.needsUpdate = true;
        this.knots.geometry.attributes.position.needsUpdate = true;
        this.knots.geometry.attributes.color.needsUpdate = true;
        const arriving = now - this.lastBornAt < Loops.arrival.ms + 100;
        if (arriving || this.crossRev !== (this.graph?.rev ?? 0)) {
            this.crossRev = this.graph?.rev ?? 0;
            this.placeCrossLinks(placed);
        }
    }

    // The plates leaving the graph (#2247). A removed one cools to cold iron and fades while it drops, its rope from its
    // parent slackening and falling with it; one folded by a merge is pulled into the plate kept, with no rope. Under
    // reduced motion each only fades where it stood. A plate whose leave ended goes.
    private placeLeaving(
        now: number,
        placed: Map<string, { pos: Vec3; x: number; y: number; hw: number; hh: number; opacity: number }>,
        reference: number,
        color: THREE.Color,
        drawRope: (
            parent: { pos: Vec3; x: number; y: number; hw: number; hh: number; opacity: number },
            child: { pos: Vec3; x: number; y: number; hw: number; hh: number; opacity: number },
            curve: Vec3[],
            tint: THREE.Color,
            dim: number,
            withOutline: boolean
        ) => void
    ): void {
        const cold = new THREE.Color(SceneColors.cold);
        for (const [id, gone] of this.leaving) {
            const look = leaveLook(now - gone.goneAt, this.still);
            if (look.done) {
                gone.el.remove();
                this.leaving.delete(id);
                continue;
            }
            const from = gone.node.pos as Vec3;
            const into = gone.into != null ? placed.get(gone.into) : null;
            const pos: Vec3 =
                into != null
                    ? [
                          from[0] + (into.pos[0] - from[0]) * look.pull,
                          from[1] + (into.pos[1] - from[1]) * look.pull,
                          from[2] + (into.pos[2] - from[2]) * look.pull,
                      ]
                    : [from[0], from[1] - look.drop, from[2]];
            const p = this.project(pos);
            const depthLook = plateLook(p.depth, this.distance, reference);
            const opacity = depthLook.opacity * look.opacity;
            const scale = depthLook.scale * look.scale;
            const x = p.x + gone.offX;
            const y = p.y + gone.offY;
            gone.el.style.opacity = opacity.toFixed(3);
            gone.el.style.filter = "";
            gone.el.style.setProperty("--bs-cool", look.cool.toFixed(3));
            gone.el.style.transform = p.front
                ? `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`
                : Hidden;
            const parent = into == null ? placed.get(gone.parent) : null;
            if (parent == null || opacity <= 0.02) {
                continue;
            }
            const box = { pos, x, y, hw: gone.halfW * scale, hh: gone.halfH * scale, opacity };
            const tint = color.clone().lerp(cold, look.cool);
            drawRope(
                parent,
                box,
                ropeCurve(parent.pos, pos, Ropes.segments, Ropes.sag * look.slack),
                tint,
                Math.min(opacity, parent.opacity),
                opacity > 0.5
            );
        }
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
        this.dashDistances(segments);
    }

    // The dashes run along each link: the distances are written in place, in a buffer made once (three's own
    // computeLineDistances makes a new one at each call).
    private dashDistances(segments: number): void {
        const geometry = this.crossLinks.geometry;
        let start = geometry.attributes.instanceDistanceStart as THREE.InterleavedBufferAttribute;
        if (start == null) {
            const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(CrossCapacity * 2), 2, 1);
            geometry.setAttribute("instanceDistanceStart", new THREE.InterleavedBufferAttribute(buffer, 1, 0));
            geometry.setAttribute("instanceDistanceEnd", new THREE.InterleavedBufferAttribute(buffer, 1, 1));
            start = geometry.attributes.instanceDistanceStart as THREE.InterleavedBufferAttribute;
        }
        const positions = positionsOf(this.crossLinks);
        const distances = start.data.array as Float32Array;
        let total = 0;
        for (let i = 0; i < segments; i++) {
            const o = i * 6;
            const length = Math.hypot(
                positions[o + 3] - positions[o],
                positions[o + 4] - positions[o + 1],
                positions[o + 5] - positions[o + 2]
            );
            distances[i * 2] = total;
            total += length;
            distances[i * 2 + 1] = total;
        }
        start.data.needsUpdate = true;
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
        for (const entry of [...this.plates.values(), ...this.leaving.values()]) {
            entry.el.remove();
        }
        this.plates.clear();
        this.leaving.clear();
        this.coreTitle?.remove();
        this.renderer.dispose();
        // The graphics context goes with the stage (FR-BOSS-010 AC19, NFR-BOSS-009): none while the mode is closed.
        this.renderer.forceContextLoss();
    }
}

export function makeBrainstormScene(host: SceneHost): BrainstormScene {
    return new BrainstormScene(host);
}

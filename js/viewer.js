/*
 * Visor 2D sobre canvas: dibujo de la escena DXF, encuadre, zoom y gestos.
 * Funciona con mouse (rueda + arrastre) y con pantalla tactil (arrastrar,
 * pellizcar para zoom, toque para seleccionar, toque largo para menu).
 */

import { SpatialIndex, pickShape } from './scene.js';

const MIN_SCALE = 1e-6;
const MAX_SCALE = 1e7;
const TAP_SLOP = 10;        // px de movimiento tolerados en un toque
const LONG_PRESS_MS = 550;
const MAX_DRAWN = 120000;   // limite de figuras por cuadro

export class Viewer {
    constructor(canvas, handlers = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.handlers = handlers;
        this.camera = { x: 0, y: 0, scale: 1 };
        this.shapes = [];
        this.byId = new Map();
        this.index = null;
        this.bounds = [0, 0, 100, 100];
        this.layerState = new Map();
        this.selection = new Set();
        this.markers = [];
        this.highlight = null;
        this.dirty = false;
        this.pointers = new Map();
        this.gesture = null;
        this.longPressTimer = null;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        this.theme = {
            background: '#10151c',
            grid: 'rgba(255,255,255,0.06)',
            defaultStroke: '#d7dee8',
            selection: '#ffcc33',
            hover: '#7fd1ff',
            text: '#cbd5e1'
        };
        this.bindEvents();
        this.resize();
    }

    /* ---------------- escena ---------------- */

    setScene(shapes, bounds) {
        this.shapes = shapes;
        this.bounds = bounds;
        this.byId = new Map(shapes.map((shape) => [shape.id, shape]));
        this.index = new SpatialIndex(shapes, bounds);
        this.selection.clear();
        this.resize();
        this.requestRender();
    }

    setLayerState(state) {
        this.layerState = state;
        this.requestRender();
    }

    setMarkers(markers) {
        this.markers = markers || [];
        this.requestRender();
    }

    setSelection(ids) {
        this.selection = new Set(ids || []);
        this.requestRender();
    }

    isVisible(shape) {
        const state = this.layerState.get(shape.layer);
        return !state || state.visible !== false;
    }

    /* ---------------- camara ---------------- */

    get size() {
        return { width: this.canvas.clientWidth || 1, height: this.canvas.clientHeight || 1 };
    }

    worldToScreen(x, y) {
        const { width, height } = this.size;
        return {
            x: (x - this.camera.x) * this.camera.scale + width / 2,
            y: height / 2 - (y - this.camera.y) * this.camera.scale
        };
    }

    screenToWorld(x, y) {
        const { width, height } = this.size;
        return {
            x: (x - width / 2) / this.camera.scale + this.camera.x,
            y: this.camera.y - (y - height / 2) / this.camera.scale
        };
    }

    viewportBox(padding = 0) {
        const { width, height } = this.size;
        const a = this.screenToWorld(-padding, height + padding);
        const b = this.screenToWorld(width + padding, -padding);
        return [a.x, a.y, b.x, b.y];
    }

    zoomToFit(box = this.bounds, margin = 0.08) {
        const { width, height } = this.size;
        const w = Math.max(box[2] - box[0], 1e-6);
        const h = Math.max(box[3] - box[1], 1e-6);
        const scale = Math.min(width / w, height / h) * (1 - margin * 2);
        this.camera = {
            x: (box[0] + box[2]) / 2,
            y: (box[1] + box[3]) / 2,
            scale: clamp(scale, MIN_SCALE, MAX_SCALE)
        };
        this.emitCamera();
        this.requestRender();
    }

    centerOn(x, y, scale) {
        this.camera.x = x;
        this.camera.y = y;
        if (scale) this.camera.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
        this.emitCamera();
        this.requestRender();
    }

    focusShape(shape, zoom = true) {
        if (!shape) return;
        const box = shape.bbox;
        const cx = (box[0] + box[2]) / 2;
        const cy = (box[1] + box[3]) / 2;
        if (!zoom) return this.centerOn(cx, cy);
        const span = Math.max(box[2] - box[0], box[3] - box[1]);
        if (span <= 0) return this.centerOn(cx, cy, Math.max(this.camera.scale, 20));
        const { width, height } = this.size;
        const target = (Math.min(width, height) * 0.35) / span;
        this.centerOn(cx, cy, clamp(target, MIN_SCALE, MAX_SCALE));
    }

    zoomBy(factor, anchorX, anchorY) {
        const { width, height } = this.size;
        const ax = anchorX === undefined ? width / 2 : anchorX;
        const ay = anchorY === undefined ? height / 2 : anchorY;
        const before = this.screenToWorld(ax, ay);
        this.camera.scale = clamp(this.camera.scale * factor, MIN_SCALE, MAX_SCALE);
        const after = this.screenToWorld(ax, ay);
        this.camera.x += before.x - after.x;
        this.camera.y += before.y - after.y;
        this.emitCamera();
        this.requestRender();
    }

    emitCamera() {
        if (this.handlers.onCamera) this.handlers.onCamera(this.camera);
    }

    /* ---------------- seleccion ---------------- */

    pickAt(screenX, screenY) {
        if (!this.index) return null;
        const world = this.screenToWorld(screenX, screenY);
        const tolerance = 14 / this.camera.scale;
        return pickShape(this.shapes, this.index, world.x, world.y, tolerance, (s) => this.isVisible(s));
    }

    pickMarkerAt(screenX, screenY) {
        for (let i = this.markers.length - 1; i >= 0; i--) {
            const marker = this.markers[i];
            const p = this.worldToScreen(marker.x, marker.y);
            const offset = marker.kind === 'place' ? 16 : 14;
            if (Math.hypot(p.x - screenX, p.y - (screenY + offset)) <= 18) return marker;
        }
        return null;
    }

    /* ---------------- eventos ---------------- */

    bindEvents() {
        const canvas = this.canvas;
        canvas.style.touchAction = 'none';

        canvas.addEventListener('pointerdown', (e) => {
            canvas.setPointerCapture(e.pointerId);
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, time: Date.now(), moved: false });
            if (this.pointers.size === 1) {
                this.gesture = { type: 'pan', camera: { ...this.camera } };
                this.longPressTimer = setTimeout(() => {
                    const p = this.pointers.get(e.pointerId);
                    if (p && !p.moved && this.handlers.onLongPress) {
                        this.cancelLongPress();
                        this.gesture = null;
                        this.handlers.onLongPress(this.localPoint(p.startX, p.startY));
                    }
                }, LONG_PRESS_MS);
            } else if (this.pointers.size === 2) {
                this.cancelLongPress();
                const [a, b] = [...this.pointers.values()];
                this.gesture = {
                    type: 'pinch',
                    distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                    center: this.localPoint((a.x + b.x) / 2, (a.y + b.y) / 2),
                    scale: this.camera.scale
                };
            }
        });

        canvas.addEventListener('pointermove', (e) => {
            const pointer = this.pointers.get(e.pointerId);
            if (!pointer) {
                if (this.handlers.onHover) this.handlers.onHover(this.localPoint(e.clientX, e.clientY));
                return;
            }
            pointer.x = e.clientX;
            pointer.y = e.clientY;
            if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > TAP_SLOP) {
                pointer.moved = true;
                this.cancelLongPress();
            }

            if (this.pointers.size === 2 && this.gesture && this.gesture.type === 'pinch') {
                const [a, b] = [...this.pointers.values()];
                const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
                const center = this.localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
                const before = this.screenToWorld(center.x, center.y);
                this.camera.scale = clamp((this.gesture.scale * distance) / this.gesture.distance, MIN_SCALE, MAX_SCALE);
                const after = this.screenToWorld(center.x, center.y);
                this.camera.x += before.x - after.x;
                this.camera.y += before.y - after.y;
                // Desplazamiento del centro del pellizco.
                this.camera.x -= (center.x - this.gesture.center.x) / this.camera.scale;
                this.camera.y += (center.y - this.gesture.center.y) / this.camera.scale;
                this.gesture.center = center;
                this.emitCamera();
                this.requestRender();
            } else if (this.gesture && this.gesture.type === 'pan' && pointer.moved) {
                const dx = (pointer.x - pointer.startX) / this.camera.scale;
                const dy = (pointer.y - pointer.startY) / this.camera.scale;
                this.camera.x = this.gesture.camera.x - dx;
                this.camera.y = this.gesture.camera.y + dy;
                this.emitCamera();
                this.requestRender();
            }
        });

        const end = (e) => {
            const pointer = this.pointers.get(e.pointerId);
            this.pointers.delete(e.pointerId);
            this.cancelLongPress();
            if (pointer && !pointer.moved && this.pointers.size === 0 && Date.now() - pointer.time < 900) {
                const local = this.localPoint(pointer.startX, pointer.startY);
                if (this.handlers.onTap) this.handlers.onTap(local, e);
            }
            if (this.pointers.size === 1) {
                const [only] = [...this.pointers.entries()];
                only[1].startX = only[1].x;
                only[1].startY = only[1].y;
                this.gesture = { type: 'pan', camera: { ...this.camera } };
            } else if (this.pointers.size === 0) {
                this.gesture = null;
            }
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const local = this.localPoint(e.clientX, e.clientY);
            const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
            this.zoomBy(Math.exp(-delta * 0.0015), local.x, local.y);
        }, { passive: false });

        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('resize', () => this.resize());
        if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this.resize());
        // El canvas puede nacer oculto (pantalla inicial) o cambiar con el panel.
        if ('ResizeObserver' in window) {
            new ResizeObserver(() => this.resize()).observe(canvas);
        }
    }

    cancelLongPress() {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
    }

    localPoint(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    /* ---------------- dibujo ---------------- */

    resize() {
        const { width, height } = this.size;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const w = Math.max(1, Math.round(width * this.dpr));
        const h = Math.max(1, Math.round(height * this.dpr));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.requestRender();
    }

    requestRender() {
        if (this.dirty) return;
        this.dirty = true;
        requestAnimationFrame(() => {
            this.dirty = false;
            this.render();
        });
    }

    render() {
        const ctx = this.ctx;
        const { width, height } = this.size;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = this.theme.background;
        ctx.fillRect(0, 0, width, height);
        if (!this.shapes.length) return;

        const view = this.viewportBox(40);
        const visible = this.index.query(view);
        const byColor = new Map();
        const texts = [];
        const points = [];
        let drawn = 0;

        for (const i of visible) {
            const shape = this.shapes[i];
            if (!this.isVisible(shape)) continue;
            const box = shape.bbox;
            if (box[2] < view[0] || box[0] > view[2] || box[3] < view[1] || box[1] > view[3]) continue;
            if (++drawn > MAX_DRAWN) break;
            const color = this.colorOf(shape);
            if (shape.kind === 'text') { texts.push(shape); continue; }
            if (shape.kind === 'point') { points.push(shape); continue; }
            let bucket = byColor.get(color);
            if (!bucket) byColor.set(color, (bucket = []));
            bucket.push(shape);
        }

        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.15;
        for (const [color, bucket] of byColor) {
            ctx.strokeStyle = color;
            ctx.beginPath();
            for (const shape of bucket) this.tracePath(ctx, shape);
            ctx.stroke();
            const filled = bucket.filter((s) => s.filled);
            if (filled.length) {
                ctx.fillStyle = color + '55';
                ctx.beginPath();
                for (const shape of filled) this.tracePath(ctx, shape);
                ctx.fill();
            }
        }

        // Puntos
        for (const shape of points) {
            const p = this.worldToScreen(shape.pts[0], shape.pts[1]);
            ctx.fillStyle = this.colorOf(shape);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }

        // Textos (solo si son legibles)
        ctx.textBaseline = 'alphabetic';
        for (const shape of texts) {
            const size = shape.height * this.camera.scale;
            if (size < 5) continue;
            const p = this.worldToScreen(shape.pts[0], shape.pts[1]);
            ctx.save();
            ctx.translate(p.x, p.y);
            if (shape.rotation) ctx.rotate(-shape.rotation);
            ctx.fillStyle = this.colorOf(shape);
            ctx.font = `${Math.min(size, 90).toFixed(1)}px system-ui, sans-serif`;
            ctx.textAlign = shape.align === 1 ? 'center' : shape.align === 2 ? 'right' : 'left';
            const lines = shape.text.split('\n');
            lines.forEach((line, i) => ctx.fillText(line, 0, i * size * 1.25));
            ctx.restore();
        }

        this.drawSelection(ctx);
        this.drawMarkers(ctx);
        this.drawScaleBar(ctx, width, height);
    }

    tracePath(ctx, shape, lod = true) {
        // Transformacion en linea: en planos grandes esto se ejecuta millones
        // de veces por cuadro y conviene no crear objetos intermedios.
        const { width, height } = this.size;
        const scale = this.camera.scale;
        const ox = width / 2 - this.camera.x * scale;
        const oy = height / 2 + this.camera.y * scale;
        const box = shape.bbox;

        if (lod && (box[2] - box[0]) * scale < 2.5 && (box[3] - box[1]) * scale < 2.5) {
            // Figura minuscula en pantalla: basta con marcar su posicion.
            const x = box[0] * scale + ox;
            const y = oy - box[1] * scale;
            ctx.moveTo(x, y);
            ctx.lineTo(x + 1, y);
            return;
        }

        const pts = shape.pts;
        ctx.moveTo(pts[0] * scale + ox, oy - pts[1] * scale);
        for (let i = 2; i < pts.length; i += 2) {
            ctx.lineTo(pts[i] * scale + ox, oy - pts[i + 1] * scale);
        }
    }

    drawSelection(ctx) {
        if (!this.selection.size && !this.highlight) return;
        const ids = new Set(this.selection);
        if (this.highlight) ids.add(this.highlight);
        const targets = [];
        for (const id of ids) {
            const shape = this.byId.get(id);
            if (shape && this.isVisible(shape)) targets.push(shape);
        }
        ctx.save();
        ctx.strokeStyle = this.theme.selection;
        ctx.lineWidth = 3;
        ctx.shadowColor = this.theme.selection;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        for (const shape of targets) {
            if (shape.kind === 'point' || shape.kind === 'text') {
                const p = this.worldToScreen(shape.pts[0], shape.pts[1]);
                ctx.moveTo(p.x + 7, p.y);
                ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
            } else {
                this.tracePath(ctx, shape, false);
            }
        }
        ctx.stroke();
        ctx.restore();
    }

    drawMarkers(ctx) {
        if (!this.markers.length) return;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const marker of this.markers) {
            const p = this.worldToScreen(marker.x, marker.y);
            if (p.x < -40 || p.y < -40 || p.x > this.size.width + 40 || p.y > this.size.height + 40) continue;
            if (marker.kind === 'place') {
                this.drawPlaceMarker(ctx, p, marker);
                continue;
            }
            const y = p.y - 14;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - 5, y + 8);
            ctx.lineTo(p.x + 5, y + 8);
            ctx.closePath();
            ctx.fillStyle = marker.color;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(p.x, y, 12, 0, Math.PI * 2);
            ctx.fillStyle = marker.color;
            ctx.fill();
            ctx.lineWidth = marker.active ? 3 : 1.5;
            ctx.strokeStyle = marker.active ? '#ffffff' : 'rgba(0,0,0,0.45)';
            ctx.stroke();
            ctx.fillStyle = '#0b0f14';
            ctx.font = 'bold 12px system-ui, sans-serif';
            ctx.fillText(marker.label, p.x, y + 1);
        }
        ctx.restore();
    }

    /**
     * Los recursos ubicados en el plano se dibujan como una placa cuadrada con
     * su icono, para no confundirlos con los marcadores redondos de tareas.
     */
    drawPlaceMarker(ctx, p, marker) {
        const y = p.y - 16;
        const half = 13;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - 5, y + half - 1);
        ctx.lineTo(p.x + 5, y + half - 1);
        ctx.closePath();
        ctx.fillStyle = marker.color;
        ctx.fill();

        ctx.beginPath();
        const radius = 6;
        const left = p.x - half;
        const top = y - half;
        const size = half * 2;
        if (ctx.roundRect) ctx.roundRect(left, top, size, size, radius);
        else ctx.rect(left, top, size, size);
        ctx.fillStyle = marker.color;
        ctx.fill();
        ctx.lineWidth = marker.active ? 3 : 1.5;
        ctx.strokeStyle = marker.active ? '#ffffff' : 'rgba(0,0,0,0.45)';
        ctx.stroke();

        ctx.font = '15px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        ctx.fillStyle = '#0b0f14';
        ctx.fillText(marker.label, p.x, y + 1);

        // Cuando hay mas de un recurso en el mismo punto se indica la cantidad.
        if (marker.badge) {
            ctx.beginPath();
            ctx.arc(p.x + half - 2, top + 2, 8, 0, Math.PI * 2);
            ctx.fillStyle = '#0b0f14';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = marker.color;
            ctx.stroke();
            ctx.fillStyle = '#e6edf5';
            ctx.font = 'bold 10px system-ui, sans-serif';
            ctx.fillText(marker.badge, p.x + half - 2, top + 3);
        }
    }

    drawScaleBar(ctx, width, height) {
        const target = Math.min(160, width * 0.3);
        const worldLength = target / this.camera.scale;
        const magnitude = Math.pow(10, Math.floor(Math.log10(worldLength)));
        const steps = [1, 2, 5, 10];
        let nice = magnitude;
        for (const step of steps) {
            if (magnitude * step <= worldLength) nice = magnitude * step;
        }
        const px = nice * this.camera.scale;
        const x = 16;
        const y = height - 18;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y);
        ctx.lineTo(x + px, y);
        ctx.lineTo(x + px, y - 5);
        ctx.stroke();
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(formatNumber(nice), x, y - 8);
        ctx.restore();
    }

    colorOf(shape) {
        if (this.selection.has(shape.id)) return this.theme.selection;
        const state = this.layerState.get(shape.layer);
        if (state && state.color) return state.color;
        return this.theme.defaultStroke;
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

export function formatNumber(value) {
    if (!Number.isFinite(value)) return '-';
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(1);
    if (abs >= 1) return value.toFixed(2);
    return value.toPrecision(3);
}

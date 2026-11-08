/**
 * Microscope renderer.
 *
 * WebGL2 path: the planar frame (8 × W×H bytes) is uploaded verbatim as a single
 * R8 texture of size W × 8H. The same texture is bound to two units through two
 * sampler objects: NEAREST for discrete per-cell data (state, energy, lineage) and
 * LINEAR for continuous fields (food nebula, signal ripples). A fragment shader
 * composites the four visual layers with user blend weights, on an infinitely
 * wrapping torus, at display refresh rate independent of the simulation tick rate.
 *
 * Canvas2D fallback: CPU composite at cell resolution, then scaled blit.
 */
import { LAYER_COUNT } from '../../engine/protocol';

export interface Camera {
  cx: number; // world centre (cells)
  cy: number;
  zoom: number; // CSS px per cell
}

export interface Brush {
  x: number;
  y: number;
  radius: number; // cells, < 0 hides
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uNear;
uniform sampler2D uLin;
uniform vec2 uGrid;
uniform vec2 uView;
uniform vec2 uCam;
uniform float uZoom;
uniform vec4 uLayers;
uniform float uTime;
uniform vec3 uBrush;
out vec4 outColor;

const float NL = ${LAYER_COUNT}.0;

float nearL(int layer, ivec2 c) {
  ivec2 g = ivec2(uGrid);
  c = ivec2((c.x % g.x + g.x) % g.x, (c.y % g.y + g.y) % g.y);
  return texelFetch(uNear, ivec2(c.x, c.y + layer * g.y), 0).r;
}
float linL(int layer, vec2 p) {
  // Texel centres sit at (i + 0.5); clamp inside this layer's band so bands never bleed.
  float y = clamp(p.y, 0.5, uGrid.y - 0.5);
  vec2 uv = vec2(p.x / uGrid.x, (y + float(layer) * uGrid.y) / (uGrid.y * NL));
  return texture(uLin, uv).r;
}
int stateAt(ivec2 c) { return int(nearL(0, c) * 255.0 + 0.5); }

vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
// Compact polynomial "turbo"-like ramp for phylogenetic distance.
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(1.0, 0.86, 0.45);   // ancestor: pale gold
  vec3 b = vec3(0.25, 0.95, 0.55);  // close: green
  vec3 c = vec3(0.2, 0.65, 1.0);    // mid: azure
  vec3 d = vec3(0.75, 0.3, 1.0);    // far: violet
  vec3 e = vec3(1.0, 0.25, 0.45);   // alien: rose
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);
  vec2 world = (frag - 0.5 * uView) / uZoom + uCam;
  vec2 p = mod(world, uGrid);
  ivec2 c = ivec2(floor(p));
  vec2 f = fract(p);

  int st = stateAt(c);
  int soma = st & 3;
  bool wall = (st & 4) != 0;
  bool damaged = (st & 8) != 0;
  bool starving = (st & 16) != 0;
  bool born = (st & 32) != 0;
  float energy = nearL(1, c);
  float food = linL(2, p);
  float sa = linL(3, p);
  float sb = linL(4, p);
  float flux = (nearL(5, c) * 255.0 - 128.0) / 127.0;
  float hue = nearL(6, c);
  float dist = nearL(7, c) * 255.0 / 4.0;

  // Membrane detection: which sides border a different tissue type or the void.
  float px = 1.0 / uZoom;
  float edgeW = clamp(1.4 * px, 0.04, 0.22);
  float edge = 0.0;
  if (soma != 0 && uZoom > 2.5) {
    if ((stateAt(c + ivec2(1, 0)) & 3) != soma && f.x > 1.0 - edgeW) edge = 1.0;
    if ((stateAt(c - ivec2(1, 0)) & 3) != soma && f.x < edgeW) edge = 1.0;
    if ((stateAt(c + ivec2(0, 1)) & 3) != soma && f.y > 1.0 - edgeW) edge = 1.0;
    if ((stateAt(c - ivec2(0, 1)) & 3) != soma && f.y < edgeW) edge = 1.0;
  }
  float zoomDetail = smoothstep(3.0, 8.0, uZoom);
  float r = length(f - 0.5);

  // ---------------- Layer 1: Composite Bio-View -------------------------------
  vec3 bg = vec3(0.006, 0.012, 0.03);
  float neb = pow(food, 1.35);
  float shimmer = 0.85 + 0.15 * sin(uTime * 0.7 + p.x * 0.13 + p.y * 0.09) * sin(uTime * 0.43 - p.y * 0.17);
  bg += vec3(0.03, 0.62, 0.42) * neb * 0.75 * shimmer + vec3(0.1, 0.9, 0.7) * pow(food, 4.0) * 0.25;
  vec3 bio = bg;
  if (wall) {
    float hatch = step(0.5, fract((p.x + p.y) * 0.5));
    bio = mix(vec3(0.16, 0.19, 0.25), vec3(0.24, 0.28, 0.36), hatch);
  } else if (soma != 0) {
    vec3 base = hsv(hue, 0.68, 1.0);
    float bright = 0.22 + 0.78 * energy;
    vec3 col;
    if (soma == 1) {
      col = base * bright;
      col *= 1.0 - 0.25 * zoomDetail * smoothstep(0.2, 0.5, r);
    } else if (soma == 2) {
      col = mix(base * 0.4, vec3(0.7, 0.76, 0.88), 0.35) * (0.45 + 0.55 * energy);
      edge = max(edge, zoomDetail * step(0.36, max(abs(f.x - 0.5), abs(f.y - 0.5))));
    } else {
      float pulse = 0.75 + 0.25 * sin(uTime * 5.0 + float(c.x * 7 + c.y * 13));
      col = mix(base, vec3(1.0), 0.25) * bright * 1.1;
      col += zoomDetail * smoothstep(0.22, 0.08, r) * vec3(1.0, 0.95, 0.8) * pulse * 0.8;
    }
    if (damaged) col = mix(col, vec3(1.0, 0.18, 0.2), 0.35 + 0.25 * sin(uTime * 12.0));
    if (born) col += vec3(0.25);
    vec3 membrane = soma == 2 ? vec3(0.85, 0.9, 1.0) : soma == 3 ? base * 1.4 + 0.2 : col * 0.35;
    bio = mix(col, membrane, edge);
  }

  // ---------------- Layer 2: Neural / Signal ---------------------------------
  vec3 neural = vec3(0.004, 0.006, 0.016);
  if (soma != 0) neural += hsv(hue, 0.4, 0.07 + 0.05 * energy) + edge * 0.05;
  if (wall) neural = vec3(0.06, 0.07, 0.09);
  float ripA = 0.7 + 0.3 * sin(uTime * 7.0 - sa * 22.0);
  float ripB = 0.65 + 0.35 * sin(uTime * 11.0 - sb * 30.0);
  neural += vec3(0.1, 0.85, 1.0) * pow(sa, 0.75) * ripA * 1.15;
  neural += vec3(1.0, 0.2, 0.7) * pow(sb, 0.75) * ripB * 1.1;
  neural += vec3(0.6, 0.9, 1.0) * pow(sa * sb, 0.5) * 0.4;

  // ---------------- Layer 3: Thermodynamic heatmap ----------------------------
  vec3 thermo = vec3(0.02, 0.018, 0.03) + vec3(0.32, 0.16, 0.04) * pow(food, 1.5) * 0.35;
  if (wall) thermo = vec3(0.08, 0.08, 0.1);
  if (soma != 0) {
    vec3 crimson = vec3(0.95, 0.07, 0.16);
    vec3 cyan = vec3(0.08, 0.9, 1.0);
    vec3 col = mix(crimson, cyan, smoothstep(0.12, 0.75, energy)) * (0.35 + 0.65 * abs(energy * 2.0 - 1.0) + 0.2);
    float fl = clamp(flux * 2.5, -1.0, 1.0);
    col += fl > 0.0 ? cyan * fl * 0.6 : vec3(1.0, 0.45, 0.05) * (-fl) * 0.8; // entropic bleed = amber
    if (starving) col = mix(col, crimson, 0.5 + 0.3 * sin(uTime * 6.0));
    thermo = mix(col, col * 0.4, edge);
  }

  // ---------------- Layer 4: Lineage & Speciation X-Ray ------------------------
  vec3 lineage = vec3(0.01, 0.01, 0.02);
  if (wall) lineage = vec3(0.07, 0.07, 0.09);
  if (soma != 0) {
    vec3 col = ramp(dist / 18.0) * (0.55 + 0.45 * energy);
    lineage = mix(col, col * 0.3, edge);
  }

  float wsum = uLayers.x + uLayers.y + uLayers.z + uLayers.w;
  vec3 color = wsum > 0.001
    ? (bio * uLayers.x + neural * uLayers.y + thermo * uLayers.z + lineage * uLayers.w) / wsum
    : bio;

  // Faint lattice at high magnification.
  if (uZoom > 14.0) {
    vec2 g = min(f, 1.0 - f);
    color += vec3(0.04) * (1.0 - smoothstep(0.0, 1.2 * px, min(g.x, g.y))) * smoothstep(14.0, 24.0, uZoom);
  }

  // Brush ring (wrap-aware).
  if (uBrush.z >= 0.0) {
    vec2 d = abs(p - uBrush.xy);
    d = min(d, uGrid - d);
    float rr = length(d);
    float ring = 1.0 - smoothstep(0.0, 1.5 * px, abs(rr - (uBrush.z + 0.5)));
    color = mix(color, vec3(0.9, 0.95, 1.0), ring * 0.7);
  }

  outColor = vec4(pow(color, vec3(0.92)), 1.0);
}`;

export interface Renderer {
  readonly kind: 'webgl2' | 'canvas2d';
  setFrame(data: Uint8Array, width: number, height: number): void;
  draw(cam: Camera, layers: [number, number, number, number], brush: Brush | null, time: number): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  dispose(): void;
}

class WebGLRenderer implements Renderer {
  readonly kind = 'webgl2' as const;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private sNear: WebGLSampler;
  private sLin: WebGLSampler;
  private vao: WebGLVertexArrayObject;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private texW = 0;
  private texH = 0;
  private pending: Uint8Array | null = null;
  private gridW = 256;
  private gridH = 256;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
    this.prog = prog;
    for (const n of ['uNear', 'uLin', 'uGrid', 'uView', 'uCam', 'uZoom', 'uLayers', 'uTime', 'uBrush']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.sNear = gl.createSampler()!;
    gl.samplerParameteri(this.sNear, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(this.sNear, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.sLin = gl.createSampler()!;
    gl.samplerParameteri(this.sLin, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.sLin, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.samplerParameteri(this.sLin, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.samplerParameteri(this.sLin, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  setFrame(data: Uint8Array, width: number, height: number): void {
    this.pending = data;
    this.gridW = width;
    this.gridH = height;
  }

  private upload(): void {
    const gl = this.gl;
    const data = this.pending;
    if (!data) return;
    this.pending = null;
    const w = this.gridW;
    const h = this.gridH * LAYER_COUNT;
    if (data.length < w * h) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (w !== this.texW || h !== this.texH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
      this.texW = w;
      this.texH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    }
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(cam: Camera, layers: [number, number, number, number], brush: Brush | null, time: number): void {
    const gl = this.gl;
    this.upload();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!this.texW) {
      gl.clearColor(0.006, 0.012, 0.03, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindSampler(0, this.sNear);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindSampler(1, this.sLin);
    gl.uniform1i(this.u.uNear, 0);
    gl.uniform1i(this.u.uLin, 1);
    gl.uniform2f(this.u.uGrid, this.gridW, this.gridH);
    gl.uniform2f(this.u.uView, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.uCam, cam.cx, cam.cy);
    gl.uniform1f(this.u.uZoom, cam.zoom * this.dpr);
    gl.uniform4f(this.u.uLayers, layers[0], layers[1], layers[2], layers[3]);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform3f(this.u.uBrush, brush?.x ?? 0, brush?.y ?? 0, brush ? brush.radius : -1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.prog);
    gl.deleteSampler(this.sNear);
    gl.deleteSampler(this.sLin);
  }
}

/** CPU fallback for devices without WebGL2. */
class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  private ctx: CanvasRenderingContext2D;
  private off: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private data: Uint8Array | null = null;
  private gw = 0;
  private gh = 0;
  private dirty = false;
  private dpr = 1;
  private lastLayers = '';

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d')!;
  }

  setFrame(data: Uint8Array, width: number, height: number): void {
    this.data = data;
    if (width !== this.gw || height !== this.gh) {
      this.gw = width;
      this.gh = height;
      this.off.width = width;
      this.off.height = height;
      this.img = this.offCtx.createImageData(width, height);
    }
    this.dirty = true;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
  }

  private composite(layers: [number, number, number, number]): void {
    const d = this.data;
    const img = this.img;
    if (!d || !img) return;
    const N = this.gw * this.gh;
    const px = img.data;
    const ws = layers[0] + layers[1] + layers[2] + layers[3] || 1;
    for (let i = 0; i < N; i++) {
      const st = d[i];
      const soma = st & 3;
      const e = d[N + i] / 255;
      const food = d[2 * N + i] / 255;
      const sa = d[3 * N + i] / 255;
      const sb = d[4 * N + i] / 255;
      const hue = d[6 * N + i] / 255;
      const dist = d[7 * N + i] / 4;
      let r = 0, g = 0, b = 0;
      // bio
      if (layers[0]) {
        let cr = 2, cg = 3 + food * 160, cb = 8 + food * 108;
        if (st & 4) { cr = 50; cg = 58; cb = 74; } else if (soma) {
          const h6 = hue * 6, k = (n: number) => Math.min(1, Math.max(0, Math.abs(((h6 + n) % 6) - 3) - 1));
          const v = (0.22 + 0.78 * e) * 255;
          cr = v * (1 - 0.68 + 0.68 * k(0)); cg = v * (1 - 0.68 + 0.68 * k(4)); cb = v * (1 - 0.68 + 0.68 * k(2));
          if (soma === 2) { cr = cr * 0.5 + 70; cg = cg * 0.5 + 75; cb = cb * 0.5 + 90; }
        }
        r += cr * layers[0]; g += cg * layers[0]; b += cb * layers[0];
      }
      if (layers[1]) {
        const base = soma ? 18 : 2;
        r += (base + sa * 25 + sb * 255) * layers[1];
        g += (base + sa * 215 + sb * 50) * layers[1];
        b += (base + 6 + sa * 255 + sb * 180) * layers[1];
      }
      if (layers[2]) {
        let cr = 5 + food * 30, cg = 4 + food * 15, cb = 8;
        if (soma) { const t = Math.min(1, Math.max(0, (e - 0.12) / 0.63)); cr = 242 * (1 - t) + 20 * t; cg = 18 * (1 - t) + 230 * t; cb = 40 * (1 - t) + 255 * t; }
        r += cr * layers[2]; g += cg * layers[2]; b += cb * layers[2];
      }
      if (layers[3]) {
        let cr = 3, cg = 3, cb = 5;
        if (soma) { const t = Math.min(1, dist / 18); cr = 255 * (1 - t) + 190 * t; cg = 220 * (1 - t) + 76 * t; cb = 115 * (1 - t) + 255 * t; }
        r += cr * layers[3]; g += cg * layers[3]; b += cb * layers[3];
      }
      const o = i * 4;
      px[o] = r / ws; px[o + 1] = g / ws; px[o + 2] = b / ws; px[o + 3] = 255;
    }
    this.offCtx.putImageData(img, 0, 0);
  }

  draw(cam: Camera, layers: [number, number, number, number], brush: Brush | null): void {
    const key = layers.join(',');
    if (this.dirty || key !== this.lastLayers) {
      this.composite(layers);
      this.dirty = false;
      this.lastLayers = key;
    }
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.fillStyle = '#02030a';
    ctx.fillRect(0, 0, W, H);
    if (!this.gw) return;
    const z = cam.zoom * this.dpr;
    ctx.imageSmoothingEnabled = false;
    const ox = W / 2 - cam.cx * z;
    const oy = H / 2 - cam.cy * z;
    const tw = this.gw * z;
    const th = this.gh * z;
    const sx = Math.floor(-ox / tw);
    const sy = Math.floor(-oy / th);
    for (let ty = sy; ty * th + oy < H; ty++) {
      for (let tx = sx; tx * tw + ox < W; tx++) ctx.drawImage(this.off, ox + tx * tw, oy + ty * th, tw, th);
    }
    if (brush && brush.radius >= 0) {
      ctx.strokeStyle = 'rgba(230,240,255,0.7)';
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      ctx.arc(ox + (brush.x + 0.5) * z, oy + (brush.y + 0.5) * z, (brush.radius + 0.5) * z, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  dispose(): void {}
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (gl) {
    try {
      return new WebGLRenderer(canvas, gl);
    } catch (err) {
      console.warn('[TuringLife] WebGL2 init failed, falling back to Canvas2D', err);
    }
  }
  return new Canvas2DRenderer(canvas);
}

/**
 * Volumetric renderer for the 3D world (WebGL2).
 *
 * The planar frame (8 layers × W×H×D bytes) is uploaded as eight R8 3D textures, one per
 * layer, straight from subarrays of the frame (no CPU repacking). A full-screen fragment
 * shader casts one ray per pixel into the world box and walks it voxel by voxel (Amanatides–
 * Woo DDA). Along the way it integrates the food field as an emissive nebula, and shades the
 * first living cells it meets as bevelled cubes. In the Neural layer cells turn translucent so
 * signal waves can be followed through whole bodies. Resolution adapts to hold the frame rate.
 */
import { LAYER, LAYER_COUNT } from '../../engine/protocol';

export interface Camera3D {
  /** Orbit target (world cells). */
  tx: number;
  ty: number;
  tz: number;
  yaw: number;
  pitch: number;
  dist: number;
  /** Vertical field of view, radians. */
  fov: number;
}

export interface Brush3D {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface CameraBasis {
  pos: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  fwd: [number, number, number];
}

export function cameraBasis(c: Camera3D): CameraBasis {
  const cp = Math.cos(c.pitch);
  const fwd: [number, number, number] = [-Math.sin(c.yaw) * cp, -Math.sin(c.pitch), -Math.cos(c.yaw) * cp];
  const pos: [number, number, number] = [c.tx - fwd[0] * c.dist, c.ty - fwd[1] * c.dist, c.tz - fwd[2] * c.dist];
  // right = normalize(fwd × worldUp), up = right × fwd  (world up = +y)
  let rx = -fwd[2];
  let rz = fwd[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const right: [number, number, number] = [rx, 0, rz];
  const up: [number, number, number] = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  return { pos, right, up, fwd };
}

/** Ray for a CSS-pixel position. */
export function screenRay(c: Camera3D, sx: number, sy: number, w: number, h: number) {
  const b = cameraBasis(c);
  const t = Math.tan(c.fov / 2);
  const nx = ((sx / w) * 2 - 1) * t * (w / h);
  const ny = (1 - (sy / h) * 2) * t;
  const d = [0, 1, 2].map((k) => b.fwd[k] + b.right[k] * nx + b.up[k] * ny);
  const l = Math.hypot(d[0], d[1], d[2]);
  return { o: b.pos, d: [d[0] / l, d[1] / l, d[2] / l] as [number, number, number] };
}

/**
 * CPU pick: walks the same DDA through the state layer and returns the first living cell or
 * wall the ray meets, or — in empty space — the point where the ray crosses the plane through
 * the orbit target, clamped into the world.
 */
export function pickVoxel(frame: Uint8Array, W: number, H: number, D: number, c: Camera3D, sx: number, sy: number, vw: number, vh: number) {
  const { o, d } = screenRay(c, sx, sy, vw, vh);
  const G = [W, H, D];
  let t0 = 0;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      if (o[k] < 0 || o[k] > G[k]) return null;
      continue;
    }
    let a = (0 - o[k]) / d[k];
    let b = (G[k] - o[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
  }
  const fallback = () => {
    const b = cameraBasis(c);
    const denom = d[0] * b.fwd[0] + d[1] * b.fwd[1] + d[2] * b.fwd[2];
    const tp = denom > 1e-6 ? c.dist / denom : c.dist;
    const p = [0, 1, 2].map((k) => Math.min(G[k] - 1, Math.max(0, Math.floor(o[k] + d[k] * tp))));
    return { x: p[0], y: p[1], z: p[2], hit: false };
  };
  if (t0 > t1) return fallback();
  const t = t0 + 1e-4;
  const v = [0, 1, 2].map((k) => Math.min(G[k] - 1, Math.max(0, Math.floor(o[k] + d[k] * t))));
  const step = d.map((x) => (x > 0 ? 1 : -1));
  const tMax = [0, 1, 2].map((k) => (Math.abs(d[k]) < 1e-9 ? Infinity : ((v[k] + (step[k] > 0 ? 1 : 0)) - o[k]) / d[k]));
  const tDelta = d.map((x) => (Math.abs(x) < 1e-9 ? Infinity : Math.abs(1 / x)));
  for (let i = 0; i < W + H + D + 3; i++) {
    const s = frame[(v[2] * H + v[1]) * W + v[0]];
    if ((s & 3) !== 0 || (s & 4) !== 0) return { x: v[0], y: v[1], z: v[2], hit: true };
    const k = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    v[k] += step[k];
    if (v[k] < 0 || v[k] >= G[k]) break;
    tMax[k] += tDelta[k];
  }
  return fallback();
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler3D uState, uEnergy, uFood, uSigA, uSigB, uFlux, uHue, uDist;
uniform vec3 uGrid;
uniform vec2 uView;
uniform vec3 uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalf;
uniform vec4 uLayers;
uniform float uTime;
uniform vec4 uBrush;   // xyz centre, w radius (< 0 hidden)
uniform vec4 uSel;     // xyz selected cell centre, w > 0 visible
out vec4 outColor;

vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(1.0, 0.86, 0.45), b = vec3(0.25, 0.95, 0.55), c = vec3(0.2, 0.65, 1.0), d = vec3(0.75, 0.3, 1.0), e = vec3(1.0, 0.25, 0.45);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 background(vec3 d) {
  vec3 col = mix(vec3(0.004, 0.006, 0.016), vec3(0.012, 0.02, 0.05), 0.5 + 0.5 * d.y);
  // Sparse, fixed starfield on the view sphere.
  vec2 sp = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0))) * 120.0;
  vec2 cell = floor(sp);
  float h = hash(cell);
  if (h > 0.985) {
    vec2 f = fract(sp) - 0.5;
    col += vec3(0.6, 0.7, 0.9) * (h - 0.985) * 40.0 * smoothstep(0.25, 0.0, length(f));
  }
  return col;
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uView) * 2.0 - 1.0;
  vec3 dir = normalize(uCamFwd + uCamRight * ndc.x * uTanHalf * (uView.x / uView.y) + uCamUp * ndc.y * uTanHalf);
  vec3 ro = uCamPos;
  float wsum = max(0.001, uLayers.x + uLayers.y + uLayers.z + uLayers.w);
  vec4 Lw = uLayers / wsum;

  // ---- ray / box ----
  vec3 inv = 1.0 / dir;
  vec3 ta = (vec3(0.0) - ro) * inv;
  vec3 tb = (uGrid - ro) * inv;
  vec3 tmin3 = min(ta, tb);
  vec3 tmax3 = max(ta, tb);
  float tNear = max(max(tmin3.x, tmin3.y), max(tmin3.z, 0.0));
  float tFar = min(min(tmax3.x, tmax3.y), tmax3.z);

  vec3 col = vec3(0.0);
  float trans = 1.0;
  float pixAngle = 2.0 * uTanHalf / uView.y;

  if (tNear < tFar) {
    float tCur = tNear + 1e-4;
    vec3 p = ro + dir * tCur;
    ivec3 G = ivec3(uGrid);
    ivec3 v = clamp(ivec3(floor(p)), ivec3(0), G - 1);
    ivec3 stp = ivec3(sign(dir));
    vec3 tDelta = abs(inv);
    vec3 tMax = (vec3(v) + max(vec3(stp), 0.0) - ro) * inv;
    // Entry face axis for the very first voxel.
    int axis = tmin3.x > tmin3.y ? (tmin3.x > tmin3.z ? 0 : 2) : (tmin3.y > tmin3.z ? 1 : 2);

    // Nebula tint per layer.
    vec3 nebBio = vec3(0.03, 0.62, 0.42);
    vec3 nebThermo = vec3(0.32, 0.16, 0.04);
    vec3 neb = nebBio * (Lw.x + Lw.y * 0.35 + Lw.w * 0.2) + nebThermo * Lw.z;

    int maxSteps = G.x + G.y + G.z + 2;
    for (int i = 0; i < 1024; i++) {
      if (i >= maxSteps) break;
      float tNext = min(min(tMax.x, tMax.y), tMax.z);
      float seg = max(0.0, tNext - tCur);
      vec3 vc = (vec3(v) + 0.5) / uGrid;
      int st = int(texture(uState, vc).r * 255.0 + 0.5);
      int soma = st & 3;
      bool wall = (st & 4) != 0;

      // Food nebula: emission sampled (trilinear) at the segment midpoint.
      vec3 pm = (ro + dir * (tCur + tNext) * 0.5) / uGrid;
      float f = texture(uFood, pm).r;
      float dens = f * f * 1.4 + pow(f, 5.0) * 2.0;
      col += trans * neb * dens * seg * 0.11;
      trans *= exp(-dens * seg * 0.012);

      if (soma != 0 || wall) {
        vec3 n = vec3(0.0);
        n[axis] = -float(stp[axis]);
        vec3 hp = ro + dir * tCur;
        vec3 fr = fract(hp);
        vec2 uv = axis == 0 ? fr.yz : axis == 1 ? fr.xz : fr.xy;
        float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        float edgeW = clamp(tCur * pixAngle * 1.2, 0.035, 0.22);
        float edge = 1.0 - smoothstep(edgeW * 0.5, edgeW, e);
        float light = 0.42 + 0.58 * max(dot(n, -dir), 0.0) + 0.12 * max(dot(n, normalize(vec3(0.4, 0.9, 0.2))), 0.0);

        vec3 cell;
        float alpha;
        if (wall) {
          cell = vec3(0.2, 0.23, 0.3) * light;
          cell = mix(cell, cell * 0.5, edge);
          alpha = 1.0;
        } else {
          float energy = texture(uEnergy, vc).r;
          float hue = texture(uHue, vc).r;
          float sa = texture(uSigA, vc).r;
          float sb = texture(uSigB, vc).r;
          float flux = (texture(uFlux, vc).r * 255.0 - 128.0) / 127.0;
          float dist = texture(uDist, vc).r * 255.0 / 4.0;
          bool damaged = (st & 8) != 0;
          bool starving = (st & 16) != 0;
          bool born = (st & 32) != 0;
          vec3 base = hsv(hue, 0.68, 1.0);
          float bright = 0.22 + 0.78 * energy;

          // Layer 1: bio
          vec3 bio;
          if (soma == 1) bio = base * bright;
          else if (soma == 2) bio = mix(base * 0.4, vec3(0.7, 0.76, 0.88), 0.35) * (0.45 + 0.55 * energy);
          else {
            float pulse = 0.75 + 0.25 * sin(uTime * 5.0 + float(v.x * 7 + v.y * 13 + v.z * 5));
            bio = mix(base, vec3(1.0), 0.25) * bright * 1.15 + vec3(1.0, 0.95, 0.8) * 0.25 * pulse * (1.0 - edge);
          }
          if (damaged) bio = mix(bio, vec3(1.0, 0.18, 0.2), 0.35 + 0.25 * sin(uTime * 12.0));
          if (born) bio += vec3(0.25);
          bio *= light;
          bio = mix(bio, soma == 2 ? vec3(0.85, 0.9, 1.0) * light : bio * 0.35, edge);

          // Layer 2: neural (translucent tissue, glowing waves)
          vec3 neural = hsv(hue, 0.4, 0.08 + 0.05 * energy)
            + vec3(0.1, 0.85, 1.0) * pow(sa, 0.75) * (0.7 + 0.3 * sin(uTime * 7.0 - sa * 22.0)) * 1.2
            + vec3(1.0, 0.2, 0.7) * pow(sb, 0.75) * (0.65 + 0.35 * sin(uTime * 11.0 - sb * 30.0)) * 1.2;

          // Layer 3: thermodynamic
          vec3 thermo = mix(vec3(0.95, 0.07, 0.16), vec3(0.08, 0.9, 1.0), smoothstep(0.12, 0.75, energy)) * (0.35 + 0.65 * abs(energy * 2.0 - 1.0) + 0.2);
          float fl = clamp(flux * 2.5, -1.0, 1.0);
          thermo += fl > 0.0 ? vec3(0.08, 0.9, 1.0) * fl * 0.6 : vec3(1.0, 0.45, 0.05) * (-fl) * 0.8;
          if (starving) thermo = mix(thermo, vec3(0.95, 0.07, 0.16), 0.5 + 0.3 * sin(uTime * 6.0));
          thermo = mix(thermo * light, thermo * 0.4, edge);

          // Layer 4: lineage
          vec3 lineage = ramp(dist / 18.0) * (0.55 + 0.45 * energy) * light;
          lineage = mix(lineage, lineage * 0.3, edge);

          cell = bio * Lw.x + neural * Lw.y + thermo * Lw.z + lineage * Lw.w;
          alpha = 0.95 * (Lw.x + Lw.z + Lw.w) + 0.28 * Lw.y;
        }
        col += trans * alpha * cell;
        trans *= 1.0 - alpha;
        if (trans < 0.02) break;
      }

      // Advance to the next voxel.
      axis = tMax.x < tMax.y ? (tMax.x < tMax.z ? 0 : 2) : (tMax.y < tMax.z ? 1 : 2);
      v[axis] += stp[axis];
      if (v[axis] < 0 || v[axis] >= G[axis]) break;
      tCur = tMax[axis];
      tMax[axis] += tDelta[axis];
    }

    // Faint outline of the world box (where entry or exit lies on an edge).
    vec3 pe = ro + dir * tNear;
    vec3 px = ro + dir * tFar;
    float w0 = max(0.12, tNear * pixAngle * 1.5);
    float w1 = max(0.12, tFar * pixAngle * 1.5);
    vec3 ea = step(pe, vec3(w0)) + step(uGrid - w0, pe);
    vec3 eb = step(px, vec3(w1)) + step(uGrid - w1, px);
    float edgeA = step(1.5, ea.x + ea.y + ea.z);
    float edgeB = step(1.5, eb.x + eb.y + eb.z);
    col += vec3(0.25, 0.32, 0.45) * (edgeA * 0.5 + edgeB * 0.18 * trans);
  }
  col += trans * background(dir);

  // Brush sphere and selection: rim glow where the ray grazes the sphere surface.
  for (int k = 0; k < 2; k++) {
    vec4 s = k == 0 ? uBrush : vec4(uSel.xyz, uSel.w > 0.0 ? 1.1 : -1.0);
    if (s.w < 0.0) continue;
    vec3 oc = s.xyz - ro;
    float tc = dot(oc, dir);
    if (tc <= 0.0) continue;
    float d = length(oc - dir * tc);
    float r = s.w + 0.5;
    float rim = 1.0 - smoothstep(0.0, max(0.15, tc * pixAngle * 2.0), abs(d - r));
    float fill = d < r ? 0.06 : 0.0;
    col = mix(col, k == 0 ? vec3(0.9, 0.95, 1.0) : vec3(1.0, 0.85, 0.3), rim * 0.65 + fill);
  }

  outColor = vec4(pow(col, vec3(0.92)), 1.0);
}`;

const SAMPLERS = ['uState', 'uEnergy', 'uFood', 'uSigA', 'uSigB', 'uFlux', 'uHue', 'uDist'] as const;
/** Which frame layer feeds each sampler, and whether it is filtered (continuous fields). */
const LAYER_OF = [LAYER.STATE, LAYER.ENERGY, LAYER.FOOD, LAYER.SIGNAL_A, LAYER.SIGNAL_B, LAYER.FLUX, LAYER.HUE, LAYER.DISTANCE];
const LINEAR = [false, false, true, false, false, false, false, false];

export class Renderer3D {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private tex: WebGLTexture[] = [];
  private u: Record<string, WebGLUniformLocation | null> = {};
  private dims = [0, 0, 0];
  private pending: Uint8Array | null = null;
  private pendingDims = [0, 0, 0];
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  /** Fraction of device resolution actually rendered; adapted to frame time. */
  scale = 0.75;
  private frameMs = 16;
  private lastDraw = 0;
  private lastAdapt = 0;

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
    for (const n of [...SAMPLERS, 'uGrid', 'uView', 'uCamPos', 'uCamRight', 'uCamUp', 'uCamFwd', 'uTanHalf', 'uLayers', 'uTime', 'uBrush', 'uSel']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let k = 0; k < SAMPLERS.length; k++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_3D, t);
      const filter = LINEAR[k] ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
      // The world is a 3-torus, so filtered fields wrap seamlessly.
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
      this.tex.push(t);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (matchMedia('(pointer: coarse)').matches) this.scale = 0.5;
  }

  setFrame(data: Uint8Array, W: number, H: number, D: number): void {
    this.pending = data;
    this.pendingDims = [W, H, D];
  }

  private upload(): void {
    const data = this.pending;
    if (!data) return;
    this.pending = null;
    const gl = this.gl;
    const [W, H, D] = this.pendingDims;
    const N = W * H * D;
    if (data.length < N * LAYER_COUNT) return;
    const realloc = W !== this.dims[0] || H !== this.dims[1] || D !== this.dims[2];
    for (let k = 0; k < SAMPLERS.length; k++) {
      gl.bindTexture(gl.TEXTURE_3D, this.tex[k]);
      const plane = data.subarray(LAYER_OF[k] * N, (LAYER_OF[k] + 1) * N);
      if (realloc) gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, W, H, D, 0, gl.RED, gl.UNSIGNED_BYTE, plane);
      else gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, W, H, D, gl.RED, gl.UNSIGNED_BYTE, plane);
    }
    this.dims = [W, H, D];
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.applySize();
  }

  private applySize(): void {
    const w = Math.max(1, Math.round(this.cssW * this.dpr * this.scale));
    const h = Math.max(1, Math.round(this.cssH * this.dpr * this.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Dynamic resolution: trade pixels for frame rate, between 35 % and 100 % of device pixels. */
  private adapt(now: number): void {
    if (this.lastDraw) this.frameMs = this.frameMs * 0.9 + Math.min(100, now - this.lastDraw) * 0.1;
    this.lastDraw = now;
    if (now - this.lastAdapt < 700) return;
    this.lastAdapt = now;
    const before = this.scale;
    if (this.frameMs > 24) this.scale = Math.max(0.35, this.scale - 0.1);
    else if (this.frameMs < 13 && this.scale < 1) this.scale = Math.min(1, this.scale + 0.05);
    if (this.scale !== before) this.applySize();
  }

  draw(cam: Camera3D, layers: [number, number, number, number], brush: Brush3D | null, sel: { x: number; y: number; z: number } | null, time: number): void {
    const gl = this.gl;
    this.adapt(performance.now());
    this.upload();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!this.dims[0]) {
      gl.clearColor(0.004, 0.006, 0.016, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    for (let k = 0; k < SAMPLERS.length; k++) {
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_3D, this.tex[k]);
      gl.uniform1i(this.u[SAMPLERS[k]], k);
    }
    const b = cameraBasis(cam);
    gl.uniform3f(this.u.uGrid, this.dims[0], this.dims[1], this.dims[2]);
    gl.uniform2f(this.u.uView, this.canvas.width, this.canvas.height);
    gl.uniform3f(this.u.uCamPos, ...b.pos);
    gl.uniform3f(this.u.uCamRight, ...b.right);
    gl.uniform3f(this.u.uCamUp, ...b.up);
    gl.uniform3f(this.u.uCamFwd, ...b.fwd);
    gl.uniform1f(this.u.uTanHalf, Math.tan(cam.fov / 2));
    gl.uniform4f(this.u.uLayers, layers[0], layers[1], layers[2], layers[3]);
    gl.uniform1f(this.u.uTime, time);
    gl.uniform4f(this.u.uBrush, (brush?.x ?? 0) + 0.5, (brush?.y ?? 0) + 0.5, (brush?.z ?? 0) + 0.5, brush ? brush.radius : -1);
    gl.uniform4f(this.u.uSel, (sel?.x ?? 0) + 0.5, (sel?.y ?? 0) + 0.5, (sel?.z ?? 0) + 0.5, sel ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.tex) gl.deleteTexture(t);
    gl.deleteProgram(this.prog);
  }
}

export function createRenderer3D(canvas: HTMLCanvasElement): Renderer3D | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  try {
    return new Renderer3D(canvas, gl);
  } catch (err) {
    console.warn('[TuringLife] 3D renderer init failed', err);
    return null;
  }
}

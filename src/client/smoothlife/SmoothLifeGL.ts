/**
 * SmoothLife (Rafler 2011, discrete-time rule) on the GPU, fed by quantum noise.
 *
 * Every cell holds a value in [0,1]. Each step it looks at two averages around itself: m over an
 * inner disk (radius ri = ra/3) and n over the ring out to ra, and becomes S(n, m), a smooth
 * version of Conway's birth/survival rule. Nothing else is built in. Splats of quantum noise rain
 * onto the world; most fade, some burst into chaos, and out of that chaos gliders, chains and
 * membranes assemble themselves. scripts/smoothlife-probe.ts is the CPU reference used to tune it.
 */

export interface SmoothLifeParams {
  ra: number; // outer radius in cells
  b1: number; b2: number; d1: number; d2: number; an: number; am: number;
  /** Fraction of a splat's cells set to 1: splats are grainy noise, not solid discs. */
  fill: number;
  /** Splats per cell per step (the CPU probe's lively setting: 1 per 30 steps on 192×128). */
  rain: number;
  /** Splats at the start, per cell. */
  seedDensity: number;
}

export const DEFAULT_SMOOTHLIFE: SmoothLifeParams = {
  ra: 12, b1: 0.278, b2: 0.365, d1: 0.267, d2: 0.445, an: 0.028, am: 0.147,
  fill: 0.7, rain: 1 / (30 * 192 * 128), seedDensity: 30 / (192 * 128),
};

const MAX_SPLATS = 8;

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const STEP_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uSize;
uniform float uRa, uRi, uNormI, uNormO;
uniform float uB1, uB2, uD1, uD2, uAn, uAm;
uniform int uSplats;
uniform vec4 uSplat[${MAX_SPLATS}]; // x, y, radius, quantum seed
uniform float uFill;
out vec4 o;

float s1(float x, float a, float al) { return 1.0 / (1.0 + exp(-(x - a) * 4.0 / al)); }
float s2(float x, float a, float b) { return s1(x, a, uAn) * (1.0 - s1(x, b, uAn)); }
float sm(float x, float y, float m) { float t = s1(m, 0.5, uAm); return x * (1.0 - t) + y * t; }

float grain(ivec2 p, float seed) {
  uint h = uint(p.x) * 1973u ^ uint(p.y) * 9277u ^ uint(seed) * 26699u;
  h = h * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return float(h) / 4294967295.0;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 size = vec2(uSize);
  for (int i = 0; i < ${MAX_SPLATS}; i++) {
    if (i >= uSplats) break;
    vec4 s = uSplat[i];
    vec2 d = vec2(p) - s.xy;
    d -= size * floor(d / size + 0.5); // nearest copy on the torus
    if (dot(d, d) < s.z * s.z) { o = vec4(grain(p, s.w) < uFill ? 1.0 : 0.0, 0.0, 0.0, 1.0); return; }
  }
  int R = int(ceil(uRa + 0.5));
  float m = 0.0, n = 0.0;
  for (int dy = -R; dy <= R; dy++) {
    for (int dx = -R; dx <= R; dx++) {
      float l = length(vec2(dx, dy));
      float inner = clamp(uRi + 0.5 - l, 0.0, 1.0);
      float outer = clamp(uRa + 0.5 - l, 0.0, 1.0) - inner;
      if (inner + outer <= 0.0) continue;
      float v = texelFetch(uState, (p + ivec2(dx, dy) + uSize) % uSize, 0).r;
      m += v * inner;
      n += v * outer;
    }
  }
  m /= uNormI;
  n /= uNormO;
  o = vec4(s2(n, sm(uB1, uD1, m), sm(uB2, uD2, m)), 0.0, 0.0, 1.0);
}`;

/** Trail: a slowly fading memory of where matter has been, so motion leaves a wake. */
const TRAIL_FS = `#version 300 es
precision highp float;
uniform sampler2D uTrail, uState;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float t = texelFetch(uTrail, p, 0).r * 0.94;
  o = vec4(max(t, texelFetch(uState, p, 0).r), 0.0, 0.0, 1.0);
}`;

const SHOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev, uCur, uTrail;
uniform float uT;
uniform vec2 uView;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uView;
  uv.y = 1.0 - uv.y;
  float v = mix(texture(uPrev, uv).r, texture(uCur, uv).r, uT);
  float tr = texture(uTrail, uv).r;
  vec3 bg = vec3(0.008, 0.016, 0.043);
  vec3 wake = vec3(0.10, 0.22, 0.48) * tr * 0.55;
  vec3 body = mix(vec3(0.85, 0.28, 0.16), vec3(1.0, 0.86, 0.58), smoothstep(0.35, 1.0, v));
  vec3 c = bg + wake + body * smoothstep(0.04, 0.55, v);
  o = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
  return prog;
}

interface Target { tex: WebGLTexture; fb: WebGLFramebuffer }

export class SmoothLifeGL {
  readonly gl: WebGL2RenderingContext;
  private step: WebGLProgram;
  private trail: WebGLProgram;
  private show: WebGLProgram;
  private states: Target[] = [];
  private trails: Target[] = [];
  private cur = 0;
  private trailCur = 0;
  private normI = 1;
  private normO = 1;
  private floatOk: boolean;
  W = 0;
  H = 0;
  private pending: { x: number; y: number; r: number; seed: number }[] = [];
  private rainDebt = 0;

  constructor(canvas: HTMLCanvasElement, private readonly p: SmoothLifeParams, private readonly rand: () => number) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    this.step = compile(gl, STEP_FS);
    this.trail = compile(gl, TRAIL_FS);
    this.show = compile(gl, SHOW_FS);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Kernel normalisers, computed exactly as the shader weights them.
    const ra = p.ra, ri = ra / 3, R = Math.ceil(ra + 0.5);
    let si = 0, so = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const l = Math.hypot(dx, dy);
      const inner = Math.min(1, Math.max(0, ri + 0.5 - l));
      const outer = Math.min(1, Math.max(0, ra + 0.5 - l)) - inner;
      si += inner; so += outer;
    }
    this.normI = si;
    this.normO = so;
  }

  private target(w: number, h: number, float: boolean, linear: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb };
  }

  /** (Re)creates an empty world of W×H cells and seeds it. */
  reset(W: number, H: number): void {
    const gl = this.gl;
    for (const t of [...this.states, ...this.trails]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    this.W = W;
    this.H = H;
    this.states = [this.target(W, H, this.floatOk, true), this.target(W, H, this.floatOk, true), this.target(W, H, this.floatOk, true)];
    this.trails = [this.target(W, H, this.floatOk, true), this.target(W, H, this.floatOk, true)];
    this.cur = 0;
    this.trailCur = 0;
    this.pending = [];
    const n = Math.max(4, Math.round(this.p.seedDensity * W * H));
    for (let i = 0; i < n; i++) this.queueSplat();
  }

  private queueSplat(): void {
    this.pending.push({
      x: this.rand() * this.W,
      y: this.rand() * this.H,
      r: this.p.ra * (0.8 + 0.4 * this.rand()),
      seed: Math.floor(this.rand() * 65536),
    });
  }

  /** One SmoothLife step, plus whatever quantum rain is due. */
  advance(): void {
    const gl = this.gl;
    this.rainDebt += this.p.rain * this.W * this.H;
    while (this.rainDebt >= 1) { this.queueSplat(); this.rainDebt -= 1; }
    const splats = this.pending.splice(0, MAX_SPLATS);

    const prevIdx = this.cur;
    const next = (this.cur + 1) % 3;
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.step);
    const u = (n: string) => gl.getUniformLocation(this.step, n);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.states[prevIdx].tex);
    gl.uniform1i(u('uState'), 0);
    gl.uniform2i(u('uSize'), this.W, this.H);
    gl.uniform1f(u('uRa'), this.p.ra);
    gl.uniform1f(u('uRi'), this.p.ra / 3);
    gl.uniform1f(u('uNormI'), this.normI);
    gl.uniform1f(u('uNormO'), this.normO);
    gl.uniform1f(u('uB1'), this.p.b1);
    gl.uniform1f(u('uB2'), this.p.b2);
    gl.uniform1f(u('uD1'), this.p.d1);
    gl.uniform1f(u('uD2'), this.p.d2);
    gl.uniform1f(u('uAn'), this.p.an);
    gl.uniform1f(u('uAm'), this.p.am);
    gl.uniform1f(u('uFill'), this.p.fill);
    gl.uniform1i(u('uSplats'), splats.length);
    if (splats.length) gl.uniform4fv(u('uSplat'), splats.flatMap((s) => [s.x, s.y, s.r, s.seed]));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.states[next].fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = next;

    const tNext = 1 - this.trailCur;
    gl.useProgram(this.trail);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trails[this.trailCur].tex);
    gl.uniform1i(gl.getUniformLocation(this.trail, 'uTrail'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.states[next].tex);
    gl.uniform1i(gl.getUniformLocation(this.trail, 'uState'), 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trails[tNext].fb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.trailCur = tNext;
  }

  /** Draws the world to the canvas, blending the last two steps by t ∈ [0,1] for smooth motion. */
  draw(width: number, height: number, t: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.show);
    const prev = (this.cur + 2) % 3;
    const bind = (unit: number, tex: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(this.show, name), unit);
    };
    bind(0, this.states[prev].tex, 'uPrev');
    bind(1, this.states[this.cur].tex, 'uCur');
    bind(2, this.trails[this.trailCur].tex, 'uTrail');
    gl.uniform1f(gl.getUniformLocation(this.show, 'uT'), t);
    gl.uniform2f(gl.getUniformLocation(this.show, 'uView'), width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

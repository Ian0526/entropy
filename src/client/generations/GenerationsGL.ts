/**
 * "Generations" cellular automata on the GPU, fed by quantum rain.
 *
 * A Generations rule B…/S…/C… is Conway's Life with a refractory period: a live cell that fails
 * to survive doesn't vanish but ages through C-2 dying states first, and only live cells count as
 * neighbours. That small change is enough for some rules to assemble machine-like structures from
 * noise: Bombers (B24/S345/C25) builds delta-wing ships, ladders and exhaust trails; Star Wars
 * (B2/S345/C4) builds spaceship trains, rakes and walls. Nothing is designed in; grainy splats of
 * quantum noise keep landing, and the rule does the rest. scripts/generations-probe.ts is the CPU
 * reference.
 */

export interface GenerationsRule {
  name: string;
  born: number[];
  survive: number[];
  states: number;
  /** Splats per cell per step, and their radius in cells. */
  rain: number;
  rainR: number;
  /** Fraction of the world filled with live cells at the start. */
  density: number;
}

export const RULES: Record<string, GenerationsRule> = {
  bombers: { name: 'Bombers', born: [2, 4], survive: [3, 4, 5], states: 25, rain: 1 / (40 * 400 * 200), rainR: 6, density: 0.35 },
  starwars: { name: 'Star Wars', born: [2], survive: [3, 4, 5], states: 4, rain: 1 / (20 * 400 * 200), rainR: 6, density: 0.35 },
};

const MAX_SPLATS = 8;

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// States are stored as integers 0..C-1 in an R8 texture (value / 255).
const STEP_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uState;
uniform ivec2 uSize;
uniform int uBorn, uSurvive, uStates;
uniform int uSplats;
uniform vec4 uSplat[${MAX_SPLATS}]; // x, y, radius, quantum seed
out vec4 o;

int at(ivec2 p) { return int(texelFetch(uState, (p + uSize) % uSize, 0).r * 255.0 + 0.5); }

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
    d -= size * floor(d / size + 0.5);
    if (dot(d, d) < s.z * s.z && grain(p, s.w) < 0.5) { o = vec4(1.0 / 255.0, 0.0, 0.0, 1.0); return; }
  }
  int n = 0;
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++)
      if ((dx != 0 || dy != 0) && at(p + ivec2(dx, dy)) == 1) n++;
  int v = at(p);
  int next;
  if (v == 0) next = ((uBorn >> n) & 1) == 1 ? 1 : 0;
  else if (v == 1) next = ((uSurvive >> n) & 1) == 1 ? 1 : (uStates > 2 ? 2 : 0);
  else next = v + 1 >= uStates ? 0 : v + 1;
  o = vec4(float(next) / 255.0, 0.0, 0.0, 1.0);
}`;

const SHOW_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uView;
uniform ivec2 uSize;
uniform int uStates;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uView;
  uv.y = 1.0 - uv.y;
  int v = int(texelFetch(uState, ivec2(uv * vec2(uSize)), 0).r * 255.0 + 0.5);
  vec3 bg = vec3(0.016, 0.031, 0.078);
  vec3 c;
  if (v == 0) c = bg;
  else if (v == 1) c = vec3(1.0, 0.86, 0.55);
  else {
    // Dying cells cool from ember orange through violet into the background: exhaust trails.
    float t = float(v - 1) / float(max(uStates - 1, 2));
    vec3 hot = vec3(0.86, 0.36, 0.24), mid = vec3(0.42, 0.20, 0.52), cold = vec3(0.10, 0.12, 0.30);
    c = t < 0.5 ? mix(hot, mid, t * 2.0) : mix(mid, cold, (t - 0.5) * 2.0);
    c = mix(c, bg, smoothstep(0.75, 1.0, t));
  }
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

const mask = (xs: number[]) => xs.reduce((m, x) => m | (1 << x), 0);

export class GenerationsGL {
  private readonly gl: WebGL2RenderingContext;
  private readonly step: WebGLProgram;
  private readonly show: WebGLProgram;
  private tex: WebGLTexture[] = [];
  private fbs: WebGLFramebuffer[] = [];
  private cur = 0;
  private pending: number[][] = [];
  private rainDebt = 0;
  W = 0;
  H = 0;

  constructor(canvas: HTMLCanvasElement, private readonly rule: GenerationsRule, private readonly rand: () => number) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.step = compile(gl, STEP_FS);
    this.show = compile(gl, SHOW_FS);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** (Re)creates a W×H world filled with quantum noise. */
  reset(W: number, H: number): void {
    const gl = this.gl;
    for (const t of this.tex) gl.deleteTexture(t);
    for (const f of this.fbs) gl.deleteFramebuffer(f);
    this.W = W;
    this.H = H;
    const init = new Uint8Array(W * H);
    for (let i = 0; i < init.length; i++) init[i] = this.rand() < this.rule.density ? 1 : 0;
    this.tex = [];
    this.fbs = [];
    for (let k = 0; k < 2; k++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, W, H, 0, gl.RED, gl.UNSIGNED_BYTE, k === 0 ? init : null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
      this.fbs.push(fb);
    }
    this.cur = 0;
    this.pending = [];
  }

  advance(): void {
    const gl = this.gl;
    this.rainDebt += this.rule.rain * this.W * this.H;
    while (this.rainDebt >= 1) {
      this.pending.push([this.rand() * this.W, this.rand() * this.H, this.rule.rainR, Math.floor(this.rand() * 65536)]);
      this.rainDebt -= 1;
    }
    const splats = this.pending.splice(0, MAX_SPLATS);
    const next = 1 - this.cur;
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.step);
    const u = (n: string) => gl.getUniformLocation(this.step, n);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.uniform1i(u('uState'), 0);
    gl.uniform2i(u('uSize'), this.W, this.H);
    gl.uniform1i(u('uBorn'), mask(this.rule.born));
    gl.uniform1i(u('uSurvive'), mask(this.rule.survive));
    gl.uniform1i(u('uStates'), this.rule.states);
    gl.uniform1i(u('uSplats'), splats.length);
    if (splats.length) gl.uniform4fv(u('uSplat'), splats.flat());
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbs[next]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = next;
  }

  draw(width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.show);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.uniform1i(gl.getUniformLocation(this.show, 'uState'), 0);
    gl.uniform2f(gl.getUniformLocation(this.show, 'uView'), width, height);
    gl.uniform2i(gl.getUniformLocation(this.show, 'uSize'), this.W, this.H);
    gl.uniform1i(gl.getUniformLocation(this.show, 'uStates'), this.rule.states);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

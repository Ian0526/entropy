/**
 * The Morphogenesis world on the GPU: three-channel multi-kernel Lenia (see regimes.ts) plus a
 * phase field.
 *
 * State per cell (RGBA16F): A, B, C in [0,1] and θ, an oscillator phase in cycles. Each step is two
 * passes: the field (convolutions → growth and potentials) and the update (growth + flow + phase).
 *  - Matter: every kernel's ring convolution is evaluated directly over its disk (≤ πR² taps; the
 *    kernel weights live in a float texture, four kernels per texel), then each channel grows by
 *    dt·Σ h·G(U).
 *  - Phase: each cell's oscillator runs at a natural frequency that rises with its own mass and is
 *    pulled toward its neighbours' phases (Kuramoto, sampled on three sparse rings at R/3, 2R/3
 *    and R). Dense cores therefore beat faster and send waves out into the empty field.
 *  - Swirl: matter is advected along ∇⊥θ, so a body whose phase winds around it turns.
 *  - Speciation: a second texture carries each cell's genome g ∈ [-1,1] (inherited from the mass
 *    around it, so it travels with its organism; set by the quantum dice at seeding). Where a
 *    regime enables it, g shifts μ and sets the sign and size of the curl torque.
 * Seeds, erasers and the statistics read back by the Director are separate small passes.
 */
import type { Regime } from './regimes';
import { DEFAULT_SETTINGS, type DisplaySettings } from './settings';
import { kernelWeights, reach } from './regimes';

export const MAX_KERNELS = 16;
const MAX_STAMPS = 8;
const RING_TAPS = 24;
export const STATS_W = 64;
/** Occupancy block size, in cells. */
const BLOCK = 8;

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uState;
uniform sampler2D uAux; // genome g in [-1,1], |vorticity|·R, last velocity (x, y)
uniform ivec2 uSize;
vec4 at(ivec2 q) { return texelFetch(uState, (q % uSize + uSize) % uSize, 0); }
vec4 aux(ivec2 q) { return texelFetch(uAux, (q % uSize + uSize) % uSize, 0); }
`;

// Pass 1, the field: every kernel's ring convolution (the heavy part; taps on empty cells are
// skipped, so a mostly-black world is cheap). Writes the growth per channel and the potentials
// the flow pass differentiates.
const FIELD_FS = `${COMMON}
uniform sampler2D uKern;
uniform int uR, uGroups;
uniform vec4 uSrc[${MAX_KERNELS}];
uniform vec4 uGrow[${MAX_KERNELS}]; // mu, sigma, h, target channel
uniform float uDmu, uSpec, uVortMu;
uniform sampler2D uNear; // per 8×8 block: the most mass any cell within reach of the block holds
uniform sampler2D uOcc;  // per 8×8 block: the most mass any of its own cells holds
uniform int uBlock, uReach;
layout(location = 0) out vec4 o0; // growth A, B, C; mean potential U
layout(location = 1) out vec4 o1; // mean potential sensed from A, from B, from C; neighbours' genome

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = 2 * uR + 1;
  vec4 U[4] = vec4[4](vec4(0.0), vec4(0.0), vec4(0.0), vec4(0.0));
  float gsum = 0.0, msum = 0.0;
  // Empty space: if no cell within reach holds mass ≥ 1e-4, the loop below would skip every tap,
  // so skipping it whole gives exactly the same U (all zero) for a fraction of the cost.
  // Taps are visited block by block, and blocks with no cell ≥ 1e-4 are skipped whole (their taps
  // would all be skipped one by one). Blocks that straddle the world's edge are never skipped.
  ivec2 pb = p / uBlock;
  if (texelFetch(uNear, pb, 0).r >= 1e-4)
  for (int by = -uReach; by <= uReach; by++)
  for (int bx = -uReach; bx <= uReach; bx++) {
    ivec2 bi = pb + ivec2(bx, by);
    bool inside = bi.x >= 0 && bi.y >= 0 && (bi.x + 1) * uBlock <= uSize.x && (bi.y + 1) * uBlock <= uSize.y;
    if (inside && texelFetch(uOcc, bi, 0).r < 1e-4) continue;
    for (int j = 0; j < 16; j++) {
    if (j >= uBlock) break;
    for (int i = 0; i < 16; i++) {
      if (i >= uBlock) break;
      int dx = bi.x * uBlock + i - p.x, dy = bi.y * uBlock + j - p.y;
      if (dx * dx + dy * dy > uR * uR) continue;
      vec3 c = at(p + ivec2(dx, dy)).rgb;
      float cm = c.r + c.g + c.b;
      if (cm < 1e-4) continue;
      if (uSpec > 0.0) { gsum += cm * aux(p + ivec2(dx, dy)).x; msum += cm; }
      int idx = (dy + uR) * n + dx + uR;
      for (int g = 0; g < 4; g++) {
        if (g >= uGroups) break;
        vec4 w = texelFetch(uKern, ivec2(idx, g), 0);
        U[g] += w * vec4(dot(c, uSrc[g * 4].rgb), dot(c, uSrc[g * 4 + 1].rgb), dot(c, uSrc[g * 4 + 2].rgb), dot(c, uSrc[g * 4 + 3].rgb));
      }
    }
    }
  }
  vec3 d = vec3(0.0), uc = vec3(0.0), nc = vec3(0.0);
  float ub = 0.0, nk = 0.0;
  vec4 me = aux(p);
  // Local law: each organism's genome shifts μ, and vortical flow lowers it (corners and roll-ups
  // grow more easily than smooth arcs).
  float shift = uDmu + uSpec * me.x - uVortMu * me.y;
  for (int k = 0; k < ${MAX_KERNELS}; k++) {
    if (k >= uGroups * 4) break;
    vec4 gp = uGrow[k];
    if (gp.z == 0.0) continue;
    float u = U[k / 4][k % 4];
    float e = u - gp.x - shift;
    d[int(gp.w)] += gp.z * (2.0 * exp(-e * e / (2.0 * gp.y * gp.y)) - 1.0);
    uc += u * uSrc[k].rgb;
    nc += uSrc[k].rgb;
    ub += u;
    nk += 1.0;
  }
  o0 = vec4(d, ub / max(nk, 1.0));
  o1 = vec4(uc / max(nc, vec3(1.0)), msum > 1e-3 ? gsum / msum : me.x);
}`;

// Occupancy, for the field pass to skip empty space. OCC: per block of uBlock×uBlock cells, the
// largest mass (A+B+C, exactly as the field pass sums it). NEAR: the largest OCC within ±uReach
// blocks, which covers every cell within R of any cell in the block.
const OCC_FS = `${COMMON}
uniform int uBlock;
out vec4 o;
void main() {
  ivec2 b0 = ivec2(gl_FragCoord.xy) * uBlock;
  float m = 0.0;
  for (int j = 0; j < 16; j++) {
    if (j >= uBlock) break;
    for (int i = 0; i < 16; i++) {
      if (i >= uBlock) break;
      vec3 c = at(b0 + ivec2(i, j)).rgb;
      m = max(m, c.r + c.g + c.b);
    }
  }
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

const NEAR_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uOcc;
uniform ivec2 uCSize;
uniform int uReach;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = 0.0;
  for (int dy = -uReach; dy <= uReach; dy++)
    for (int dx = -uReach; dx <= uReach; dx++)
      m = max(m, texelFetch(uOcc, ((p + ivec2(dx, dy)) % uCSize + uCSize) % uCSize, 0).r);
  o = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pass 2, the update: growth, plus the flow
//   v = R·(α ∇G + ω (U_A − U_B) ∇⊥U)   (Sobel gradients of the field pass)
//     + swirl along ∇⊥θ,
// applied semi-Lagrangian, and the phase oscillators (Kuramoto on three sparse rings).
const STEP_FS = `${COMMON}
uniform sampler2D uP0, uP1;
uniform int uR;
uniform vec2 uRing[${RING_TAPS}];
uniform float uDt, uOmega, uSync, uSwirl, uFlow, uCurl, uSpec;
uniform vec3 uUsed; // 1 for channels some kernel of the law writes
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oAux;
const float TAU = 6.28318531;

vec4 P(ivec2 q) { return texelFetch(uP0, (q % uSize + uSize) % uSize, 0); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 self = at(p);
  vec4 p0 = P(p);
  float th = self.a;

  vec2 v = vec2(0.0);
  if (uFlow != 0.0 || uCurl != 0.0) {
    // Sobel over the 3×3 neighbourhood: U in .a, total growth in .r+.g+.b.
    vec2 gU = vec2(0.0), gG = vec2(0.0);
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      vec4 q = P(p + ivec2(i, j));
      vec2 w = vec2(float(i) * (j == 0 ? 2.0 : 1.0), float(j) * (i == 0 ? 2.0 : 1.0)) / 8.0;
      gU += w * q.a;
      gG += w * (q.r + q.g + q.b);
    }
    vec4 p1 = texelFetch(uP1, p, 0);
    // With speciation, the genome sets each organism's torque and its sign (CW or CCW).
    float curl = uSpec > 0.0 ? uCurl * aux(p).x : uCurl;
    v += float(uR) * (uFlow * gG + curl * (p1.r - p1.g) * vec2(-gU.y, gU.x));
  }
  if (uSwirl > 0.0) {
    float gx = fract(at(p + ivec2(1, 0)).a - at(p - ivec2(1, 0)).a + 0.5) - 0.5;
    float gy = fract(at(p + ivec2(0, 1)).a - at(p - ivec2(0, 1)).a + 0.5) - 0.5;
    v += uSwirl * 4.0 * vec2(-gy, gx);
  }
  v = clamp(v, -1.5, 1.5);
  vec3 base = dot(v, v) > 1e-6 ? texture(uState, (vec2(p) + 0.5 - v) / vec2(uSize)).rgb : self.rgb;

  vec2 Z = vec2(0.0);
  float M = 0.0;
  for (int i = 0; i < ${RING_TAPS}; i++) {
    vec4 s = at(p + ivec2(uRing[i]));
    float m = s.r + s.g + s.b + 0.02;
    float a = TAU * (s.a - th);
    Z += m * vec2(cos(a), sin(a));
    M += m;
  }
  float mass = self.r + self.g + self.b;
  float dth = uOmega * (0.4 + mass) + uSync * 0.1 * Z.y / M;
  // A channel no kernel writes has no growth at all, so whatever an earlier law left in it would
  // stay forever; it fades out instead (gone in ~3 s at 30 steps/s).
  o = vec4(clamp(base + uDt * p0.rgb - 0.025 * (1.0 - uUsed), 0.0, 1.0), fract(th + uDt * dth));

  // Genome: inherited from the mass around (so it travels with its organism), and vorticity of
  // last step's flow, for the field pass.
  vec4 me = aux(p);
  float gn = texelFetch(uP1, p, 0).a;
  float g = mass < 0.02 ? gn : mix(me.x, gn, 0.05);
  float vort = 0.5 * ((aux(p + ivec2(1, 0)).w - aux(p - ivec2(1, 0)).w) - (aux(p + ivec2(0, 1)).z - aux(p - ivec2(0, 1)).z));
  oAux = vec4(g, abs(vort) * float(uR), v);
}`;

// Seeds and erasers. kind 0: noise patch, 1: harmonic ring cos(mφ) with a phase winding, 2: erase,
// 3: stir (matter within a Gaussian of radius size is dragged by uB.xy cells, genome and all),
// 4: ripple (a faint ring of mass on the channels in use plus a phase winding; genomes untouched),
// 5: clone (the disk of radius size around (x, y) + uB.xy is copied here, phase and genome too).
const STAMP_FS = `${COMMON}
uniform int uCount;
uniform vec4 uA[${MAX_STAMPS}]; // x, y, size, kind
uniform vec4 uB[${MAX_STAMPS}]; // m, phase (cycles), ring width, grain seed
uniform vec4 uC[${MAX_STAMPS}]; // amplitude per channel, winding
uniform float uG[${MAX_STAMPS}]; // genome
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oAux;

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
  vec4 s = at(p);
  vec4 x = aux(p);
  for (int i = 0; i < ${MAX_STAMPS}; i++) {
    if (i >= uCount) break;
    vec4 a = uA[i], b = uB[i], c = uC[i];
    vec2 d = vec2(p) - a.xy;
    d -= size * floor(d / size + 0.5);
    float r = length(d);
    if (a.w < 0.5) {
      if (abs(d.x) < a.z && abs(d.y) < a.z) {
        vec3 g = vec3(grain(p, b.w), grain(p, b.w + 1.0), grain(p, b.w + 2.0));
        s.rgb = max(s.rgb, g * c.rgb);
        s.a = fract(b.y + 0.15 * g.x);
        x.x = uG[i];
      }
    } else if (a.w < 1.5) {
      float f = atan(d.y, d.x);
      // Concentric: the main ring plus a fainter one at half its radius, both modulated by cos(mφ).
      float prof = exp(-(r - a.z) * (r - a.z) / (2.0 * b.z * b.z)) + 0.6 * exp(-(r - 0.5 * a.z) * (r - 0.5 * a.z) / (2.0 * b.z * b.z));
      float v = min(prof, 1.0) * (0.7 + 0.3 * cos(b.x * f + 6.28318531 * b.y));
      s.rgb = min(vec3(1.0), s.rgb + v * c.rgb);
      if (v > 0.2) s.a = fract(b.y + c.w * f / 6.28318531);
      if (v > 0.05) x.x = uG[i];
    } else if (a.w < 2.5) {
      s.rgb *= smoothstep(a.z * 0.6, a.z, r);
    } else if (a.w < 3.5) {
      float k = exp(-r * r / (2.0 * a.z * a.z));
      if (k > 0.01) {
        vec2 src = vec2(p) + 0.5 - k * b.xy;
        s.rgb = texture(uState, src / size).rgb;
        x.x = aux(ivec2(floor(src))).x;
      }
    } else if (a.w > 4.5) {
      float k = 1.0 - smoothstep(0.75 * a.z, a.z, r);
      if (k > 0.0) {
        ivec2 q = p + ivec2(round(b.xy));
        vec4 src = at(q);
        s.rgb = mix(s.rgb, src.rgb, k);
        if (k > 0.5) { s.a = src.a; x.x = aux(q).x; }
      }
    } else {
      float prof = exp(-(r - a.z) * (r - a.z) / (2.0 * b.z * b.z));
      float f = atan(d.y, d.x);
      s.rgb = min(vec3(1.0), s.rgb + prof * (0.7 + 0.3 * cos(b.x * f)) * c.rgb);
      s.a = fract(s.a + prof * (b.y + c.w * f / 6.28318531));
    }
  }
  o = s;
  oAux = x;
}`;

// Coarse statistics for the Director: per block, mean of A, B, C and the fraction of cells alive.
const STATS_FS = `${COMMON}
uniform vec2 uBlock;
uniform float uUsed;
out vec4 o;
void main() {
  vec2 b0 = floor(gl_FragCoord.xy) * uBlock;
  vec3 sum = vec3(0.0);
  float alive = 0.0;
  for (int j = 0; j < 6; j++) for (int i = 0; i < 6; i++) {
    vec3 c = at(ivec2(b0 + (vec2(i, j) + 0.5) * uBlock / 6.0)).rgb;
    sum += c;
    alive += (c.r + c.g + c.b) / uUsed > 0.1 ? 1.0 : 0.0;
  }
  o = vec4(sum / 36.0, alive / 36.0);
}`;

// The picture. Every term is weighted by a display setting (settings.ts), so one shader draws
// every look: "Classic glow" is body + edge + halo + crests; "Microscope" adds DIC relief from the
// mass as an optical thickness map, thin-film iridescence on steep membranes, a wet specular
// highlight, organelle rings, nucleus glow, vorticity glow (from the aux texture), a film
// tonemap, sensor grain and a lens vignette.
// The grid is upscaled with Catmull-Rom (9 hardware-bilinear taps) instead of bilinear, and the
// halo samples two rings through the linear sampler, so cells don't show at cellPx 2–3.
const SHOW_FS = `${COMMON}
uniform vec2 uView;
uniform vec3 uCol[3];
uniform vec3 uBg, uHaloCol;
uniform int uFilter; // 0 bilinear, 1 bicubic
uniform sampler2D uPrev; // the state one step back, for motion between steps
uniform float uBlend;    // 1 = the current state; less blends toward the previous one
uniform float uExposure, uBody, uEdge, uHalo, uHaloR, uCrests;
uniform float uRelief, uIrid, uSpec, uPellicle, uNucleus, uVort, uGeneTint, uTone, uGrain, uVignette;
out vec4 o;
const float TAU = 6.28318531;

vec3 linOf(sampler2D t, vec2 g) { return texture(t, g / vec2(uSize)).rgb; }
vec3 lin(vec2 g) { return linOf(uState, g); }

// Catmull-Rom through the bilinear sampler: 9 taps instead of 16 (g in cells, centres at +0.5).
vec3 catrom(sampler2D T, vec2 g) {
  vec2 tc = floor(g - 0.5) + 0.5;
  vec2 f = g - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = tc - 1.0, t3 = tc + 2.0, t12 = tc + w2 / w12;
  vec3 c = (linOf(T, vec2(t0.x, t0.y)) * w0.x + linOf(T, vec2(t12.x, t0.y)) * w12.x + linOf(T, vec2(t3.x, t0.y)) * w3.x) * w0.y
         + (linOf(T, vec2(t0.x, t12.y)) * w0.x + linOf(T, vec2(t12.x, t12.y)) * w12.x + linOf(T, vec2(t3.x, t12.y)) * w3.x) * w12.y
         + (linOf(T, vec2(t0.x, t3.y)) * w0.x + linOf(T, vec2(t12.x, t3.y)) * w12.x + linOf(T, vec2(t3.x, t3.y)) * w3.x) * w3.y;
  return max(c, 0.0); // Catmull-Rom overshoots a little at sharp edges
}

vec3 massOf(sampler2D T, vec2 g) { return uFilter == 1 ? catrom(T, g) : linOf(T, g); }
vec3 mass3(vec2 g) {
  vec3 m = massOf(uState, g);
  return uBlend < 0.999 ? mix(massOf(uPrev, g), m, uBlend) : m;
}

// Phase as a unit vector (θ wraps, so it can't be filtered directly); returns cos θ.
float phase(vec2 g) {
  vec2 q = g - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 f = fract(q);
  float a00 = TAU * at(i0).a, a10 = TAU * at(i0 + ivec2(1, 0)).a, a01 = TAU * at(i0 + ivec2(0, 1)).a, a11 = TAU * at(i0 + ivec2(1, 1)).a;
  vec2 p = mix(mix(vec2(cos(a00), sin(a00)), vec2(cos(a10), sin(a10)), f.x),
               mix(vec2(cos(a01), sin(a01)), vec2(cos(a11), sin(a11)), f.x), f.y);
  return p.x;
}

vec4 auxAt(vec2 g) {
  vec2 q = g - 0.5;
  ivec2 i0 = ivec2(floor(q));
  vec2 f = fract(q);
  return mix(mix(aux(i0), aux(i0 + ivec2(1, 0)), f.x), mix(aux(i0 + ivec2(0, 1)), aux(i0 + ivec2(1, 1)), f.x), f.y);
}

vec3 tint(vec3 m) { return m.r * uCol[0] + m.g * uCol[1] + m.b * uCol[2]; }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uView;
  uv.y = 1.0 - uv.y;
  vec2 g = uv * vec2(uSize);
  vec3 m = mass3(g);
  float mass = m.r + m.g + m.b;

  // Gradient of the mass, one cell apart. Relief weights the channels differently, so organelles
  // of different species stand at different heights.
  vec3 hw = vec3(1.0, 1.0 + 0.35 * uRelief, 1.0 + 0.7 * uRelief);
  float gx = dot(mass3(g + vec2(1.0, 0.0)) - mass3(g - vec2(1.0, 0.0)), hw);
  float gy = dot(mass3(g + vec2(0.0, 1.0)) - mass3(g - vec2(0.0, 1.0)), hw);
  float edge = length(vec2(gx, gy));
  // y runs down the screen; the light comes from the upper left.
  vec3 normal = normalize(vec3(-gx * 0.9, gy * 0.9, 1.0));

  // Halo: mass on two rings around this point.
  float halo = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * TAU / 12.0;
    vec2 dir = vec2(cos(a), sin(a));
    vec3 h1 = lin(g + 0.75 * uHaloR * dir), h2 = lin(g + 1.6 * uHaloR * dir);
    halo += (h1.r + h1.g + h1.b) * 0.65 + (h2.r + h2.g + h2.b) * 0.35;
  }
  halo /= 12.0;

  vec4 ax = auxAt(g);
  vec3 body = tint(m) / max(mass, 1e-3);
  body = mix(body, ax.x > 0.0 ? body.gbr : body.brg, uGeneTint * abs(ax.x));

  vec2 lens = uv - 0.5;
  vec3 col = uBg * (1.0 - 0.7 * uVignette * dot(lens, lens));
  col += uHaloCol * smoothstep(0.0, 0.5, halo) * uHalo;

  vec3 L = normalize(vec3(-0.6, 0.6, 0.5));
  float dic = dot(normal, L) * 0.5 + 0.5;
  col += body * smoothstep(0.02, 0.8, mass) * uBody * mix(1.0, 0.45 + 0.55 * dic, uRelief);

  vec3 irid = 0.5 + 0.5 * cos(TAU * (mass * 0.8 + normal.xyx * 1.5 + vec3(0.0, 0.33, 0.67)));
  vec3 rim = mix(mix(body, vec3(1.0), 0.2), mix(body, irid, 0.6), uIrid);
  float pellicle = smoothstep(0.08, 0.18, mass) * (1.0 - smoothstep(0.18, 0.32, mass));
  col += rim * (smoothstep(0.1, 0.9, edge) * uEdge + pellicle * uPellicle);

  col += body * uCrests * mass * pow(0.5 + 0.5 * phase(g), 4.0);
  col += mix(body, vec3(1.0, 0.98, 0.9), 0.5) * smoothstep(0.9, 1.6, mass) * uNucleus;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  col += vec3(0.85, 0.95, 1.0) * pow(max(0.0, dot(normal, H)), 28.0) * smoothstep(0.05, 0.3, mass) * uSpec;
  col += vec3(0.2, 0.8, 1.0) * clamp(ax.y * 0.15, 0.0, 0.3) * mass * uVort;

  col *= uExposure;
  col = mix(col, col / (1.0 + col * 0.25), uTone);
  col += (hash12(gl_FragCoord.xy) - 0.5) * 0.012 * uGrain;
  o = vec4(col, 1.0);
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

export interface Stamp {
  /** ripple: phase is the phase kick (cycles), m the harmonic, width the ring width. */
  kind: 'patch' | 'ring' | 'erase' | 'stir' | 'ripple' | 'clone';
  x: number;
  y: number;
  size: number;
  /** Ring harmonic, phase (cycles), ring width, per-channel amplitude, phase winding. */
  m?: number;
  phase?: number;
  width?: number;
  amp?: [number, number, number];
  winding?: number;
  /** Genome in [-1,1] given to the cells this stamp seeds. */
  genome?: number;
  /** stir: how far (cells) matter at the centre is dragged; clone: offset to the source. */
  drag?: [number, number];
}

export interface FieldStats {
  /** Fraction of cells alive, mean mass per channel, mean |change| since the last read (×1000). */
  cover: number;
  mass: [number, number, number];
  activity: number;
}


export class MorphoGL {
  private readonly gl: WebGL2RenderingContext;
  private readonly progs: Record<'occ' | 'near' | 'field' | 'step' | 'stamp' | 'stats' | 'show', WebGLProgram>;
  private occTex: WebGLTexture[] = [];
  private occFb: WebGLFramebuffer[] = [];
  private CW = 1;
  private CH = 1;
  private readonly locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private tex: WebGLTexture[] = [];
  private auxTex: WebGLTexture[] = [];
  private fbs: WebGLFramebuffer[] = [];
  private kern: WebGLTexture | null = null;
  private fieldTex: WebGLTexture[] = [];
  private fieldFb: WebGLFramebuffer | null = null;
  private statsTex: WebGLTexture | null = null;
  private statsFb: WebGLFramebuffer | null = null;
  private statsH = 1;
  private lastBlocks: Float32Array | null = null;
  private cur = 0;
  private pending: Stamp[] = [];
  regime!: Regime;
  display: DisplaySettings = DEFAULT_SETTINGS.display;
  /** Brightness multiplier for crossfades (0 = black). */
  dim = 1;
  private timer: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null; open: WebGLQuery | null; pending: WebGLQuery[]; ns: number };
  used: [boolean, boolean, boolean] = [true, true, true];
  W = 0;
  H = 0;

  constructor(canvas: HTMLCanvasElement, private readonly rand: () => number) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float render targets are not available');
    this.gl = gl;
    this.timer = { ext: gl.getExtension('EXT_disjoint_timer_query_webgl2'), open: null, pending: [], ns: 0 };
    this.progs = { occ: compile(gl, OCC_FS), near: compile(gl, NEAR_FS), field: compile(gl, FIELD_FS), step: compile(gl, STEP_FS), stamp: compile(gl, STAMP_FS), stats: compile(gl, STATS_FS), show: compile(gl, SHOW_FS) };
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  private u(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.locs.get(prog);
    if (!m) this.locs.set(prog, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  /** Loads a regime's physics. The field itself is kept: the new law acts on what is there. */
  setRegime(reg: Regime): void {
    if (reg.kernels.length > MAX_KERNELS) throw new Error(`at most ${MAX_KERNELS} kernels`);
    const gl = this.gl;
    // Same kernels and radius as last time (only the flow/phase knobs moved): keep the kernel texture.
    const sameLaw = this.kern && this.regime && this.regime.kernels === reg.kernels && this.regime.R === reg.R;
    this.regime = reg;
    this.used = [0, 1, 2].map((c) => reg.kernels.some((k) => k.c1 === c)) as [boolean, boolean, boolean];
    const Rc = reach(reg.R);
    const n = (2 * Rc + 1) ** 2;
    const groups = Math.ceil(reg.kernels.length / 4);
    if (!sameLaw) {
      const data = new Float32Array(n * groups * 4);
      reg.kernels.forEach((k, j) => {
        const w = kernelWeights(reg.R, k);
        const g = j >> 2, lane = j & 3;
        for (let i = 0; i < n; i++) data[(g * n + i) * 4 + lane] = w[i];
      });
      if (this.kern) gl.deleteTexture(this.kern);
      this.kern = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.kern);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, groups, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }

    const f = this.progs.field;
    gl.useProgram(f);
    const src = new Float32Array(MAX_KERNELS * 4);
    const grow = new Float32Array(MAX_KERNELS * 4);
    reg.kernels.forEach((k, j) => {
      src[j * 4 + k.c0] = 1;
      grow.set([k.m, k.s, k.h, k.c1], j * 4);
    });
    gl.uniform4fv(this.u(f, 'uSrc'), src);
    gl.uniform4fv(this.u(f, 'uGrow'), grow);
    gl.uniform1i(this.u(f, 'uR'), Rc);
    gl.uniform1i(this.u(f, 'uGroups'), groups);
    gl.uniform1f(this.u(f, 'uDmu'), 0);
    gl.uniform1f(this.u(f, 'uSpec'), reg.speciation ?? 0);
    gl.uniform1f(this.u(f, 'uVortMu'), reg.vortexMu ?? 0);
    const p = this.progs.step;
    gl.useProgram(p);
    gl.uniform1i(this.u(p, 'uR'), Rc);
    gl.uniform1f(this.u(p, 'uFlow'), reg.flow ?? 0);
    gl.uniform1f(this.u(p, 'uCurl'), reg.curl ?? 0);
    gl.uniform1f(this.u(p, 'uSpec'), reg.speciation ?? 0);
    gl.uniform1f(this.u(p, 'uDt'), 1 / reg.T);
    gl.uniform1f(this.u(p, 'uOmega'), reg.omega);
    gl.uniform1f(this.u(p, 'uSync'), reg.sync);
    gl.uniform1f(this.u(p, 'uSwirl'), reg.swirl);
    gl.uniform3f(this.u(p, 'uUsed'), ...(this.used.map(Number) as [number, number, number]));
    const ring: number[] = [];
    for (let i = 0; i < RING_TAPS; i++) {
      const r = (reg.R * (1 + Math.floor(i / 8))) / 3, a = (i % 8) * Math.PI / 4 + (i >= 8 && i < 16 ? Math.PI / 8 : 0);
      ring.push(Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a)));
    }
    gl.uniform2fv(this.u(p, 'uRing'), ring);
  }

  /** An empty W×H world (the caller seeds it). */
  reset(W: number, H: number): void {
    const gl = this.gl;
    for (const t of [...this.tex, ...this.auxTex]) gl.deleteTexture(t);
    for (const f of this.fbs) gl.deleteFramebuffer(f);
    this.W = W;
    this.H = H;
    this.tex = [];
    this.auxTex = [];
    this.fbs = [];
    for (let k = 0; k < 2; k++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const ax = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, ax);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, ax, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.tex.push(t);
      this.auxTex.push(ax);
      this.fbs.push(fb);
    }
    for (const t of this.fieldTex) gl.deleteTexture(t);
    if (this.fieldFb) gl.deleteFramebuffer(this.fieldFb);
    this.fieldFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFb);
    this.fieldTex = [0, 1].map((k) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0);
      return t;
    });
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    // Occupancy maps (R32F so the 1e-4 threshold compares exactly as in the field pass).
    for (const t of this.occTex) gl.deleteTexture(t);
    for (const f of this.occFb) gl.deleteFramebuffer(f);
    this.CW = Math.ceil(W / BLOCK);
    this.CH = Math.ceil(H / BLOCK);
    this.occTex = [];
    this.occFb = [];
    for (let k = 0; k < 2; k++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.CW, this.CH, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.occTex.push(t);
      this.occFb.push(fb);
    }
    this.statsH = Math.max(1, Math.round((STATS_W * H) / W));
    if (this.statsTex) gl.deleteTexture(this.statsTex);
    if (this.statsFb) gl.deleteFramebuffer(this.statsFb);
    this.statsTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.statsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, STATS_W, this.statsH, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.statsFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.statsTex, 0);
    this.lastBlocks = null;
    this.cur = 0;
    this.pending = [];
  }

  stamp(s: Stamp): void {
    this.pending.push(s);
  }

  /** A seed of the regime's own kind at (x, y), its shape drawn from the dice. Returns the harmonic m for rings. */
  seed(x: number, y: number, kind = this.regime.seed): number {
    const R = this.regime.R, q = this.rand;
    const amp = this.used.map((u) => (u ? 0.5 + 0.5 * q() : 0)) as [number, number, number];
    if (kind === 'patches') {
      this.stamp({ kind: 'patch', x, y, size: R, amp, phase: q(), genome: q() * 2 - 1 });
      return 0;
    }
    const m = [3, 4, 5, 6, 8][Math.floor(q() * 5)];
    this.stamp({ kind: 'ring', x, y, size: R * (0.5 + 0.5 * q()), width: R * 0.2, m, phase: q(), amp, winding: q() < 0.5 ? 1 : -1, genome: q() * 2 - 1 });
    return m;
  }

  private bindState(prog: WebGLProgram, unit = 0): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.uniform1i(this.u(prog, 'uState'), unit);
    gl.uniform2i(this.u(prog, 'uSize'), this.W, this.H);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.auxTex[this.cur]);
    gl.uniform1i(this.u(prog, 'uAux'), 3);
  }

  private flushStamps(): void {
    const gl = this.gl;
    while (this.pending.length) {
      const batch = this.pending.splice(0, MAX_STAMPS);
      const a: number[] = [], b: number[] = [], c: number[] = [], g: number[] = [];
      for (const s of batch) {
        g.push(s.genome ?? 0);
        a.push(s.x, s.y, s.size, ['patch', 'ring', 'erase', 'stir', 'ripple', 'clone'].indexOf(s.kind));
        b.push(s.drag ? s.drag[0] : s.m ?? 0, s.drag ? s.drag[1] : s.phase ?? 0, s.width ?? 1, Math.floor(this.rand() * 60000));
        c.push(...(s.amp ?? [0, 0, 0]), s.winding ?? 0);
      }
      const p = this.progs.stamp;
      gl.useProgram(p);
      this.bindState(p);
      gl.uniform1i(this.u(p, 'uCount'), batch.length);
      gl.uniform4fv(this.u(p, 'uA'), a);
      gl.uniform4fv(this.u(p, 'uB'), b);
      gl.uniform4fv(this.u(p, 'uC'), c);
      gl.uniform1fv(this.u(p, 'uG'), g);
      gl.viewport(0, 0, this.W, this.H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbs[1 - this.cur]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = 1 - this.cur;
    }
  }

  /** Global growth-centre offset (the Director's mass homeostasis). */
  setDmu(dmu: number): void {
    this.gl.useProgram(this.progs.field);
    this.gl.uniform1f(this.u(this.progs.field, 'uDmu'), dmu);
  }

  advance(): void {
    const gl = this.gl;
    this.flushStamps();
    // Where is there mass, and which blocks have any within reach?
    const oc = this.progs.occ;
    gl.useProgram(oc);
    this.bindState(oc, 0);
    gl.uniform1i(this.u(oc, 'uBlock'), BLOCK);
    gl.viewport(0, 0, this.CW, this.CH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.occFb[0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const nr = this.progs.near;
    gl.useProgram(nr);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex[0]);
    gl.uniform1i(this.u(nr, 'uOcc'), 0);
    gl.uniform2i(this.u(nr, 'uCSize'), this.CW, this.CH);
    gl.uniform1i(this.u(nr, 'uReach'), Math.ceil(reach(this.regime.R) / BLOCK) + 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.occFb[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const f = this.progs.field;
    gl.useProgram(f);
    this.bindState(f, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.kern);
    gl.uniform1i(this.u(f, 'uKern'), 1);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex[1]);
    gl.uniform1i(this.u(f, 'uNear'), 4);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.occTex[0]);
    gl.uniform1i(this.u(f, 'uOcc'), 5);
    gl.uniform1i(this.u(f, 'uBlock'), BLOCK);
    gl.uniform1i(this.u(f, 'uReach'), Math.ceil(reach(this.regime.R) / BLOCK) + 1);
    gl.viewport(0, 0, this.W, this.H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const p = this.progs.step;
    gl.useProgram(p);
    this.bindState(p, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex[0]);
    gl.uniform1i(this.u(p, 'uP0'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex[1]);
    gl.uniform1i(this.u(p, 'uP1'), 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbs[1 - this.cur]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = 1 - this.cur;
  }

  /** Whether the GPU can time its own work (EXT_disjoint_timer_query_webgl2). */
  get canTime(): boolean { return !!this.timer.ext; }

  /** Brackets one frame's GPU work; results arrive a few frames later through gpuNs(). */
  beginTiming(): void {
    const t = this.timer;
    if (!t.ext || t.open || t.pending.length > 6) return;
    t.open = this.gl.createQuery();
    if (t.open) this.gl.beginQuery(t.ext.TIME_ELAPSED_EXT, t.open);
  }
  endTiming(): void {
    const t = this.timer;
    if (!t.ext || !t.open) return;
    this.gl.endQuery(t.ext.TIME_ELAPSED_EXT);
    t.pending.push(t.open);
    t.open = null;
  }
  /** GPU nanoseconds finished since the last call (whole frames only), or null if timing is unavailable. */
  gpuNs(): number | null {
    const t = this.timer, gl = this.gl;
    if (!t.ext) return null;
    const disjoint = gl.getParameter(t.ext.GPU_DISJOINT_EXT);
    let ns = 0;
    while (t.pending.length && gl.getQueryParameter(t.pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = t.pending.shift()!;
      if (!disjoint) ns += gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      gl.deleteQuery(q);
    }
    return ns;
  }

  /**
   * The centre of a well-populated stats block (from the last stats() read), chosen at random among
   * the densest few, or null if nothing lives. Good enough to find an organism to copy.
   */
  findLife(): [number, number] | null {
    const b = this.lastBlocks;
    if (!b) return null;
    const idx: number[] = [];
    for (let i = 0; i < b.length / 4; i++) if (b[i * 4 + 3] > 0.15) idx.push(i);
    if (!idx.length) return null;
    idx.sort((i, j) => b[j * 4 + 3] - b[i * 4 + 3]);
    const i = idx[Math.floor(this.rand() * Math.min(6, idx.length))];
    return [((i % STATS_W) + 0.5) * (this.W / STATS_W), (Math.floor(i / STATS_W) + 0.5) * (this.H / this.statsH)];
  }

  /** Reads the coarse statistics back (a small synchronous read; call every few dozen steps). */
  stats(): FieldStats {
    const gl = this.gl;
    const p = this.progs.stats;
    gl.useProgram(p);
    this.bindState(p);
    gl.uniform2f(this.u(p, 'uBlock'), this.W / STATS_W, this.H / this.statsH);
    gl.uniform1f(this.u(p, 'uUsed'), Math.max(1, this.used.filter(Boolean).length));
    gl.viewport(0, 0, STATS_W, this.statsH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFb);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Float32Array(STATS_W * this.statsH * 4);
    gl.readPixels(0, 0, STATS_W, this.statsH, gl.RGBA, gl.FLOAT, px);
    const n = STATS_W * this.statsH;
    const mass: [number, number, number] = [0, 0, 0];
    let cover = 0, act = 0;
    for (let i = 0; i < n; i++) {
      mass[0] += px[i * 4]; mass[1] += px[i * 4 + 1]; mass[2] += px[i * 4 + 2]; cover += px[i * 4 + 3];
      if (this.lastBlocks) for (let c = 0; c < 3; c++) act += Math.abs(px[i * 4 + c] - this.lastBlocks[i * 4 + c]);
    }
    this.lastBlocks = px;
    return { cover: cover / n, mass: mass.map((v) => v / n) as [number, number, number], activity: (act / n) * 1000 };
  }

  /** `blend` < 1 shows the world that far between the previous step and the current one. */
  draw(width: number, height: number, blend = 1): void {
    const gl = this.gl;
    const p = this.progs.show;
    gl.useProgram(p);
    this.bindState(p);
    gl.uniform2f(this.u(p, 'uView'), width, height);
    const d = this.display;
    gl.uniform3fv(this.u(p, 'uCol'), d.colours.flat());
    gl.uniform3fv(this.u(p, 'uBg'), d.background);
    gl.uniform3fv(this.u(p, 'uHaloCol'), d.haloColour);
    gl.uniform1i(this.u(p, 'uFilter'), d.filter === 'bicubic' ? 1 : 0);
    const f = (name: string, v: number) => gl.uniform1f(this.u(p, name), v);
    f('uExposure', d.exposure * this.dim); f('uBody', d.body); f('uEdge', d.edge); f('uHalo', d.halo); f('uHaloR', d.haloRadius);
    f('uCrests', d.crests); f('uRelief', d.relief); f('uIrid', d.iridescence); f('uSpec', d.specular);
    f('uPellicle', d.pellicle); f('uNucleus', d.nucleus); f('uVort', d.vorticity);
    f('uGeneTint', this.regime.speciation ? d.geneTint : 0);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[1 - this.cur]);
    gl.uniform1i(this.u(p, 'uPrev'), 6);
    f('uBlend', blend);
    f('uTone', d.tonemap); f('uGrain', d.grain); f('uVignette', d.vignette);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

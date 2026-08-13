/**
 * noise.js — 4D OpenSimplex-style noise used for particle motion.
 * Ported verbatim from the original single-file build so the swarm behaves
 * exactly as before.
 */
export class SimplexNoise {
  constructor(seed = Math.random()) {
    this.p = new Uint8Array(512);
    this.perm = new Uint8Array(512);

    for (let i = 0; i < 256; i += 1) {
      this.p[i] = i;
    }

    let n;
    let q;
    for (let i = 255; i > 0; i -= 1) {
      n = Math.floor((seed + i) * 123456.789) % (i + 1);
      q = this.p[i];
      this.p[i] = this.p[n];
      this.p[n] = q;
    }

    for (let i = 0; i < 512; i += 1) {
      this.perm[i] = this.p[i & 255];
    }
  }

  noise4D(x, y, z, w) {
    const F4 = 0.309016994;
    const G4 = 0.138196601;

    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const l = Math.floor(w + s);

    const t = (i + j + k + l) * G4;
    const X0 = i - t;
    const Y0 = j - t;
    const Z0 = k - t;
    const W0 = l - t;

    const x0 = x - X0;
    const y0 = y - Y0;
    const z0 = z - Z0;
    const w0 = w - W0;

    let rankx = 0;
    let ranky = 0;
    let rankz = 0;
    let rankw = 0;

    if (x0 > y0) rankx += 1; else ranky += 1;
    if (x0 > z0) rankx += 1; else rankz += 1;
    if (x0 > w0) rankx += 1; else rankw += 1;
    if (y0 > z0) ranky += 1; else rankz += 1;
    if (y0 > w0) ranky += 1; else rankw += 1;
    if (z0 > w0) rankz += 1; else rankw += 1;

    const i1 = rankx >= 3 ? 1 : 0;
    const j1 = ranky >= 3 ? 1 : 0;
    const k1 = rankz >= 3 ? 1 : 0;
    const l1 = rankw >= 3 ? 1 : 0;

    const i2 = rankx >= 2 ? 1 : 0;
    const j2 = ranky >= 2 ? 1 : 0;
    const k2 = rankz >= 2 ? 1 : 0;
    const l2 = rankw >= 2 ? 1 : 0;

    const i3 = rankx >= 1 ? 1 : 0;
    const j3 = ranky >= 1 ? 1 : 0;
    const k3 = rankz >= 1 ? 1 : 0;
    const l3 = rankw >= 1 ? 1 : 0;

    const x1 = x0 - i1 + G4;
    const y1 = y0 - j1 + G4;
    const z1 = z0 - k1 + G4;
    const w1 = w0 - l1 + G4;

    const x2 = x0 - i2 + 2 * G4;
    const y2 = y0 - j2 + 2 * G4;
    const z2 = z0 - k2 + 2 * G4;
    const w2 = w0 - l2 + 2 * G4;

    const x3 = x0 - i3 + 3 * G4;
    const y3 = y0 - j3 + 3 * G4;
    const z3 = z0 - k3 + 3 * G4;
    const w3 = w0 - l3 + 3 * G4;

    const x4 = x0 - 1 + 4 * G4;
    const y4 = y0 - 1 + 4 * G4;
    const z4 = z0 - 1 + 4 * G4;
    const w4 = w0 - 1 + 4 * G4;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const ll = l & 255;

    let n0;
    let n1;
    let n2;
    let n3;
    let n4;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
    if (t0 < 0) {
      n0 = 0;
    } else {
      t0 *= t0;
      n0 = t0 * t0 * this.grad4(this.perm[ii + this.perm[jj + this.perm[kk + this.perm[ll]]]], x0, y0, z0, w0);
    }

    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
    if (t1 < 0) {
      n1 = 0;
    } else {
      t1 *= t1;
      n1 = t1 * t1 * this.grad4(this.perm[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1 + this.perm[ll + l1]]]], x1, y1, z1, w1);
    }

    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
    if (t2 < 0) {
      n2 = 0;
    } else {
      t2 *= t2;
      n2 = t2 * t2 * this.grad4(this.perm[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2 + this.perm[ll + l2]]]], x2, y2, z2, w2);
    }

    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
    if (t3 < 0) {
      n3 = 0;
    } else {
      t3 *= t3;
      n3 = t3 * t3 * this.grad4(this.perm[ii + i3 + this.perm[jj + j3 + this.perm[kk + k3 + this.perm[ll + l3]]]], x3, y3, z3, w3);
    }

    let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
    if (t4 < 0) {
      n4 = 0;
    } else {
      t4 *= t4;
      n4 = t4 * t4 * this.grad4(this.perm[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1 + this.perm[ll + 1]]]], x4, y4, z4, w4);
    }

    return 27 * (n0 + n1 + n2 + n3 + n4);
  }

  grad4(hash, x, y, z, w) {
    const h = hash & 31;
    const a = y;
    const b = z;
    const c = w;
    switch (h >> 3) {
      case 1: return (h & 1 ? -a : a) + (h & 2 ? -b : b) + (h & 4 ? -c : c);
      case 2: return (h & 1 ? -x : x) + (h & 2 ? -b : b) + (h & 4 ? -c : c);
      case 3: return (h & 1 ? -x : x) + (h & 2 ? -a : a) + (h & 4 ? -c : c);
      default: return (h & 1 ? -x : x) + (h & 2 ? -a : a) + (h & 4 ? -b : b);
    }
  }
}

// 4D rigid body simulation.
//
// Each body has a position x (vec4), velocity v, rotation R (4x4) and angular
// momentum L (a bivector with 6 rotation planes). Angular velocity is
// ω = I⁻¹L, with the inertia tensor diagonal in the body's bivector basis
// (I_ij = m(E[x_i²] + E[x_j²])).
//
// Contacts come from colliders.js and are solved with sequential impulses,
// friction, restitution and a separate position correction pass.

import * as V from '../math/vec4.js';
import * as R4 from '../math/rot4.js';
import { Collider } from './colliders.js';

const GRAVITY = [0, -9.81, 0, 0];

let nextId = 1;

export class Body4 {
  constructor(desc, scale, { mass = 1, restitution = 0.3, friction = 0.55 } = {}) {
    this.id = nextId++;
    this.collider = new Collider(desc, scale);
    this.x = [0, 0, 0, 0];
    this.v = [0, 0, 0, 0];
    this.R = R4.mat4();
    this.L = R4.biv();
    this.w = R4.biv(); // angular velocity (world)
    this.mass = mass;
    this.invMass = mass > 0 ? 1 / mass : 0;
    this.restitution = restitution;
    this.friction = friction;
    const m = this.collider.moments;
    this.inertia = R4.PLANES.map(([i, j]) => mass * (m[i] + m[j]));
    this.invInertia = this.inertia.map((I) => (I > 0 ? 1 / I : 0));
    const i0 = this.inertia[0];
    this.isotropic = this.inertia.every((I) => Math.abs(I - i0) < i0 * 1e-3);
    this.sleeping = false;
    this.sleepTimer = 0;
    this.kinematic = false; // immovable, optionally driven along target (fixed scenery)
    this.held = false;      // dynamic but velocity-driven towards target (grabbed by a hand)
    this.target = null;     // { x, R }
    this.baseInvMass = this.invMass;
    this.userData = null;
    this.lastImpact = 0;
    this.enabled = true;
  }

  get bound() { return this.collider.bound; }

  wake() { this.sleeping = false; this.sleepTimer = 0; }

  /** ω = I⁻¹ L, evaluated in the body frame. */
  updateOmega() {
    if (this.kinematic) return;
    if (this.isotropic) {
      for (let k = 0; k < 6; k++) this.w[k] = this.L[k] * this.invInertia[0];
      return;
    }
    const b = R4.bivRotateInv(_b1, this.R, this.L);
    for (let k = 0; k < 6; k++) b[k] *= this.invInertia[k];
    R4.bivRotate(this.w, this.R, b);
  }

  /** Apply I⁻¹ (world) to a bivector. */
  invInertiaWorld(out, B) {
    if (this.kinematic || this.sleeping || this.invMass === 0) { out.fill(0); return out; }
    if (this.isotropic) {
      for (let k = 0; k < 6; k++) out[k] = B[k] * this.invInertia[0];
      return out;
    }
    const b = R4.bivRotateInv(_b2, this.R, B);
    for (let k = 0; k < 6; k++) b[k] *= this.invInertia[k];
    return R4.bivRotate(out, this.R, b);
  }

  velocityAt(out, r) {
    R4.bivApply(out, this.w, r);
    return V.add(out, out, this.v);
  }

  applyImpulse(J, r) {
    if (this.kinematic || this.sleeping || this.invMass === 0) return;
    V.addScaled(this.v, this.v, J, this.invMass);
    R4.angularImpulse(_b3, r, J);
    for (let k = 0; k < 6; k++) this.L[k] += _b3[k];
    this.invInertiaWorld(_b4, _b3);
    for (let k = 0; k < 6; k++) this.w[k] += _b4[k];
  }

  /** Velocity change at r per unit impulse J applied at r. */
  responseAt(out, r, J) {
    if (this.kinematic || this.sleeping || this.invMass === 0) return V.set(out, 0, 0, 0, 0);
    R4.angularImpulse(_b3, r, J);
    this.invInertiaWorld(_b4, _b3);
    R4.bivApply(out, _b4, r);
    return V.addScaled(out, out, J, this.invMass);
  }

  setAngularVelocity(B) {
    // L = I ω (through the body frame)
    if (this.isotropic) {
      for (let k = 0; k < 6; k++) this.L[k] = B[k] * this.inertia[0];
    } else {
      const b = R4.bivRotateInv(_b1, this.R, B);
      for (let k = 0; k < 6; k++) b[k] *= this.inertia[k];
      R4.bivRotate(this.L, this.R, b);
    }
    this.updateOmega();
  }
}

const _b1 = R4.biv(), _b2 = R4.biv(), _b3 = R4.biv(), _b4 = R4.biv();
const _pw = [0, 0, 0, 0], _pl = [0, 0, 0, 0], _n = [0, 0, 0, 0], _t = [0, 0, 0, 0];
const _va = [0, 0, 0, 0], _vb = [0, 0, 0, 0], _rel = [0, 0, 0, 0], _J = [0, 0, 0, 0];
const _tmp = [0, 0, 0, 0], _ps = [0, 0, 0, 0];
const _M = R4.mat4(), _Om = R4.mat4();
let _minD = new Float64Array(64), _kept = new Uint8Array(64); // _reduce scratch

const STATIC = { id: 0, invMass: 0, kinematic: true, x: [0, 0, 0, 0], v: [0, 0, 0, 0], w: R4.biv(), sleeping: false, friction: 0.6, restitution: 0.3,
  velocityAt(out) { return V.set(out, 0, 0, 0, 0); }, applyImpulse() {}, responseAt(out) { return V.set(out, 0, 0, 0, 0); }, wake() {} };

export class World4 {
  constructor({ floorY = 0, wallRadius = Infinity, wRange = Infinity, gravity = GRAVITY } = {}) {
    this.bodies = [];
    this.floorY = floorY;
    this.wallRadius = wallRadius;
    this.wRange = wRange;
    this.gravity = gravity.slice();
    this.dt = 1 / 120;
    this.iterations = 10;
    this.accum = 0;
    this.time = 0;
    this.contacts = [];
    this._free = []; // recycled contact objects
    this.onImpact = null; // (point, speed, bodyA, bodyB)
    this.linearDamping = 0.02;
    this.angularDamping = 0.06;
  }

  add(body) { this.bodies.push(body); return body; }

  remove(body) { this.bodies = this.bodies.filter((b) => b !== body); }

  clear() { this.bodies = []; }

  step(frameDt) {
    this.accum = Math.min(this.accum + frameDt, this.dt * 5);
    const steps = Math.floor(this.accum / this.dt);
    for (let i = 0; i < steps; i++) {
      // kinematic (held) bodies are eased towards their target over the substeps
      this._substep(this.dt, 1 / (steps - i));
      this.accum -= this.dt;
    }
  }

  _substep(dt, kinFraction) {
    this.time += dt;
    this._dt = dt;
    const bodies = this.bodies;

    // 1. Kinematic targets & gravity
    for (const b of bodies) {
      if (!b.enabled) continue;
      if (b.kinematic) {
        if (b.target) this._driveKinematic(b, dt, kinFraction);
        continue;
      }
      if (b.held && b.target) { this._driveHeld(b, dt); continue; }
      if (b.sleeping) continue;
      V.addScaled(b.v, b.v, this.gravity, dt);
      b.updateOmega();
    }

    // 2. Contacts
    for (const c of this.contacts) this._free.push(c);
    this.contacts.length = 0;
    this._collide();

    // 3. Velocity solve
    const contacts = this.contacts;
    for (const c of contacts) this._prepare(c, dt);
    for (let it = 0; it < this.iterations; it++) {
      for (const c of contacts) this._solve(c);
    }

    // 4. Integrate
    for (const b of bodies) {
      if (!b.enabled || b.kinematic || b.sleeping) continue;
      const ld = Math.exp(-this.linearDamping * dt), ad = Math.exp(-this.angularDamping * dt);
      V.scale(b.v, b.v, ld);
      for (let k = 0; k < 6; k++) b.L[k] *= ad;
      b.updateOmega();
      V.addScaled(b.x, b.x, b.v, dt);
      R4.expBivector(_M, b.w, dt);
      R4.multiply(b.R, _M, b.R);
      b.updateOmega(); // L is conserved, ω follows the new orientation (precession)
      if (!b.held) this._sleepCheck(b, dt);
    }

    // 5. Position correction (changes positions only, not velocities)
    for (const c of contacts) {
      const a = c.a, b = c.b;
      const corr = Math.max(0, c.depth - 0.0015) * 0.35;
      if (corr <= 0) continue;
      const wa = a.kinematic ? 0 : a.invMass, wb = b.kinematic ? 0 : b.invMass;
      const sum = wa + wb;
      if (sum <= 0) continue;
      if (!a.sleeping) V.addScaled(a.x, a.x, c.n, -corr * wa / sum);
      if (!b.sleeping) V.addScaled(b.x, b.x, c.n, corr * wb / sum);
    }
  }

  _driveKinematic(b, dt, f) {
    const t = b.target;
    V.sub(_tmp, t.x, b.x);
    V.scale(_tmp, _tmp, f);
    V.scale(b.v, _tmp, 1 / dt);
    V.add(b.x, b.x, _tmp);
    // angular velocity from the rotation delta: Ω ≈ skew(Rt Rᵀ)/dt
    R4.transpose(_M, b.R);
    R4.multiply(_Om, t.R, _M);
    for (let k = 0; k < 6; k++) {
      const [i, j] = R4.PLANES[k];
      b.w[k] = (_Om[i * 4 + j] - _Om[j * 4 + i]) * 0.5 * f / dt;
    }
    for (let e = 0; e < 16; e++) b.R[e] += (t.R[e] - b.R[e]) * f;
    R4.orthonormalize(b.R);
  }

  /**
   * Held bodies are moved by setting their velocity towards the target
   * instead of their position, so they still collide with walls and push
   * other bodies.
   */
  _driveHeld(b, dt) {
    const t = b.target;
    b.sleeping = false;
    b.sleepTimer = 0;
    V.sub(_tmp, t.x, b.x);
    V.scale(b.v, _tmp, 0.55 / dt);
    const sp = V.length(b.v);
    if (sp > 4) V.scale(b.v, b.v, 4 / sp);
    R4.transpose(_M, b.R);
    R4.multiply(_Om, t.R, _M);
    const B = _b1;
    for (let k = 0; k < 6; k++) {
      const [i, j] = R4.PLANES[k];
      B[k] = (_Om[i * 4 + j] - _Om[j * 4 + i]) * 0.5 * 0.55 / dt;
    }
    b.setAngularVelocity(B);
  }

  _sleepCheck(b, dt) {
    const r = b.bound;
    const e = V.lengthSq(b.v) + R4.bivNorm(b.w) ** 2 * r * r;
    if (e < 0.0009 * Math.max(0.3, r * 8)) {
      b.sleepTimer += dt;
      if (b.sleepTimer > 0.7) {
        b.sleeping = true;
        V.set(b.v, 0, 0, 0, 0);
        b.L.fill(0);
        b.w.fill(0);
      }
    } else b.sleepTimer = 0;
  }

  // ---------------------------------------------------------------------------
  // Collision detection

  /** Contact margin based on speed, so fast bodies don't pass through thin objects. */
  _spec(b) {
    if (!b || b.invMass === 0) return 0;
    return Math.min(0.05, (V.length(b.v) + R4.bivNorm(b.w) * b.bound) * this._dt);
  }

  _addContact(a, b, p, n, depth) {
    const c = this._free.pop() || { p: [0, 0, 0, 0], n: [0, 0, 0, 0], jt: [0, 0, 0, 0], ra: [0, 0, 0, 0], rb: [0, 0, 0, 0] };
    c.a = a; c.b = b; c.depth = depth; c.jn = 0; c.kn = 0; c.bias = 0; c.mu = 0;
    V.copy(c.p, p); V.copy(c.n, n); c.jt.fill(0);
    this.contacts.push(c);
  }

  _collide() {
    const bodies = this.bodies;
    const floor = this.floorY;
    for (const b of bodies) {
      if (!b.enabled || b.kinematic || b.sleeping) continue;
      this._collideStatic(b, floor);
    }
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i];
      if (!A.enabled) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j];
        if (!B.enabled) continue;
        if ((A.sleeping && B.sleeping) || (A.kinematic && B.kinematic)) continue;
        if ((A.sleeping && B.kinematic) || (B.sleeping && A.kinematic)) {
          const k = A.kinematic ? A : B;
          if (V.lengthSq(k.v) < 1e-5 && R4.bivNorm(k.w) < 1e-3) continue;
        }
        const rr = A.bound + B.bound + 0.004;
        if (V.distance(A.x, B.x) > rr) continue;
        const before = this.contacts.length;
        this._collidePair(A, B);
        if (this.contacts.length > before) {
          if (A.sleeping && !B.sleeping && (V.lengthSq(B.v) > 0.01 || B.kinematic)) A.wake();
          if (B.sleeping && !A.sleeping && (V.lengthSq(A.v) > 0.01 || A.kinematic)) B.wake();
          this._reduce(before);
        }
      }
    }
  }

  _collideStatic(b, floor) {
    const col = b.collider;
    const before = this.contacts.length;
    const R = this.wallRadius, W = this.wRange;
    const tol = 0.001 + this._spec(b);
    const nearFloor = b.x[1] - col.bound < floor + 0.002 + tol;
    const nearWall = Math.sqrt(b.x[0] * b.x[0] + b.x[2] * b.x[2]) + col.bound > R;
    const nearW = Math.abs(b.x[3]) + col.bound > W;
    if (!nearFloor && !nearWall && !nearW) return;

    if (col.type === 'sphere') {
      this._testStatic(b, b.x, col.r, tol, floor, nearFloor, nearWall, nearW);
    } else {
      for (const s of col.samples) {
        R4.apply(_ps, b.R, s);
        V.add(_ps, _ps, b.x);
        this._testStatic(b, _ps, 0, tol, floor, nearFloor, nearWall, nearW);
      }
    }
    if (this.contacts.length > before) this._reduce(before);
  }

  /** Point p (with radius) against the floor, the round wall and the ±w walls. */
  _testStatic(b, p, radius, tol, floor, nearFloor, nearWall, nearW) {
    if (nearFloor) {
      const d = p[1] - radius - floor;
      if (d < tol) { V.set(_n, 0, 1, 0, 0); V.copy(_pw, p); _pw[1] -= radius; this._addContact(STATIC, b, _pw, _n, -d); }
    }
    if (nearWall) {
      const R = this.wallRadius;
      const rad = Math.sqrt(p[0] * p[0] + p[2] * p[2]);
      const d = R - (rad + radius);
      if (d < tol && rad > 1e-6) {
        V.set(_n, -p[0] / rad, 0, -p[2] / rad, 0);
        V.addScaled(_pw, p, _n, -radius);
        this._addContact(STATIC, b, _pw, _n, -d);
      }
    }
    if (nearW) {
      const W = this.wRange;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const d = W - (sgn * p[3] + radius);
        if (d < tol) { V.set(_n, 0, 0, 0, -sgn); V.copy(_pw, p); _pw[3] += sgn * radius; this._addContact(STATIC, b, _pw, _n, -d); }
      }
    }
  }

  _collidePair(A, B) {
    const ca = A.collider, cb = B.collider;
    this._tol = 0.001 + this._spec(A) + this._spec(B);
    if (ca.type === 'sphere' && cb.type === 'sphere') {
      V.sub(_t, B.x, A.x);
      const d = V.length(_t);
      const pen = ca.r + cb.r - d;
      if (pen > -this._tol && d > 1e-9) {
        V.scale(_n, _t, 1 / d);
        V.addScaled(_pw, A.x, _n, ca.r - pen * 0.5);
        this._addContact(A, B, _pw, _n, pen);
      }
      return;
    }
    if (ca.type === 'sphere') { this._sphereVs(A, B, true); return; }
    if (cb.type === 'sphere') { this._sphereVs(B, A, false); return; }
    this._samplesVs(A, B);
    this._samplesVs(B, A);
  }

  /** Sphere S against a general body G. */
  _sphereVs(S, G, sphereIsA) {
    const cg = G.collider;
    V.sub(_tmp, S.x, G.x);
    R4.applyT(_pl, G.R, _tmp);
    const d = cg.sdf(_pl, this._tol + S.collider.r) - S.collider.r;
    if (d > this._tol) return;
    cg.normal(_pl, _t);
    R4.apply(_n, G.R, _t); // outward from G, towards S
    V.addScaled(_pw, S.x, _n, -S.collider.r);
    if (sphereIsA) { V.scale(_n, _n, -1); this._addContact(S, G, _pw, _n, -d); }
    else this._addContact(G, S, _pw, _n, -d);
  }

  /** Samples of P tested against the SDF of Q: contacts pushing P away from Q. */
  _samplesVs(P, Q) {
    const cq = Q.collider;
    const reach = cq.bound + 0.002 + this._tol;
    for (const s of P.collider.samples) {
      R4.apply(_pw, P.R, s);
      V.add(_pw, _pw, P.x);
      V.sub(_tmp, _pw, Q.x);
      if (V.lengthSq(_tmp) > reach * reach) continue;
      R4.applyT(_pl, Q.R, _tmp);
      const d = cq.sdf(_pl, this._tol);
      if (d > this._tol) continue;
      cq.normal(_pl, _t);
      R4.apply(_n, Q.R, _t); // from Q towards P
      this._addContact(Q, P, _pw, _n, -d);
    }
  }

  /** Keep at most 8 well-spread contacts per pair (deepest first). */
  _reduce(start) {
    const list = this.contacts;
    const count = list.length - start;
    if (count <= 8) return;
    const pool = list.splice(start, count);
    pool.sort((a, b) => b.depth - a.depth);
    // Farthest-point selection. Each candidate's distance to the nearest kept
    // contact is updated as contacts are kept (O(n) per pick, not O(n·kept)).
    if (_minD.length < count) { _minD = new Float64Array(count * 2); _kept = new Uint8Array(count * 2); }
    const minD = _minD, kept = _kept;
    for (let i = 0; i < count; i++) { minD[i] = Infinity; kept[i] = 0; }
    let last = 0;
    kept[0] = 1;
    list.push(pool[0]);
    for (let n = 1; n < 8; n++) {
      const lp = pool[last].p;
      let best = -1, bestD = -1;
      for (let i = 0; i < count; i++) {
        if (kept[i]) continue;
        const md = Math.min(minD[i], V.distance(pool[i].p, lp));
        minD[i] = md;
        if (md > bestD) { bestD = md; best = i; }
      }
      if (best < 0) break;
      kept[best] = 1;
      list.push(pool[best]);
      last = best;
    }
    for (let i = 0; i < count; i++) if (!kept[i]) this._free.push(pool[i]);
  }

  // ---------------------------------------------------------------------------
  // Solver

  _prepare(c, dt) {
    const a = c.a, b = c.b;
    V.sub(c.ra, c.p, a.x);
    V.sub(c.rb, c.p, b.x);
    const dva = a.responseAt(_va, c.ra, c.n);
    const dvb = b.responseAt(_vb, c.rb, c.n);
    c.kn = V.dot(c.n, dva) + V.dot(c.n, dvb);
    c.kn = c.kn > 1e-12 ? 1 / c.kn : 0;
    a.velocityAt(_va, c.ra);
    b.velocityAt(_vb, c.rb);
    V.sub(_rel, _vb, _va);
    const vn = V.dot(_rel, c.n);
    const e = Math.max(a.restitution, b.restitution);
    if (c.depth < 0) {
      c.bias = c.depth / dt; // speculative: may approach by the remaining gap, no further
    } else {
      c.bias = vn < -0.6 ? -e * vn : 0;
      c.bias += Math.max(0, c.depth - 0.003) * 2.0; // extra push-out for deep overlaps
    }
    c.mu = Math.sqrt(a.friction * b.friction);
    if (vn < -0.25 && c.depth > -0.002 && this.onImpact) {
      const t = this.time;
      if (t - (b.lastImpact || 0) > 0.07 && t - (a.lastImpact || 0) > 0.07) {
        b.lastImpact = t;
        if (a !== STATIC) a.lastImpact = t;
        this.onImpact(c.p, -vn, a, b);
      }
    }
  }

  _solve(c) {
    const a = c.a, b = c.b;
    if (c.kn === 0) return;
    // normal
    a.velocityAt(_va, c.ra);
    b.velocityAt(_vb, c.rb);
    V.sub(_rel, _vb, _va);
    const vn = V.dot(_rel, c.n);
    let dj = (c.bias - vn) * c.kn;
    const old = c.jn;
    c.jn = Math.max(0, old + dj);
    dj = c.jn - old;
    if (dj !== 0) {
      V.scale(_J, c.n, dj);
      b.applyImpulse(_J, c.rb);
      V.scale(_J, _J, -1);
      a.applyImpulse(_J, c.ra);
    }
    // friction (isotropic, clamped to the cone)
    a.velocityAt(_va, c.ra);
    b.velocityAt(_vb, c.rb);
    V.sub(_rel, _vb, _va);
    const vn2 = V.dot(_rel, c.n);
    V.addScaled(_t, _rel, c.n, -vn2); // tangential velocity
    const vt = V.length(_t);
    if (vt < 1e-7) return;
    V.scale(_t, _t, 1 / vt);
    const dva = a.responseAt(_va, c.ra, _t);
    const dvb = b.responseAt(_vb, c.rb, _t);
    const kt = V.dot(_t, dva) + V.dot(_t, dvb);
    if (kt < 1e-12) return;
    const jtMag = -vt / kt;
    const jt = c.jt;
    const nx = jt[0] + _t[0] * jtMag, ny = jt[1] + _t[1] * jtMag, nz = jt[2] + _t[2] * jtMag, nw = jt[3] + _t[3] * jtMag;
    const maxF = c.mu * c.jn;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    const s = len > maxF ? maxF / len : 1;
    _J[0] = nx * s - jt[0]; _J[1] = ny * s - jt[1]; _J[2] = nz * s - jt[2]; _J[3] = nw * s - jt[3];
    jt[0] = nx * s; jt[1] = ny * s; jt[2] = nz * s; jt[3] = nw * s;
    b.applyImpulse(_J, c.rb);
    V.scale(_J, _J, -1);
    a.applyImpulse(_J, c.ra);
  }
}

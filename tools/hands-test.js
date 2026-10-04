// Evaluated in the page by tools/smoke.mjs. Fakes two tracked hands and an
// XR session so the VR-only visuals (hands, pinch ring, ray, hand menu) can be
// checked in a headless screenshot.
(() => {
  const app = window.__app;
  const V3 = app.camera.position.constructor;
  const Q = app.camera.quaternion.constructor;
  Object.defineProperty(app, 'presenting', { get: () => true, configurable: true });
  app.input.update = () => {};
  app.camera.position.set(0, 1.5, 0.35);
  app.camera.lookAt(0, 1.05, -0.5);
  app.camera.updateMatrixWorld();

  const J = ['wrist',
    'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
    'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
    'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
    'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
    'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'];

  // local hand model: wrist at origin, fingers along −Z, palm normal −Y, thumb toward +X (right hand)
  function localJoints(side, pinch) {
    const s = side === 'right' ? 1 : -1;
    const pts = { wrist: [0, 0, 0] };
    const fingers = [
      ['index-finger', 0.022, [0.045, 0.028, 0.024, 0.022]],
      ['middle-finger', 0.004, [0.047, 0.032, 0.026, 0.024]],
      ['ring-finger', -0.014, [0.045, 0.029, 0.024, 0.022]],
      ['pinky-finger', -0.03, [0.041, 0.022, 0.018, 0.018]],
    ];
    for (const [name, x, lens] of fingers) {
      let p = [x * s, 0, -0.02];
      pts[`${name}-metacarpal`] = p;
      const names = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
      let curl = name === 'index-finger' && pinch ? 0.55 : 0.18;
      let dir = [0, 0, -1];
      names.forEach((n, i) => {
        const L = lens[i];
        p = [p[0] + dir[0] * L, p[1] + dir[1] * L, p[2] + dir[2] * L];
        pts[`${name}-${n}`] = p;
        const a = curl * (i + 1);
        dir = [0, -Math.sin(a), -Math.cos(a)];
      });
    }
    const thumb = pinch ? [[0.02, -0.01, -0.01], [0.035, -0.02, -0.035], [0.035, -0.035, -0.06], [0.03, -0.045, -0.075]]
      : [[0.02, -0.01, -0.01], [0.04, -0.015, -0.03], [0.055, -0.02, -0.05], [0.065, -0.022, -0.068]];
    ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'].forEach((n, i) => { pts[n] = [thumb[i][0] * s, thumb[i][1], thumb[i][2]]; });
    return pts;
  }

  function setHand(ix, side, wrist, quat, pinch) {
    ix.kind = 'hand'; ix.active = true; ix.handedness = side; ix.jointsValid = true;
    const pts = localJoints(side, pinch);
    J.forEach((name, j) => {
      const p = new V3(...pts[name]).applyQuaternion(quat).add(wrist);
      ix.joints[j].pos.copy(p);
      ix.joints[j].quat.copy(quat);
      ix.joints[j].radius = name.endsWith('tip') ? 0.007 : 0.009;
    });
    const thumb = ix.joints[4].pos, index = ix.joints[9].pos;
    ix.pinchStrength = 1 - Math.min(1, Math.max(0, (thumb.distanceTo(index) - 0.012) / 0.05));
    ix.pinch.set(pinch);
    ix.grabPos.addVectors(thumb, index).multiplyScalar(0.5);
    ix.grabQuat.copy(quat);
    ix.pokePos.copy(index);
    ix.hasPoke = true;
    ix.palmNormal.set(0, -1, 0).applyQuaternion(quat);
    ix.palmFacingHead = ix.palmNormal.dot(app.headPosition.clone().sub(wrist).normalize());
  }

  const head = app.camera.position.clone();
  app.headPosition.copy(head);
  // left hand with the palm turned toward the face, which shows the Menu button next to it
  const lw = new V3(-0.17, 1.13, -0.12);
  const toHead = head.clone().sub(lw).normalize();
  const lq = new Q().setFromUnitVectors(new V3(0, -1, 0), toHead);
  setHand(app.input.xr[0], 'left', lw, lq, false);
  // right hand pinching and pointing forward-left with its ray
  const rq = new Q().setFromEuler(new (app.camera.rotation.constructor)(-0.5, 0.35, 0));
  setHand(app.input.xr[1], 'right', new V3(0.14, 1.12, -0.2), rq, true);
  const r = app.input.xr[1];
  r.rayOrigin.copy(r.joints[0].pos).add(new V3(0, 0.02, -0.05));
  r.rayQuat.copy(rq);
  r.rayDir.set(0, 0, -1).applyQuaternion(rq);
  r.rayVisible = true;
  r.rayLength = 0.6;
  app.interaction.update = () => {};
  return 'faked';
})();

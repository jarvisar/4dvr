import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Environment } from './environment.js';
import { AudioEngine } from './audio.js';
import { InputSystem } from './input.js';
import { InteractionManager } from './interaction.js';
import { UISystem } from './ui.js';
import { HandMenu } from './menu.js';
import { Guide } from './guide.js';
import { HandVisuals } from './handVisuals.js';
import { QUALITY, initialQuality, saveQuality } from './quality.js';
import { pref } from './prefs.js';

const UP = new THREE.Vector3(0, 1, 0);
const SNAP_ANGLE = Math.PI / 6; // 30°
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class App {
  constructor(container, sceneList) {
    this.container = container;
    this.sceneList = sceneList;
    this.params = new URLSearchParams(location.search);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight); // pixel ratio, foveation and shadows are set in _applyQuality()
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.02, 200);
    this.camera.position.set(0, 1.55, 0.45);
    this.rig = new THREE.Group();
    this.rig.name = 'rig';
    this.rig.add(this.camera);
    this.scene.add(this.rig);
    this.raycaster = new THREE.Raycaster();
    this.headPosition = new THREE.Vector3(0, 1.6, 0);
    this.headQuaternion = new THREE.Quaternion();

    this.env = new Environment(this.scene);
    // ?quality=low|medium|high overrides the saved preset without replacing it
    const q = this.params.get('quality');
    this.quality = QUALITY[q] ? q : initialQuality();
    this._applyQuality();
    this.audio = new AudioEngine();
    this.input = new InputSystem(this); // registers pointer listeners before OrbitControls on purpose
    this.ui = new UISystem(this);
    this.interaction = new InteractionManager(this);
    this.hands = new HandVisuals(this);
    // Larger menus and cards, for anyone who finds the text small (an accessibility setting)
    this.largeUI = pref.get('largeui', false);
    this.menu = new HandMenu(this);
    this.guide = new Guide(this);
    this.desktopMenu = window.innerWidth >= 720; // phones start with the menu closed
    this.hudActive = false; // set by main.js once the start screen is dismissed
    // comfort options for scenes you move through (see setComfort)
    this.comfort = { vignette: pref.get('vignette', true), snapTurn: pref.get('snapturn', true) };
    this._motion = 0;      // meters of artificial movement this frame (addMotion)
    this._vignette = this._makeVignette();
    this._snapArmed = true;
    this.statsEnabled = this.params.has('stats');
    this.stats = { fps: 0, cpu: 0, calls: 0, tris: 0 };
    this._cpuAcc = 0;

    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.enableZoom = false;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: -1 };
    this.orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this._installPointerGate();

    this._fader = this._makeFader();
    this.fade = 0;
    this.fadeTarget = 0;
    this._pendingScene = null;

    this.scenes = new Map();
    this.activeScene = null;
    this.sceneKey = null;

    this._lastT = null;
    this.time = 0;
    this.frameCount = 0;
    this._fpsT = 0;
    this._fpsN = 0;
    this.fps = 0;

    window.addEventListener('resize', () => this._resize());
    window.addEventListener('keydown', (e) => this._key(e));
    renderer.domElement.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.activeScene?.onWheel?.(e.deltaY, e);
    }, { passive: false });

    renderer.xr.addEventListener('sessionstart', () => this._onSessionStart());
    renderer.xr.addEventListener('sessionend', () => this._onSessionEnd());
    renderer.setAnimationLoop((t, frame) => this._frame(t, frame));
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  // 'hands', 'controllers' or 'desktop', for picking which instructions to show
  get inputMode() {
    if (!this.presenting) return 'desktop';
    return this.input.xr.some((ix) => ix.kind === 'controller') ? 'controllers' : 'hands';
  }

  _installPointerGate() {
    // Decide at pointerdown whether the mouse hits UI or objects (interact) or
    // empty space (orbit the camera). Uses capture so it runs before
    // OrbitControls' own listener.
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.presenting) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const ix = this.input.mouse;
      ix.rayOrigin.copy(this.raycaster.ray.origin);
      ix.rayDir.copy(this.raycaster.ray.direction);
      let hit = !!this.ui.raycast(ix);
      if (!hit) {
        for (const it of this.activeScene?.interactables || []) {
          if (it.enabled !== false && it.rayDistance && it.rayDistance(ix.rayOrigin, ix.rayDir) < Infinity) { hit = true; break; }
        }
      }
      const secondary = e.button === 2 || e.shiftKey;
      this.pointerOnEmpty = !hit;
      this.orbit.enabled = !hit && !secondary && !this.activeScene?.noOrbit;
    }, { capture: true });
    window.addEventListener('pointerup', () => { this.orbit.enabled = !this.activeScene?.noOrbit; });
  }

  _makeFader() {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x05060c, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    m.renderOrder = 1000;
    m.visible = false;
    this.camera.add(m);
    return m;
  }

  // Comfort vignette. Darkens the edges of the view while a scene moves the
  // person artificially (stick or pinch-and-pull locomotion) to cut down on
  // motion sickness. Only the periphery is covered, so the center of the view
  // costs nothing extra.
  _makeVignette() {
    const open = 0.5; // radians around the view direction that are never covered
    const geo = new THREE.SphereGeometry(0.2, 40, 12, 0, Math.PI * 2, open, Math.PI - open).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uStrength;
        varying vec3 vDir;
        void main() {
          float a = acos(clamp(-normalize(vDir).z, -1.0, 1.0));
          float r0 = mix(1.25, 0.55, uStrength); // the clear area shrinks as the movement gets faster
          gl_FragColor = vec4(0.02, 0.02, 0.035, smoothstep(r0, r0 + 0.3, a));
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.BackSide,
    }));
    m.renderOrder = 999; // under the scene fade
    m.visible = false;
    m.level = 0;
    this.camera.add(m);
    return m;
  }

  // Scenes report artificial movement (meters this frame) for the comfort vignette
  addMotion(metres) {
    this._motion += metres;
  }

  _updateVignette(dt) {
    const v = this._vignette;
    const speed = this._motion / Math.max(dt, 1e-3);
    this._motion = 0;
    const target = this.presenting && this.comfort.vignette ? THREE.MathUtils.clamp((speed - 0.05) / 1.2, 0, 1) : 0;
    // closes quickly when movement starts, opens gently when it stops
    v.level += (target - v.level) * Math.min(1, dt * (target > v.level ? 10 : 3));
    v.visible = v.level > 0.01;
    v.material.uniforms.uStrength.value = v.level;
  }

  setComfort(key, on) {
    this.comfort[key] = on;
    pref.set(key.toLowerCase(), on);
  }

  get uiScale() { return this.largeUI ? 1.25 : 1; }

  setLargeUI(on) {
    this.largeUI = on;
    pref.set('largeui', on);
    if (this.menu.shown) this.menu.open(); // placed again at the new size
  }

  // Menu > Settings > Recenter. Puts the scene in front of the person again and
  // fits it to their height, for example after sitting down. Not in the scenes you move
  // through, which track the head from frame to frame.
  refit() {
    if (!this.presenting || this.activeScene?.locomotion) return;
    const moved = this.recenter();
    if (this.menu.shown) this.menu.panel.group.applyMatrix4(moved); // the menu stays where it was relative to the person
    this.activeScene?.onUserReady?.();
    this.audio.click();
  }

  // Right stick left/right turns in 30° steps in scenes you move through
  _updateSnapTurn() {
    if (!this.presenting || !this.activeScene?.locomotion || !this.comfort.snapTurn) return;
    for (const ix of this.input.xr) {
      if (ix.kind !== 'controller' || ix.handedness !== 'right') continue;
      const x = ix.stick.x;
      if (this._snapArmed && Math.abs(x) > 0.7) {
        this._turn(-Math.sign(x) * SNAP_ANGLE);
        this._snapArmed = false;
      } else if (Math.abs(x) < 0.3) this._snapArmed = true;
      ix.stick.x = 0; // the scene doesn't also strafe with it
    }
  }

  // Rotate around the vertical axis through the head
  _turn(angle) {
    _q.setFromAxisAngle(UP, angle);
    this.rig.position.sub(this.headPosition).applyQuaternion(_q).add(this.headPosition);
    this.rig.quaternion.premultiply(_q);
    this.rig.updateMatrixWorld(true);
    this.audio.click();
  }

  // Move the rig so the head is over the scene's origin, facing -z, which is
  // where every scene expects the person to start. Scenes are laid out in front
  // of that spot, so a new scene opens in front of the person wherever they've
  // walked or turned to. Returns the change as a world transform.
  recenter() {
    this.rig.updateMatrixWorld(true);
    const before = _m.copy(this.rig.matrixWorld).invert();
    // the head in the rig's own space
    const local = this.camera.position;
    _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const yaw = Math.atan2(-_v.x, -_v.z);
    this.rig.quaternion.setFromAxisAngle(UP, -yaw);
    this.rig.position.set(-local.x, 0, -local.z).applyQuaternion(this.rig.quaternion);
    this.rig.updateMatrixWorld(true);
    return before.premultiply(this.rig.matrixWorld);
  }

  _resize() {
    if (this.presenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _key(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    // Space and Enter on a focused button press the button, not also the scene
    if (e.target?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser shortcuts (Ctrl+R, Ctrl+1…) alone
    const idx = parseInt(e.key, 10);
    if (idx >= 1 && idx <= this.sceneList.length) { this.setScene(this.sceneList[idx - 1].key); return; }
    if (e.key === 'm' || e.key === 'M') { this.setDesktopMenu(!this.desktopMenu); return; }
    if (e.key === 'h' || e.key === 'H') { this.onDesktopHelp?.(); return; }
    this.activeScene?.onKey?.(e);
  }

  setDesktopMenu(on) {
    this.desktopMenu = on;
    this.onDesktopMenuChanged?.(on);
  }

  // Switch scenes with a short fade (instant on first load)
  setScene(key, instant = false) {
    if (key === this.sceneKey && this.activeScene) return;
    if (instant || !this.activeScene) {
      this._switchTo(key);
      return;
    }
    this._pendingScene = key;
    this.fadeTarget = 1;
  }

  _switchTo(key) {
    const def = this.sceneList.find((s) => s.key === key);
    if (!def) return;
    this.interaction.releaseAll();
    if (this.activeScene) this.activeScene.exit();
    // in VR, start the new scene from its usual spot, in front of the person
    const inVR = this.presenting && !this._sessionJustStarted;
    if (inVR) {
      const moved = this.recenter();
      this.menu.sceneChanged();
      if (this.menu.shown) this.menu.panel.group.applyMatrix4(moved); // an open menu stays where it was relative to the person
    }
    let scene = this.scenes.get(key);
    if (!scene) {
      scene = def.create(this);
      this.scenes.set(key, scene);
    }
    this.activeScene = scene;
    this.sceneKey = key;
    this.env.setMood(scene.mood);
    scene.enter();
    if (this._rates) this._setFrameRate(this._rates.length - 1); // happens during the fade
    if (inVR) {
      scene.onUserReady?.(); // fit to the person's height
      this._guidePending = true; // the scene's tips or tutorial, placed once the head pose is up to date
    }
    this.menu.rebuild();
    if (!this.presenting && scene.desktopView) {
      this.camera.position.copy(scene.desktopView.position);
      this.orbit.target.copy(scene.desktopView.target);
      this.orbit.update();
    }
    this.orbit.enabled = !scene.noOrbit;
    this.onSceneChanged?.(key);
  }

  _onSessionStart() {
    this.audio.unlock();
    this._initFrameRate();
    this.rig.position.set(0, 0, 0);
    this.rig.quaternion.identity();
    this.camera.position.set(0, 0, 0);
    this.orbit.enabled = false;
    this.interaction.releaseAll(); // the mouse's drag or hover
    // the desktop menu is fully opaque at the HUD position, so don't let it fade out from there
    this.menu.panel.opacity = 0;
    this.menu.panel.group.visible = false;
    this._sessionJustStarted = 2;
    this.activeScene?.onSessionStart?.();
    this.onSessionChange?.(true);
  }

  // Refresh rate: start at the highest rate the headset supports and drop a step
  // when the scene can't hold it. Switching scenes goes back to the highest rate,
  // since the new scene may be cheaper. ?hz sets a fixed rate instead.
  _initFrameRate() {
    this._rates = null;
    const session = this.renderer.xr.getSession();
    if (!session?.updateTargetFrameRate || !session.supportedFrameRates?.length) return;
    const rates = [...session.supportedFrameRates].sort((a, b) => a - b);
    const hz = parseFloat(this.params.get('hz'));
    if (hz) {
      if (rates.includes(hz)) session.updateTargetFrameRate(hz).catch(() => {});
      return;
    }
    this._rates = rates;
    this._setFrameRate(rates.length - 1);
  }

  _setFrameRate(i) {
    this._rateIndex = i;
    this._rateGrace = 3; // seconds to skip while the display switches and the scene warms up
    this._slowSeconds = 0;
    const session = this.renderer.xr.getSession();
    if (session.frameRate !== this._rates[i]) session.updateTargetFrameRate(this._rates[i]).catch(() => {});
  }

  // Runs once a second, after this.fps is updated
  _checkFrameRate() {
    if (!this._rates || !this.presenting) return;
    if (this._rateGrace > 0) { this._rateGrace--; return; }
    const target = this.renderer.xr.getSession().frameRate || this._rates[this._rateIndex];
    this._slowSeconds = this.fps < target * 0.9 ? this._slowSeconds + 1 : 0;
    if (this._slowSeconds >= 2 && this._rateIndex > 0) this._setFrameRate(this._rateIndex - 1);
  }

  _onSessionEnd() {
    // drop anything the hands or controllers were holding since they stop updating now
    this.interaction.releaseAll();
    this._rates = null;
    this.rig.position.set(0, 0, 0); // undo snap turns and recentering for the desktop camera
    this.rig.quaternion.identity();
    this._vignette.level = 0;
    this._vignette.visible = false;
    this._xrScaleUsed = null;
    this._applyQuality(); // three.js restored the pixel ratio from before the session
    this.orbit.enabled = true;
    this.guide.sessionEnded();
    this.menu.shown = false;
    this.menu.palm.shown = false;
    this._resize();
    if (this.activeScene?.desktopView) {
      this.camera.position.copy(this.activeScene.desktopView.position);
      this.orbit.target.copy(this.activeScene.desktopView.target);
    }
    this.camera.quaternion.identity();
    this.orbit.update();
    this.menu.rebuild(); // desktop and VR menus differ slightly (no pin button on desktop)
    this.activeScene?.onSessionEnd?.();
    this.onSessionChange?.(false);
  }

  async enterVR() {
    if (!navigator.xr) return;
    this.audio.unlock();
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    this._xrNative = window.XRWebGLLayer?.getNativeFramebufferScaleFactor?.(session) || 1;
    this._xrScaleUsed = this._xrScale();
    this.renderer.xr.setFramebufferScaleFactor(this._xrScaleUsed);
    await this.renderer.xr.setSession(session);
  }

  // The Quest Browser's default WebXR resolution is below the display's (1680×1760
  // per eye on the Quest 3 vs 2064×2208), so the preset's resolution is a fraction
  // of the native one. High renders at the display's resolution.
  // The native scale is clamped to 1 to 1.5 so a headset that doesn't report it, or
  // one with a very high resolution display, stays near its default. ?scale overrides it.
  _xrScale() {
    const forced = parseFloat(this.params.get('scale'));
    if (forced > 0.3 && forced <= 2) return forced;
    const native = Math.min(Math.max(this._xrNative, 1), 1.5);
    return Math.max(0.5, native * QUALITY[this.quality].resolution);
  }

  // Switch graphics preset (see quality.js) and save it for next time
  setQuality(key) {
    if (!QUALITY[key] || key === this.quality) return;
    this.quality = key;
    saveQuality(key);
    this._applyQuality();
  }

  _applyQuality() {
    const q = QUALITY[this.quality];
    // The XR framebuffer size is fixed for the session, so in VR only foveation and
    // shadows change now. The resolution changes the next time VR starts.
    if (!this.presenting) this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * q.resolution);
    this.renderer.xr.setFoveation(q.foveation);
    this.env.setShadows(q.shadows);
  }

  // True in VR when the chosen preset's resolution differs from the session's
  get qualityPending() {
    return this.presenting && !!this._xrScaleUsed && Math.abs(this._xrScale() - this._xrScaleUsed) > 0.001;
  }

  _frame(t, xrFrame) {
    const cpu0 = this.statsEnabled ? performance.now() : 0;
    const dt = this._lastT === null ? 1 / 72 : Math.min(0.05, Math.max(0, (t - this._lastT) / 1000));
    this._lastT = t;
    this.time += dt;
    this.frameCount++;

    if (this.presenting) {
      this.rig.updateMatrixWorld(true);
      this.renderer.xr.updateCamera(this.camera);
    } else {
      if (!this.activeScene?.noOrbit) this.orbit.update();
      this.camera.updateMatrixWorld();
    }
    this.camera.getWorldPosition(this.headPosition);
    this.camera.getWorldQuaternion(this.headQuaternion);

    if (this._sessionJustStarted && --this._sessionJustStarted === 0) {
      // head pose is valid now, so scenes can position themselves relative to the user
      this.activeScene?.onUserReady?.();
      this.menu.rebuild();
      this.guide.sessionStarted();
    }
    if (this._guidePending) {
      this._guidePending = false;
      this.guide.sceneEntered();
    }

    // scene fade
    this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * 10);
    if (this._pendingScene && this.fade > 0.97) {
      this._switchTo(this._pendingScene);
      this._pendingScene = null;
      this.fadeTarget = 0;
    }
    this._fader.visible = this.fade > 0.01;
    this._fader.material.opacity = Math.min(1, this.fade * 1.05);

    this.input.update(dt, this.time);
    this._updateSnapTurn();
    this.interaction.update(dt);
    this.activeScene?.update(dt, this.time);
    this.menu.update(dt);
    this.guide.update(dt);
    this.ui.update(this.time);
    this.hands.update();
    this._updateVignette(dt);
    this.audio.updateListener(this.camera);

    this.renderer.render(this.scene, this.camera);

    this._fpsT += dt; this._fpsN++;
    if (this.statsEnabled) this._cpuAcc += performance.now() - cpu0;
    if (this._fpsT > 1) {
      this.fps = this._fpsN / this._fpsT;
      this._checkFrameRate();
      if (this.statsEnabled) {
        const info = this.renderer.info.render;
        const eye = this.presenting ? this.renderer.xr.getCamera().cameras[0]?.viewport : null;
        const hz = this.presenting ? this.renderer.xr.getSession()?.frameRate : null;
        Object.assign(this.stats, { fps: this.fps, hz, cpu: this._cpuAcc / this._fpsN, calls: info.calls, tris: info.triangles, eye: eye ? `${eye.z}×${eye.w}` : '', msaa: this._msaaPath() });
        this.onStats?.(this.stats);
      }
      this._fpsT = 0; this._fpsN = 0; this._cpuAcc = 0;
    }
  }

  // How the XR framebuffer's 4x MSAA gets resolved, shown in ?stats. On the
  // Quest's tiled GPU a resolve in tile memory is almost free. When the
  // compositor uses the depth buffer, three.js renders to separate multisampled
  // buffers and resolves them with a full-screen blit every frame, which isn't.
  _msaaPath() {
    const rt = this.presenting ? this.renderer.getRenderTarget() : null;
    if (!rt?.isXRRenderTarget || !rt.samples) return '';
    const inTile = this.renderer.extensions.has('WEBGL_multisampled_render_to_texture') && rt.resolveDepthBuffer === false;
    return inTile ? 'MSAA in tile' : 'MSAA blit';
  }

  get statsText() {
    const s = this.stats;
    return `${s.fps.toFixed(0)}${s.hz ? `/${s.hz}` : ''} fps · ${s.cpu.toFixed(1)} ms cpu · ${s.calls} draws · ${(s.tris / 1000).toFixed(0)}k tris${s.eye ? ` · ${s.eye} per eye` : ''}${s.msaa ? ` · ${s.msaa}` : ''}`;
  }
}

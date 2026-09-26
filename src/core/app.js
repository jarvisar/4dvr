import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Environment } from './environment.js';
import { AudioEngine } from './audio.js';
import { InputSystem } from './input.js';
import { InteractionManager } from './interaction.js';
import { UISystem } from './ui.js';
import { HandMenu, WelcomePanel } from './menu.js';
import { HandVisuals } from './handVisuals.js';

export class App {
  constructor(container, sceneList) {
    this.container = container;
    this.sceneList = sceneList;
    this.params = new URLSearchParams(location.search);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    const fbScale = parseFloat(this.params.get('scale'));
    if (fbScale > 0.3 && fbScale <= 1.5) renderer.xr.setFramebufferScaleFactor(fbScale);
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
    this.audio = new AudioEngine();
    this.input = new InputSystem(this); // registers pointer listeners before OrbitControls on purpose
    this.ui = new UISystem(this);
    this.interaction = new InteractionManager(this);
    this.hands = new HandVisuals(this);
    this.menu = new HandMenu(this);
    this.welcome = new WelcomePanel(this);
    this.desktopMenu = true;

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

  _installPointerGate() {
    // Decide at pointerdown whether the mouse hits UI/objects (→ interact) or
    // empty space (→ orbit the camera). Registered before OrbitControls'
    // own listener via capture, so it runs first.
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

  _resize() {
    if (this.presenting) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _key(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const idx = parseInt(e.key, 10);
    if (idx >= 1 && idx <= this.sceneList.length) { this.setScene(this.sceneList[idx - 1].key); return; }
    if (e.key === 'm' || e.key === 'M') { this.desktopMenu = !this.desktopMenu; return; }
    this.activeScene?.onKey?.(e);
  }

  /** Switch scenes with a short fade (instant on first load). */
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
    let scene = this.scenes.get(key);
    if (!scene) {
      scene = def.create(this);
      this.scenes.set(key, scene);
    }
    this.activeScene = scene;
    this.sceneKey = key;
    this.env.setMood(scene.mood);
    scene.enter();
    if (this.presenting && !this._sessionJustStarted) scene.onUserReady?.(); // fit to the person's height
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
    this.renderer.xr.setFoveation(1);
    const hz = parseFloat(this.params.get('hz'));
    const session = this.renderer.xr.getSession();
    if (hz && session?.updateTargetFrameRate && session.supportedFrameRates?.includes(hz)) {
      session.updateTargetFrameRate(hz).catch(() => {});
    }
    this.rig.position.set(0, 0, 0);
    this.rig.quaternion.identity();
    this.camera.position.set(0, 0, 0);
    this.orbit.enabled = false;
    this._sessionJustStarted = 2;
    this.activeScene?.onSessionStart?.();
    this.onSessionChange?.(true);
  }

  _onSessionEnd() {
    this.orbit.enabled = true;
    this.welcome.hide();
    this.menu.pinned = false;
    this.menu.shown = false;
    this._resize();
    if (this.activeScene?.desktopView) {
      this.camera.position.copy(this.activeScene.desktopView.position);
      this.orbit.target.copy(this.activeScene.desktopView.target);
    }
    this.camera.quaternion.identity();
    this.orbit.update();
    this.activeScene?.onSessionEnd?.();
    this.onSessionChange?.(false);
  }

  async enterVR() {
    if (!navigator.xr) return;
    this.audio.unlock();
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });
    await this.renderer.xr.setSession(session);
  }

  _frame(t, xrFrame) {
    const dt = this._lastT === null ? 1 / 72 : Math.min(0.05, Math.max(0, (t - this._lastT) / 1000));
    this._lastT = t;
    this.time += dt;
    this.frameCount++;
    this._fpsT += dt; this._fpsN++;
    if (this._fpsT > 1) { this.fps = this._fpsN / this._fpsT; this._fpsT = 0; this._fpsN = 0; }

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
      this.welcome.show();
      this.menu.rebuild();
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
    this.interaction.update(dt);
    this.activeScene?.update(dt, this.time);
    this.menu.update(dt);
    this.ui.update(this.time);
    this.hands.update();
    this.audio.updateListener(this.camera);

    this.renderer.render(this.scene, this.camera);
  }
}

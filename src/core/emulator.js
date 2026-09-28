// Optional WebXR emulation with IWER (https://github.com/meta-quest/immersive-web-emulation-runtime).
// Only loaded with `?iwer`. It lets a desktop browser run the real VR code path
// with an emulated Quest 3 (controllers or tracked hands), driven from the IWER
// DevUI overlay. `?iwer=headless` skips the DevUI (used by the tests).

export async function installEmulator(mode) {
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3, { stereoEnabled: false });
  device.installRuntime({ forceInstall: true });
  if (mode !== 'headless') {
    const { DevUI } = await import('@iwer/devui');
    device.installDevUI(DevUI);
  }
  window.__xrDevice = device; // for tools/ci-smoke.mjs and the console
  return device;
}

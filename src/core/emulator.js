// Optional WebXR emulation with IWER (https://github.com/meta-quest/immersive-web-emulation-runtime).
// Loaded only with `?iwer`, so a desktop browser can run the real VR code
// path: an emulated Quest 3 with controllers or tracked hands, driven from the
// IWER DevUI overlay. `?iwer=headless` skips the DevUI (used by the tests).

export async function installEmulator(mode) {
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3, { stereoEnabled: false });
  device.installRuntime({ forceInstall: true });
  if (mode !== 'headless') {
    const { DevUI } = await import('@iwer/devui');
    device.installDevUI(DevUI);
  }
  window.__xrDevice = device; // for tools/vr-test.js and the console
  return device;
}

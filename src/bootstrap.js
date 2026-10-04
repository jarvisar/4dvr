// Keep the start screen usable when graphics or an app module fails to load.
import('./main.js').catch((error) => {
  console.error('Could not start the app', error);
  window.__app?.renderer.setAnimationLoop(null);
  document.getElementById('xr-note').textContent = `Could not start the 3D view: ${error.message}. Check your connection and try an up-to-date browser with graphics acceleration enabled, then reload.`;
  document.getElementById('xr-status').className = 'status off';
  for (const button of document.querySelectorAll('#actions button, #scene-index button')) button.disabled = true;
  const retry = document.createElement('button');
  retry.id = 'retry-start';
  retry.className = 'btn primary';
  retry.textContent = 'Reload';
  retry.onclick = () => location.reload();
  document.getElementById('actions').appendChild(retry);
});

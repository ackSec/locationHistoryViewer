/* Bootstrap: map init + file ingestion + UI wiring. */

(() => {
  let map = null;
  let data = null;
  let controller = null;

  const state = {
    currentTime: 0,
    playing: false,
    speedSec: 2592000, // 1 month of simulated time per real second
  };

  // ===== Map =====
  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [0, 20],
      zoom: 1.4,
      pitch: 0,
      bearing: 0,
      antialias: true,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('load', () => {
      LHRender.addLayers(map);
    });
  }

  // ===== File ingestion =====
  async function ingest(fileList) {
    const status = document.getElementById('load-status');
    status.textContent = 'Reading files…';
    try {
      const files = await LHParser.readFileList(fileList, (msg) => { status.textContent = msg; });
      if (!files.length) { status.textContent = 'No JSON found. Include Records.json, location-history.json, or a Semantic Location History folder.'; return; }
      status.textContent = `Parsing ${files.length} file(s)…`;
      await new Promise(r => setTimeout(r, 30)); // let UI paint
      const parsed = LHParser.parseAll(files);
      if (!parsed.visits.length && !parsed.segments.length && !parsed.rawPoints.length) {
        status.textContent = 'No location data found in these files.'; return;
      }
      status.textContent = 'Deriving timeline…';
      await new Promise(r => setTimeout(r, 10));
      data = LHDerive.derive(parsed);
      status.textContent = `Loaded ${parsed.visits.length} visits · ${parsed.segments.length} trips · ${parsed.formatsFound.join(', ')}`;
      await onDataLoaded();
    } catch (err) {
      console.error(err);
      status.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
    }
  }

  async function onDataLoaded() {
    // wait for style + layers to exist (poll; handles both pre-load and post-load cases)
    await new Promise(resolve => {
      const check = () => {
        if (map.isStyleLoaded() && map.getSource('trail')) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
    LHRender.loadData(map, data);

    // Fit map to data bounds, then hide drop zone and show UI
    const bounds = computeBounds(data);
    if (bounds) map.fitBounds(bounds, { padding: 60, duration: 0 });

    state.currentTime = data.t0;
    controller = LHAnimate.createController(map, data, state);
    controller.render();

    setTimeout(() => {
      document.getElementById('drop').classList.remove('show');
      document.getElementById('hud').classList.remove('hidden');
      document.getElementById('year-watermark').classList.remove('hidden');
      document.getElementById('legend').classList.remove('hidden');
      document.getElementById('controls').classList.remove('hidden');
      setTimeout(() => controller.play(), 600);
    }, 400);
  }

  function computeBounds(d) {
    let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90, any = false;
    const push = (lat, lng) => {
      if (!isFinite(lat) || !isFinite(lng)) return;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      any = true;
    };
    for (const v of d.visits) push(v.lat, v.lng);
    for (const s of d.segments) { push(s.startLat, s.startLng); push(s.endLat, s.endLng); }
    if (!any) return null;
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  // ===== UI wiring =====
  function wireDropZone() {
    const drop = document.getElementById('drop');
    const input = document.getElementById('file-input');
    input.addEventListener('change', (e) => {
      if (e.target.files.length) ingest(e.target.files);
    });
    ['dragenter', 'dragover'].forEach(evt => {
      drop.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(evt => {
      drop.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover'); });
    });
    drop.addEventListener('drop', (e) => {
      if (e.dataTransfer && e.dataTransfer.files.length) ingest(e.dataTransfer.files);
    });
    // full-window drop also works
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!data && e.dataTransfer && e.dataTransfer.files.length) ingest(e.dataTransfer.files);
    });
  }

  function wireControls() {
    const btnPlay = document.getElementById('btn-play');
    const btnRestart = document.getElementById('btn-restart');
    const speed = document.getElementById('speed');
    const scrub = document.getElementById('scrub');

    btnPlay.addEventListener('click', () => {
      if (!controller) return;
      if (state.playing) controller.pause(); else controller.play();
    });
    btnRestart.addEventListener('click', () => {
      if (!controller) return;
      controller.restart();
    });
    speed.addEventListener('change', () => {
      state.speedSec = parseFloat(speed.value);
    });
    scrub.addEventListener('input', () => {
      if (!controller || !data) return;
      scrub.dataset.dragging = '1';
      const f = parseFloat(scrub.value) / 1000;
      controller.seek(data.t0 + f * (data.t1 - data.t0));
    });
    scrub.addEventListener('change', () => {
      scrub.dataset.dragging = '0';
    });

    // keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (!controller) return;
      if (e.key === ' ') { e.preventDefault(); if (state.playing) controller.pause(); else controller.play(); }
      else if (e.key === 'ArrowLeft') { controller.seek(state.currentTime - state.speedSec * 1000 * 3); }
      else if (e.key === 'ArrowRight') { controller.seek(state.currentTime + state.speedSec * 1000 * 3); }
      else if (e.key === 'r' || e.key === 'R') { controller.restart(); }
    });
  }

  // ===== Init =====
  function boot() {
    initMap();
    wireDropZone();
    wireControls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

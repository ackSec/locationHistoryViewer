/* Bootstrap: map init + file ingestion + UI wiring. */

(() => {
  let map = null;
  let data = null;
  let controller = null;

  const state = {
    currentTime: 0,
    playing: false,
    speedSec: 604800, // 1 week of simulated time per real second (gentle default)
  };

  // ===== On-page debug panel =====
  // Exposed globally so error boundaries in animate.js / render.js can log into it.
  const Debug = {
    lines: [],
    errCount: 0,
    errCounts: {},
    fixed: '', // pinned top section (parse/derive summary)
    tele: '',  // pinned bottom section (live telemetry)
    renderFrames: 0,
    lastFpsT: 0,
    fps: 0,
    lastInfoLine: '',
    set(html) { this.fixed = html; this._render(); },
    append(html) {
      // Dedupe consecutive identical lines
      if (html === this.lastInfoLine) return;
      this.lastInfoLine = html;
      this.lines.push(html);
      if (this.lines.length > 12) this.lines.shift();
      this._render();
    },
    tickRenderFrame() {
      // Called from the real render loop only — NOT the 250 ms heartbeat.
      this.renderFrames++;
    },
    error(where, err) {
      this.errCount++;
      this.errCounts[where] = (this.errCounts[where] || 0) + 1;
      // only append the first 3 occurrences of each step to avoid spam
      if (this.errCounts[where] <= 3) {
        const msg = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : String(err);
        this.append(`<span class="err">[ERR ${this.errCount}] ${escapeHtml(where)}#${this.errCounts[where]}:</span>\n${escapeHtml(msg)}`);
      }
      this._render();
    },
    info(line) { this.append(`<span class="k">${escapeHtml(line)}</span>`); },
    setTelemetry(state, data) {
      const now = performance.now();
      if (now - this.lastFpsT > 500) {
        this.fps = Math.round(this.renderFrames * 1000 / (now - this.lastFpsT));
        this.renderFrames = 0;
        this.lastFpsT = now;
      }
      const pct = data && data.t1 > data.t0
        ? (((state.currentTime - data.t0) / (data.t1 - data.t0)) * 100).toFixed(1)
        : '0';
      const errSummary = Object.keys(this.errCounts).length
        ? ' · err: ' + Object.entries(this.errCounts).map(([k, v]) => `${k}×${v}`).join(' ')
        : '';
      this.tele =
        `<span class="k">--- LIVE ---</span>\n` +
        `<span class="k">time:</span> <span class="v">${new Date(state.currentTime).toISOString().slice(0, 19)}Z</span> <span class="k">(${pct}%)</span>\n` +
        `<span class="k">playing:</span> <span class="v">${state.playing}</span>  <span class="k">fps:</span> <span class="v">${this.fps}</span>${errSummary}`;
      this._render();
    },
    _render() {
      const el = document.getElementById('debug-body');
      if (!el) return;
      el.innerHTML = [this.fixed, ...this.lines, this.tele].filter(Boolean).join('\n');
    },
  };
  window.__Debug = Debug;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function wireDebugToggle() {
    const btn = document.getElementById('debug-toggle');
    const panel = document.getElementById('debug');
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      btn.textContent = panel.classList.contains('collapsed') ? 'show' : 'hide';
    });
  }

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
      if (!files.length) { status.textContent = 'No JSON found. Include Records.json, location-history.json, a Semantic Location History folder, or a consolidated-location-history.json.'; return; }
      const totalBytes = files.reduce((s, f) => s + f.text.length, 0);
      const mb = (totalBytes / 1048576).toFixed(0);
      status.textContent = `Parsing ${mb} MB of JSON… (can take 10–20s on large files)`;
      await new Promise(r => setTimeout(r, 30)); // let UI paint
      const parsed = LHParser.parseAll(files);

      // Surface what we parsed both to the on-page panel and console
      const parseSummary = [
        `<span class="k">formats:</span> <span class="v">${parsed.formatsFound.join(', ') || 'none'}</span>`,
        `<span class="k">raw pings:</span> <span class="v">${parsed.rawPoints.length.toLocaleString()}</span>`,
        `<span class="k">visits:</span> <span class="v">${parsed.visits.length.toLocaleString()}</span>`,
        `<span class="k">segments:</span> <span class="v">${parsed.segments.length.toLocaleString()}</span>`,
      ];
      if (parsed.perFileCounts && parsed.perFileCounts.length) {
        for (const f of parsed.perFileCounts) {
          parseSummary.push(`  <span class="k">${escapeHtml(f.name)}</span>: fmt=${f.format} legacy=${f.legacyRecordsLen} timeline=${f.timelineLen} +raw=${f.rawAdded} +visits=${f.visitsAdded} +segs=${f.segmentsAdded}`);
        }
      }
      if (parsed.parseErrors && parsed.parseErrors.length) {
        for (const e of parsed.parseErrors) {
          parseSummary.push(`<span class="err">parse error in ${escapeHtml(e.name)} (${(e.bytes / 1048576).toFixed(0)} MB): ${escapeHtml(e.error)}</span>`);
        }
      }
      Debug.set(parseSummary.join('\n'));
      console.log('[LH] parse result:', parsed);

      if (parsed.parseErrors && parsed.parseErrors.length) {
        const e = parsed.parseErrors[0];
        status.textContent = `Parse failed for ${e.name} (${(e.bytes / 1048576).toFixed(0)} MB): ${e.error}`;
        return;
      }
      if (!parsed.visits.length && !parsed.segments.length && !parsed.rawPoints.length) {
        status.textContent = 'No location data found in these files.'; return;
      }
      status.textContent = `Read ${parsed.rawPoints.length.toLocaleString()} raw pings · ${parsed.visits.length.toLocaleString()} visits · ${parsed.segments.length.toLocaleString()} trips. Building timeline…`;
      await new Promise(r => setTimeout(r, 10));
      data = LHDerive.derive(parsed);

      const deriveSummary = [
        '',
        `<span class="ok">DERIVED</span>`,
        `<span class="k">t0:</span> <span class="v">${new Date(data.t0).toISOString()}</span>`,
        `<span class="k">t1:</span> <span class="v">${new Date(data.t1).toISOString()}</span>`,
        `<span class="k">span:</span> <span class="v">${((data.t1 - data.t0) / (365.25 * 86400000)).toFixed(2)} years</span>`,
        `<span class="k">segments (incl synth):</span> <span class="v">${data.segments.length.toLocaleString()}</span>`,
        `<span class="k">data ranges:</span> <span class="v">${data.dataRanges.length}</span>`,
      ];
      for (const r of data.dataRanges) {
        const yr = ((r.t1 - r.t0) / (365.25 * 86400000)).toFixed(2);
        deriveSummary.push(`  ${new Date(r.t0).toISOString().slice(0,10)} → ${new Date(r.t1).toISOString().slice(0,10)} <span class="k">(${yr}y)</span>`);
      }
      Debug.append(deriveSummary.join('\n'));
      console.log('[LH] derive result:', data);
      window.__LH = { parsed, data };
      const span = fmtRange(data.t0, data.t1);
      const gaps = (data.dataRanges && data.dataRanges.length > 1) ? ` · ${data.dataRanges.length} data eras` : '';
      status.textContent = `Loaded ${span} · ${data.segments.length.toLocaleString()} trips${gaps} · ${parsed.formatsFound.join(', ')}`;
      await onDataLoaded();
    } catch (err) {
      console.error(err);
      status.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
    }
  }

  function fmtRange(t0, t1) {
    const a = new Date(t0).getUTCFullYear();
    const b = new Date(t1).getUTCFullYear();
    return a === b ? String(a) : `${a}–${b}`;
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
    if (bounds) map.fitBounds(bounds, { padding: 80, duration: 0, pitch: 0, bearing: 0 });

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

  function fitWorld() {
    if (!data) return;
    const bounds = computeBounds(data);
    if (bounds) map.fitBounds(bounds, { padding: 80, duration: 600, pitch: 0, bearing: 0 });
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
    const camMode = document.getElementById('cam-mode');

    camMode.addEventListener('change', () => {
      // Reset any in-flight follow-mode easing state, and re-fit bounds when
      // the user asks for world view.
      if (camMode.value === 'world') fitWorld();
    });

    btnPlay.addEventListener('click', () => {
      if (!controller) return;
      if (state.playing) { Debug.info('pause clicked'); controller.pause(); }
      else { Debug.info('play clicked'); controller.play(); }
    });
    btnRestart.addEventListener('click', () => {
      if (!controller) return;
      Debug.info('restart clicked');
      controller.restart();
    });
    speed.addEventListener('change', () => {
      state.speedSec = parseFloat(speed.value);
    });
    scrub.addEventListener('input', () => {
      if (!controller || !data) return;
      const f = parseFloat(scrub.value) / 1000;
      controller.seek(data.t0 + f * (data.t1 - data.t0));
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
    wireDebugToggle();
    // Independent telemetry heartbeat so the LIVE line stays current even when
    // playback is paused or at end-of-timeline (the render loop stops firing
    // in those cases, which used to make the panel go stale).
    setInterval(() => {
      if (data) Debug.setTelemetry(state, data);
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

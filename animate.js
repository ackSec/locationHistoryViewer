/* Animation loop, camera, HUD, banners. */

const LHAnimate = (() => {

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const BANNER_MS = 2500;
  const EVENT_WINDOW_MS = 1000 * 60 * 60 * 24 * 7; // 1 week — don't miss a banner if we jump over it

  function fmtDate(ms) {
    const d = new Date(ms);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }

  function fmtKm(km) {
    if (km >= 10000) return (km / 1000).toFixed(1) + 'k';
    if (km >= 1000) return km.toFixed(0);
    return km.toFixed(1);
  }

  // ===== Find active timeline entry for a given time =====
  function activeAt(timeline, t) {
    if (!timeline.length) return -1;
    // binary search for the last entry with t0 <= t
    let lo = 0, hi = timeline.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (timeline[mid].t0 <= t) lo = mid; else hi = mid - 1;
    }
    return timeline[lo].t0 <= t ? lo : -1;
  }

  // ===== Camera controller =====
  //
  // Design: center-follow on every frame (instant jumpTo — no animation jitter).
  // Zoom + pitch only change when the activity context changes AND at least
  // CAM_MIN_INTERVAL of real wall-clock time has passed since the last transition.
  const CAM_MIN_INTERVAL_MS = 1200;

  function cameraTargetFor(activeEntry, data) {
    // Default: slight overview, flat
    let zoom = 9, pitch = 0, key = 'idle';
    if (!activeEntry) return { zoom, pitch, key };
    if (activeEntry.kind === 'segment') {
      const s = data.segments[activeEntry.i];
      if (s.isFlight) {
        const km = LHDerive.haversineKm(
          { lat: s.startLat, lng: s.startLng },
          { lat: s.endLat,   lng: s.endLng }
        );
        zoom = km > 5000 ? 2.4 : km > 2000 ? 3.2 : km > 800 ? 4.0 : 4.8;
        pitch = 0;
        key = 'flight';
      } else if (s.type === 'WALKING' || s.type === 'RUNNING' || s.type === 'CYCLING') {
        zoom = 12; pitch = 20; key = 'local';
      } else if (s.type === 'DRIVING' || s.type === 'BUS' || s.type === 'MOTORCYCLING') {
        zoom = 9.5; pitch = 15; key = 'road';
      } else {
        zoom = 10; pitch = 10; key = 'other';
      }
    } else if (activeEntry.kind === 'visit') {
      zoom = 11; pitch = 15; key = 'visit';
    }
    return { zoom, pitch, key };
  }

  function updateCamera(map, pos, activeEntry, data, mode, state) {
    // World mode: the camera is set once to the data extent and never moves
    // afterwards. No thrashing, no re-projection churn.
    if (mode === 'world' || mode === 'free' || !pos) return;

    // Follow mode: smooth center tracking + category-gated zoom/pitch changes.
    const target = cameraTargetFor(activeEntry, data);
    const now = performance.now();

    if (!state._camEasing) {
      map.jumpTo({ center: [pos.lng, pos.lat] });
    }

    if (target.key !== state._lastCamKey && (now - (state._lastCamEase || 0)) > CAM_MIN_INTERVAL_MS) {
      state._camEasing = true;
      map.easeTo({
        center: [pos.lng, pos.lat],
        zoom: target.zoom,
        pitch: target.pitch,
        duration: 900,
        essential: true,
      });
      state._lastCamKey = target.key;
      state._lastCamEase = now;
      setTimeout(() => { state._camEasing = false; }, 950);
    }
  }

  // ===== Banner =====
  let bannerTimer = null;
  function showBanner(text, sub) {
    const el = document.getElementById('banner');
    if (!el) return;
    el.innerHTML = `<span>${escapeHtml(text)}</span>` + (sub ? `<span class="small">${escapeHtml(sub)}</span>` : '');
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), BANNER_MS);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ===== HUD =====
  function updateHUD(data, currentTime, activeEntry) {
    const d = new Date(currentTime);
    document.getElementById('hud-year').textContent = d.getUTCFullYear();
    document.getElementById('hud-date').textContent = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    const year = d.getUTCFullYear();
    document.getElementById('year-watermark').textContent = String(year);

    const placeEl = document.getElementById('hud-place');
    let label = null;
    if (activeEntry && activeEntry.kind === 'visit') {
      const v = data.visits[activeEntry.i];
      const dur = v.t1 - v.t0;
      if (dur > 1000 * 60 * 15) {
        if (v.name) label = v.name;
        else if (v.semanticType && v.semanticType !== 'Unknown') label = v.semanticType;
        else label = `Stop · ${fmtDuration(dur)}`;
      }
    } else if (activeEntry && activeEntry.kind === 'segment') {
      const s = data.segments[activeEntry.i];
      const km = LHDerive.segmentKm(s);
      if (s.type && s.type !== 'UNKNOWN') {
        label = `${titleCase(s.type)} · ${km.toFixed(1)} km`;
      } else if (km > 0.5) {
        label = `${km.toFixed(1)} km`;
      }
    }
    if (label) {
      placeEl.textContent = label;
      placeEl.classList.add('show');
    } else {
      placeEl.classList.remove('show');
    }

    const stats = LHDerive.statsAt(data.cumulative, currentTime);
    document.getElementById('stat-km').textContent = fmtKm(stats.km);
    document.getElementById('stat-places').textContent = stats.places;
    document.getElementById('stat-countries').textContent = stats.countries;
    document.getElementById('stat-flights').textContent = stats.flights;
  }

  function titleCase(s) {
    return String(s).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  function fmtDuration(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ===== Event firing (banners) =====
  // We fire any event whose timestamp crosses from "not yet fired" to "<= currentTime".
  // Jumping forward (scrub) can skip many events — we fire only the most recent important one.
  function fireEvents(data, prevTime, currentTime, state) {
    if (currentTime <= prevTime) return; // no forward motion
    let latest = null;
    for (const ev of data.events) {
      if (ev.t > prevTime && ev.t <= currentTime) {
        latest = ev; // pick the last one in the window
      }
      if (ev.t > currentTime) break;
    }
    if (!latest) return;
    if (latest.type === 'year') {
      showBanner(latest.text, 'New year');
    } else if (latest.type === 'country-new') {
      showBanner(latest.text, latest.sub || 'New country');
    } else if (latest.type === 'country-change') {
      showBanner(latest.text, latest.sub || 'Arrived');
    } else if (latest.type === 'home-base') {
      showBanner(latest.text, 'Home base');
    }
  }

  // ===== Animation loop =====

  function createController(map, data, state) {
    let raf = 0;
    let lastTs = 0;

    function tick(ts) {
      if (!state.playing) return;
      try {
        if (!lastTs) lastTs = ts;
        const dtMs = ts - lastTs;
        lastTs = ts;
        const prevTime = state.currentTime;
        // speedSec = real-world seconds covered per 1s of wall clock
        state.currentTime = Math.min(data.t1, state.currentTime + state.speedSec * 1000 * (dtMs / 1000));
        // Auto-skip long empty gaps: if currentTime is past the end of a data range and before
        // the start of the next, jump to the next range's start.
        if (data.dataRanges && data.dataRanges.length > 1) {
          for (let i = 0; i < data.dataRanges.length - 1; i++) {
            const here = data.dataRanges[i], next = data.dataRanges[i + 1];
            if (state.currentTime > here.t1 && state.currentTime < next.t0) {
              const years = ((next.t0 - here.t1) / (365.25 * 86400000)).toFixed(1);
              state.currentTime = next.t0;
              showBanner(fmtDate(next.t0), `Skipped ${years}-year gap`);
              if (window.__Debug) window.__Debug.info(`auto-skip: ${new Date(here.t1).toISOString().slice(0,10)} → ${new Date(next.t0).toISOString().slice(0,10)} (${years}y)`);
              break;
            }
          }
        }
        render(prevTime);
        if (state.currentTime >= data.t1) {
          state.playing = false;
          document.getElementById('btn-play').textContent = '▶';
          document.getElementById('btn-play').classList.remove('playing');
          if (window.__Debug) window.__Debug.info(`playback ended at ${new Date(state.currentTime).toISOString().slice(0,19)}Z`);
          return;
        }
      } catch (err) {
        console.error('[LH] tick threw — continuing loop:', err);
        if (window.__Debug) window.__Debug.error('tick', err);
      }
      raf = requestAnimationFrame(tick);
    }

    function render(prevTime) {
      const D = window.__Debug;
      let activeEntry = null, pos = null;

      try { LHRender.updateFrame(map, state.currentTime); }
      catch (e) { if (D) D.error('updateFrame', e); }

      try {
        const idx = activeAt(data.timeline, state.currentTime);
        if (idx >= 0) {
          const e = data.timeline[idx];
          if (e && e.t1 >= state.currentTime) {
            activeEntry = e;
            if (e.kind === 'visit') {
              const v = data.visits[e.i];
              pos = { lat: v.lat, lng: v.lng };
            } else {
              pos = LHDerive.positionAt(data.segments[e.i], state.currentTime);
            }
          } else if (e) {
            if (e.kind === 'visit') {
              const v = data.visits[e.i];
              pos = { lat: v.lat, lng: v.lng };
            } else {
              const s = data.segments[e.i];
              pos = { lat: s.endLat, lng: s.endLng };
            }
          }
        }
      } catch (e) { if (D) D.error('activeEntry/pos', e); }

      try { LHRender.setPlayhead(map, pos); }
      catch (e) { if (D) D.error('setPlayhead', e); }

      try { updateHUD(data, state.currentTime, activeEntry); }
      catch (e) { if (D) D.error('updateHUD', e); }

      try {
        const camEl = document.getElementById('cam-mode');
        const cam = camEl ? camEl.value : 'world';
        updateCamera(map, pos, activeEntry, data, cam, state);
      } catch (e) { if (D) D.error('updateCamera', e); }

      try { fireEvents(data, prevTime, state.currentTime, state); }
      catch (e) { if (D) D.error('fireEvents', e); }

      try {
        syncScrubber(data, state);
        const tr = document.getElementById('time-read');
        if (tr) tr.textContent = fmtDate(state.currentTime);
      } catch (e) { if (D) D.error('scrubber', e); }

      if (D && D.tickRenderFrame) D.tickRenderFrame();
    }

    function play() {
      if (state.playing) return;
      if (state.currentTime >= data.t1) state.currentTime = data.t0;
      state.playing = true;
      lastTs = 0;
      document.getElementById('btn-play').textContent = '❚❚';
      document.getElementById('btn-play').classList.add('playing');
      raf = requestAnimationFrame(tick);
    }
    function pause() {
      state.playing = false;
      cancelAnimationFrame(raf);
      document.getElementById('btn-play').textContent = '▶';
      document.getElementById('btn-play').classList.remove('playing');
    }
    function seek(t) {
      const prev = state.currentTime;
      state.currentTime = Math.max(data.t0, Math.min(data.t1, t));
      render(prev);
    }
    function restart() {
      seek(data.t0);
    }

    return { play, pause, seek, restart, render: () => render(state.currentTime) };
  }

  function syncScrubber(data, state) {
    const scrub = document.getElementById('scrub');
    if (!scrub) return;
    // Always sync — skipping during drag caused the scrubber to decouple from
    // the clock whenever a mouseup/change event failed to fire.
    const f = (state.currentTime - data.t0) / Math.max(1, data.t1 - data.t0);
    scrub.value = Math.round(Math.max(0, Math.min(1, f)) * 1000);
  }

  return { createController, showBanner, fmtDate, activeAt };
})();

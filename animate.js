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
  function updateCamera(map, pos, activeEntry, data, mode) {
    if (mode === 'free' || !pos) return;
    if (mode === 'overview') return; // user set bounds manually

    // Target zoom depends on the kind of entry:
    //  - visit:    close (14)
    //  - activity: varies by distance covered
    //  - flight:   wide (3-5)
    let targetZoom = 11;
    let targetPitch = 40;

    if (activeEntry) {
      if (activeEntry.kind === 'segment') {
        const s = data.segments[activeEntry.i];
        if (s.isFlight) {
          const km = LHDerive.haversineKm(
            { lat: s.startLat, lng: s.startLng },
            { lat: s.endLat,   lng: s.endLng }
          );
          targetZoom = km > 5000 ? 2.4 : km > 2000 ? 3.4 : km > 800 ? 4.4 : 5.4;
          targetPitch = 0;
        } else {
          const km = LHDerive.haversineKm(
            { lat: s.startLat, lng: s.startLng },
            { lat: s.endLat,   lng: s.endLng }
          );
          if (s.type === 'WALKING' || s.type === 'RUNNING' || s.type === 'CYCLING') targetZoom = 14;
          else if (km > 300) targetZoom = 7;
          else if (km > 50) targetZoom = 9;
          else targetZoom = 11;
          targetPitch = 45;
        }
      } else if (activeEntry.kind === 'visit') {
        targetZoom = 13;
        targetPitch = 30;
      }
    }

    map.easeTo({
      center: [pos.lng, pos.lat],
      zoom: targetZoom,
      pitch: targetPitch,
      duration: 900,
      essential: true,
    });
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
    if (activeEntry && activeEntry.kind === 'visit') {
      const v = data.visits[activeEntry.i];
      const dur = v.t1 - v.t0;
      if (v.name && dur > 1000 * 60 * 60) {
        placeEl.textContent = v.name;
        placeEl.classList.add('show');
      } else {
        placeEl.classList.remove('show');
      }
    } else if (activeEntry && activeEntry.kind === 'segment') {
      const s = data.segments[activeEntry.i];
      const km = LHDerive.segmentKm ? LHDerive.segmentKm(s) : 0;
      if (s.type && s.type !== 'UNKNOWN') {
        placeEl.textContent = `${titleCase(s.type)} · ${km.toFixed(1)} km`;
        placeEl.classList.add('show');
      } else {
        placeEl.classList.remove('show');
      }
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
      if (!lastTs) lastTs = ts;
      const dtMs = ts - lastTs;
      lastTs = ts;
      const prevTime = state.currentTime;
      // speedSec = real-world seconds covered per 1s of wall clock
      state.currentTime = Math.min(data.t1, state.currentTime + state.speedSec * 1000 * (dtMs / 1000));
      render(prevTime);
      if (state.currentTime >= data.t1) {
        state.playing = false;
        document.getElementById('btn-play').textContent = '▶';
        document.getElementById('btn-play').classList.remove('playing');
        return;
      }
      raf = requestAnimationFrame(tick);
    }

    function render(prevTime) {
      LHRender.updateFrame(map, state.currentTime);
      const idx = activeAt(data.timeline, state.currentTime);
      let activeEntry = null;
      let pos = null;
      if (idx >= 0) {
        activeEntry = data.timeline[idx];
        if (activeEntry.t1 >= state.currentTime) {
          if (activeEntry.kind === 'visit') {
            const v = data.visits[activeEntry.i];
            pos = { lat: v.lat, lng: v.lng };
          } else {
            pos = LHDerive.positionAt(data.segments[activeEntry.i], state.currentTime);
          }
        } else {
          // between entries — hold last position
          if (activeEntry.kind === 'visit') {
            const v = data.visits[activeEntry.i];
            pos = { lat: v.lat, lng: v.lng };
          } else {
            const s = data.segments[activeEntry.i];
            pos = { lat: s.endLat, lng: s.endLng };
          }
          activeEntry = null; // no current activity for HUD purposes
        }
      }
      LHRender.setPlayhead(map, pos);
      updateHUD(data, state.currentTime, activeEntry);

      const cam = document.getElementById('cam-mode').value;
      // throttle camera updates so we don't fire easeTo every frame
      if (!state._nextCam || state.currentTime > state._nextCam) {
        updateCamera(map, pos, activeEntry, data, cam);
        state._nextCam = state.currentTime + 1000 * 60 * 60 * 6; // recompute every 6h of simulated time
      }
      fireEvents(data, prevTime, state.currentTime, state);
      syncScrubber(data, state);
      document.getElementById('time-read').textContent = fmtDate(state.currentTime);
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
    if (!scrub || scrub.dataset.dragging === '1') return;
    const f = (state.currentTime - data.t0) / Math.max(1, data.t1 - data.t0);
    scrub.value = Math.round(f * 1000);
  }

  return { createController, showBanner, fmtDate, activeAt };
})();

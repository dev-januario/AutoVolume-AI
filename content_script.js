// content_script.js
// Protótipo: analisa vídeos e aplica GainNode para reduzir picos.
// Expondo funções em window.* para serem chamadas pelo popup via scripting.executeScript

(function () {
  if (window.__AutoVolume_injected) return;
  window.__AutoVolume_injected = true;

  const settings = { enabled: true, sensitivity: 1.0 };
  chrome.storage.sync.get({ enabled: true, sensitivity: 1.0 }, (s) => {
    settings.enabled = s.enabled;
    settings.sensitivity = Number(s.sensitivity) || 1.0;
  });

  function saveSettings() {
    chrome.storage.sync.set({ enabled: settings.enabled, sensitivity: settings.sensitivity });
  }

  // Helpers
  function createAnalyzerForVideo(video) {
    if (!video) return;
    if (video.__autoVolumeNode) return video.__autoVolumeNode; // already attached

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(video);
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(ctx.destination);

    const node = {
      ctx, source, gain, analyser, video,
      baseline: null, // RMS baseline
      smoothRMS: 0,
      smoothing: 0.92,
      targetGain: 1,
      active: true,
      calibrated: false,
      lastUpdate: performance.now()
    };
    video.__autoVolumeNode = node;

    startProcessing(node);
    return node;
  }

  function computeRMS(timeDomain) {
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const v = timeDomain[i];
      sum += v * v;
    }
    return Math.sqrt(sum / timeDomain.length);
  }

  function startProcessing(node) {
    const analyser = node.analyser;
    const buffer = new Float32Array(analyser.fftSize);
    const minGain = 0.35; // nunca reduz além disso
    const maxGain = 1.6;  // opção pra pequeno boost se necessário

    function step() {
      if (!node.active) return;
      analyser.getFloatTimeDomainData(buffer);
      const rms = computeRMS(buffer) + 1e-9;
      // smoothing
      node.smoothRMS = node.smoothRMS * node.smoothing + rms * (1 - node.smoothing);

      // if not calibrated, we can set baseline to initial smoothed RMS when enabled
      if (!node.calibrated && node.video && !node.video.paused) {
        // wait a little while of playback to auto-calibrate if user didn't do manual calibrate
        // we'll set baseline after we've seen stable values (simple heuristic)
        node.calibrationCounter = (node.calibrationCounter || 0) + 1;
        if (node.calibrationCounter > 60) { // ~1s @60fps
          node.baseline = node.smoothRMS;
          node.calibrated = true;
        }
      }

      // If we have a baseline, compute desired gain to keep perceived loudness near baseline
      if (node.baseline && settings.enabled) {
        const sensitivity = settings.sensitivity || 1.0;
        // if current is louder than baseline * sensitivity => reduce
        const threshold = node.baseline * sensitivity;
        let desiredGain = 1;
        if (node.smoothRMS > threshold) {
          desiredGain = node.baseline / node.smoothRMS;
        } else {
          // small soft knee: allow slight boost when much quieter (optional)
          if (node.smoothRMS < node.baseline * 0.6) {
            desiredGain = Math.min(maxGain, node.baseline / Math.max(node.smoothRMS, 1e-9));
          } else {
            desiredGain = 1;
          }
        }
        // clamp
        desiredGain = Math.max(minGain, Math.min(maxGain, desiredGain));

        // smooth gain changes (attack/release)
        const now = performance.now();
        const dt = Math.min(0.1, (now - node.lastUpdate) / 1000);
        node.lastUpdate = now;
        const alpha = dt * 8; // smoothing factor
        node.targetGain = node.targetGain * (1 - alpha) + desiredGain * alpha;

        // actually apply to gain node
        try {
          node.gain.gain.setTargetAtTime(node.targetGain, node.ctx.currentTime, 0.05);
        } catch (e) {
          // some contexts might be suspended; resume
          node.ctx.resume().catch(()=>{});
        }
      } else {
        // no baseline or disabled -> ensure gain = 1
        node.gain.gain.setTargetAtTime(1, node.ctx.currentTime, 0.05);
      }

      requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  // find videos and attach
  function attachToAllVideos() {
    const vids = Array.from(document.querySelectorAll('video'));
    vids.forEach(v => {
      try { createAnalyzerForVideo(v); } catch(e) {}
    });
  }

  // Observe DOM for new videos
  const obs = new MutationObserver(() => attachToAllVideos());
  obs.observe(document, { childList: true, subtree: true });
  attachToAllVideos();

  // Public control functions (exposed to popup)
  window.__AutoVolume_setEnabled = (v) => {
    settings.enabled = !!v;
    saveSettings();
    // if disabling, set gains back to 1
    if (!settings.enabled) {
      document.querySelectorAll('video').forEach(v => {
        if (v.__autoVolumeNode) {
          try { v.__autoVolumeNode.gain.gain.setTargetAtTime(1, v.__autoVolumeNode.ctx.currentTime, 0.05); } catch(e){}
        }
      });
    }
  };

  window.__AutoVolume_setSensitivity = (s) => {
    settings.sensitivity = Number(s) || 1.0;
    saveSettings();
  };

  window.__AutoVolume_calibrate = () => {
    // calibrate all attached nodes using current smoothRMS average over ~1.2s
    document.querySelectorAll('video').forEach(v => {
      const node = v.__autoVolumeNode;
      if (!node) return;
      // sample for 1.2s and set baseline to mean smoothRMS
      let samples = [];
      const analyser = node.analyser;
      const buf = new Float32Array(analyser.fftSize);
      let cnt = 0;
      const maxFrames = 72; // ~1.2s @60fps
      function sample() {
        analyser.getFloatTimeDomainData(buf);
        samples.push(computeRMS(buf));
        cnt++;
        if (cnt < maxFrames) requestAnimationFrame(sample);
        else {
          const mean = samples.reduce((a,b)=>a+b,0)/samples.length;
          node.baseline = mean + 1e-9;
          node.calibrated = true;
          console.log('AutoVolume: baseline calibrated', node.baseline);
        }
      }
      sample();
    });
  };

  window.__AutoVolume_reset = () => {
    chrome.storage.sync.clear();
    // reset nodes
    document.querySelectorAll('video').forEach(v => {
      const n = v.__autoVolumeNode;
      if (!n) return;
      try {
        n.gain.gain.setTargetAtTime(1, n.ctx.currentTime, 0.05);
        n.baseline = null;
        n.calibrated = false;
      } catch(e){}
    });
  };

  // react to storage changes (if popup changed settings)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.enabled) settings.enabled = changes.enabled.newValue;
      if (changes.sensitivity) settings.sensitivity = Number(changes.sensitivity.newValue);
    }
  });

  // also attach when clicking videos (user may click before popup calibrates)
  document.addEventListener('play', (e) => {
    const t = e.target;
    if (t && t.tagName === 'VIDEO') createAnalyzerForVideo(t);
  }, true);

})();

const enabledCheckbox = document.getElementById('enabled');
const sensitivitySlider = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const calibrateBtn = document.getElementById('calibrate');
const resetBtn = document.getElementById('reset');

function loadSettings() {
  chrome.storage.sync.get(
    { enabled: true, sensitivity: 1.0 },
    (items) => {
      enabledCheckbox.checked = items.enabled;
      sensitivitySlider.value = items.sensitivity;
      sensitivityVal.textContent = Number(items.sensitivity).toFixed(1);
    }
  );
}

enabledCheckbox.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledCheckbox.checked });
  // notify content scripts
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    for (const t of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: (enabled) => window.__AutoVolume_setEnabled?.(enabled),
        args: [enabledCheckbox.checked]
      }).catch(()=>{});
    }
  });
});

sensitivitySlider.addEventListener('input', () => {
  const val = Number(sensitivitySlider.value);
  sensitivityVal.textContent = val.toFixed(1);
  chrome.storage.sync.set({ sensitivity: val });
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    for (const t of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: (s) => window.__AutoVolume_setSensitivity?.(s),
        args: [val]
      }).catch(()=>{});
    }
  });
});

calibrateBtn.addEventListener('click', async () => {
  // Tell content script to calibrate (sample current levels)
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    for (const t of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => window.__AutoVolume_calibrate?.()
      }).catch(()=>{});
    }
  });
});

resetBtn.addEventListener('click', () => {
  chrome.storage.sync.clear(() => loadSettings());
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    for (const t of tabs) {
      chrome.scripting.executeScript({
        target: { tabId: t.id },
        func: () => window.__AutoVolume_reset?.()
      }).catch(()=>{});
    }
  });
  loadSettings();
});

loadSettings();

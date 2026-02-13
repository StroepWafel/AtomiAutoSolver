const ext = typeof browser !== 'undefined' ? browser : chrome;
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// Exclude non-chat models (audio, safety, etc.)
function isChatModel(id) {
  const exclude = ['whisper', 'orpheus', 'prompt-guard', 'safeguard'];
  const lower = (id || '').toLowerCase();
  return !exclude.some(k => lower.includes(k));
}

async function fetchModels(apiKey) {
  const res = await fetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${res.status}`);
  }
  const data = await res.json();
  const models = (data.data || []).filter(m => isChatModel(m.id));
  return models.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
}

async function loadModels() {
  const select = document.getElementById('model');
  const modelError = document.getElementById('modelError');
  const { apiKey, model: savedModel } = await ext.storage.local.get(['apiKey', 'model']);

  if (!apiKey || !apiKey.trim()) {
    select.innerHTML = '<option value="">Save API key to load models</option>';
    modelError.style.display = 'none';
    return;
  }

  select.innerHTML = '<option value="">Loading...</option>';
  modelError.style.display = 'none';

  try {
    const models = await fetchModels(apiKey);
    select.innerHTML = '';
    if (models.length === 0) {
      select.innerHTML = '<option value="">No models found</option>';
      return;
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id;
      select.appendChild(opt);
    }
    if (savedModel && models.some(m => m.id === savedModel)) {
      select.value = savedModel;
    } else {
      select.value = models[0]?.id || '';
    }
  } catch (err) {
    select.innerHTML = '<option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile (default)</option>';
    modelError.textContent = `Could not load models: ${err.message}`;
    modelError.style.display = 'block';
  }
}

document.getElementById('showPanel').onclick = async () => {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    ext.tabs.sendMessage(tab.id, { action: 'showPanel' }).then(() => {
      const status = document.getElementById('panelStatus');
      status.textContent = 'Panel shown! Check the page.';
      status.style.display = 'block';
      setTimeout(() => { status.style.display = 'none'; }, 3000);
    }).catch(() => {
      const status = document.getElementById('panelStatus');
      status.textContent = 'Reload the page and try again.';
      status.style.display = 'block';
    });
  }
};

document.getElementById('save').onclick = async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value;
  await ext.storage.local.set({ apiKey, model });
  document.getElementById('saved').style.display = 'block';
  setTimeout(() => {
    document.getElementById('saved').style.display = 'none';
  }, 2000);
};

ext.storage.local.get(['apiKey', 'model'], async ({ apiKey, model }) => {
  if (apiKey) document.getElementById('apiKey').value = apiKey;
  await loadModels();
});

document.getElementById('save').addEventListener('click', async () => {
  await new Promise(r => setTimeout(r, 300));
  loadModels();
});

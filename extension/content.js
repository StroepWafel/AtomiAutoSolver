/**
 * Atomi Quiz Auto Solver - Content Script
 * Detects Atomi quiz pages, calls Groq API, and auto-fills answers
 * Supports Chrome and Firefox
 */

const ext = typeof browser !== 'undefined' ? browser : chrome;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';
const SYSTEM_PROMPT = `You solve quiz questions. You are given a question and possible answers numbered 1, 2, 3, etc.
Respond with ONLY the number of the correct answer. Nothing else. No explanation. Just the digit.
Example: if the 3rd answer is correct, respond with: 3`;

const WORKING_OUT_PROMPT = `You solve maths/physics working-out questions. Output ONLY the raw working to put in the answer field.
- Use LaTeX notation (e.g. \\frac{a}{b}, x^2, \\sqrt{x}, =, \\therefore)
- Put each step on a new line: use \\\\ between steps, or use \\begin{align*}...\\\\...\\\\ \\end{align*}
- Example format: y(t)=y_0+vt-\\frac{1}{2}gt^2 \\\\ y=y_0 \\Rightarrow t(v-\\frac{1}{2}gt)=0 \\\\ t=\\frac{2v}{g}
- Include any required assumptions in one short line if needed (e.g. "Assume g=10")
- No explanations, no "Step 1:", no preamble - just the maths and working
- Output a single block that can be pasted directly into a math input field`;

// Quiz detection selectors (flexible for Atomi's structure)
const QUIZ_SELECTORS = {
  article: 'article',
  answerList: 'ul[aria-labelledby]',
  answerItems: 'ul[aria-labelledby] > li',
  answerButton: 'button[type="button"]',
  checkAnswerBtn: (doc) => Array.from(doc.querySelectorAll('button')).find(b => b.textContent?.includes('Check Answer')),
  nextButton: (doc) => Array.from(doc.querySelectorAll('button')).find(b => {
    const t = b.textContent?.trim().toLowerCase() || '';
    return (t.includes('next') || t.includes('continue') || t === '→') && !t.includes('check');
  }),
  backButton: (doc) => Array.from(doc.querySelectorAll('button')).find(b => b.textContent?.includes('Back')),
};

function findInDocument(root, selector) {
  const el = root.querySelector?.(selector);
  if (el) return el;
  for (const node of root.querySelectorAll?.('*') || []) {
    if (node.shadowRoot) {
      const found = findInDocument(node.shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

function isWorkingOutPage() {
  const mathField = findInDocument(document, 'math-field') || document.querySelector('math-field');
  if (!mathField) return false;
  const selfMarkBtn = Array.from(document.querySelectorAll('button')).find(b =>
    (b.textContent || '').includes('Self-mark'));
  return !!selfMarkBtn;
}

function hasInertAncestor(el) {
  let p = el?.parentElement;
  while (p) {
    if (p.hasAttribute?.('inert')) return true;
    p = p.parentElement;
  }
  return false;
}

function getMathField() {
  const label = Array.from(document.querySelectorAll('label')).find(l =>
    (l.textContent || '').trim() === 'Your answer');
  if (label?.htmlFor) {
    const mf = document.getElementById(label.htmlFor);
    if (mf?.tagName === 'MATH-FIELD' && !hasInertAncestor(mf)) return mf;
  }
  if (label?.control?.tagName === 'MATH-FIELD') return label.control;
  const byAria = document.querySelector('math-field[aria-label*="Your answer"]');
  if (byAria && !hasInertAncestor(byAria)) return byAria;
  const all = document.querySelectorAll('math-field');
  for (const mf of all) {
    if (hasInertAncestor(mf)) continue;
    const rect = mf.getBoundingClientRect();
    const style = getComputedStyle(mf);
    if (rect.width > 50 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none') {
      return mf;
    }
  }
  return document.querySelector('math-field');
}

function getWorkingOutQuestionText() {
  const roots = document.querySelectorAll('[class*="Markdown_root"]');
  const parts = [];
  for (const root of roots) {
    const paras = root.querySelectorAll('[class*="Markdown_paragraph"], p');
    for (const p of paras) {
      const t = p.textContent?.trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
    const imgs = root.querySelectorAll('img[alt]');
    for (const img of imgs) {
      const alt = img.getAttribute('alt')?.trim();
      if (alt) parts.push(`[Image: ${alt}]`);
    }
  }
  const marksEl = document.querySelector('[class*="marks"]') || Array.from(document.querySelectorAll('p')).find(p => /^\d+\s*marks?$/i.test(p?.textContent?.trim() || ''));
  if (marksEl) parts.push((marksEl.textContent || '').trim());
  return parts.filter(Boolean).join('\n').trim();
}

let panel = null;
let isAutoRunning = false;
let videoAutoAdvanceEnabled = false;
let videoEndedListener = null;
let wistiaConfigRef = null;

function isVideoPage() {
  const hasVideoPlayer = document.querySelector('[class*="VideoPlayer"]') || document.querySelector('[class*="PostVideoPlayer"]');
  const hasWistia = document.querySelector('.wistia_embed') || document.querySelector('[id*="wistia"]');
  const hasPagination = document.querySelector('[data-test="post-pagination"]');
  const video = document.querySelector('video');
  const hasIframe = document.querySelector('iframe[src*="wistia"]');
  return !!(hasVideoPlayer || hasWistia || hasPagination) && !!(video || hasIframe);
}

function getVideoNextButton() {
  const links = document.querySelectorAll('a[data-test="post-pagination-link"]');
  for (const el of links) {
    if (el.className && el.className.includes('isDirectionSwitched')) return el;
    if ((el.textContent || '').toLowerCase().includes('up next')) return el;
  }
  for (const el of document.querySelectorAll('a[href], button')) {
    const text = (el.textContent || '').trim().toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const isNext = text.includes('next') || ariaLabel.includes('next');
    if (isNext && !text.includes('check') && !text.includes('prev')) return el;
  }
  return null;
}

function clickNextLink(el) {
  if (!el) return;
  const href = el.getAttribute('href');
  if (href && el.tagName === 'A' && window.location.origin.startsWith('http')) {
    window.location.href = new URL(href, window.location.origin).href;
  } else {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.click();
  }
}

function setupVideoAutoAdvance(statusCallback) {
  const advanceToNext = () => {
    if (videoEndedListener?.interval) {
      clearInterval(videoEndedListener.interval);
      videoEndedListener.interval = null;
    }
    const nextBtn = getVideoNextButton();
    if (nextBtn) {
      statusCallback?.('Advancing to next...');
      clickNextLink(nextBtn);
      videoEndedListener = null;
      setTimeout(() => {
        if (videoAutoAdvanceEnabled && isVideoPage()) setupVideoAutoAdvance(statusCallback);
      }, 2000);
    } else {
      statusCallback?.('No Next button found');
    }
  };

  const ADVANCE_SECONDS_BEFORE_END = 10;
  const TARGET_PLAYBACK_RATE = 2;

  function findVideoElement() {
    if (!document.body) return null;
    const walk = (root) => {
      try {
        const v = root.querySelector('video');
        if (v) return v;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = walk(el.shadowRoot);
            if (found) return found;
          }
        }
      } catch (_) {}
      return null;
    };
    return walk(document.body);
  }

  const attachNativeListener = (video) => {
    if (!video || !videoAutoAdvanceEnabled) return;
    try { video.playbackRate = TARGET_PLAYBACK_RATE; } catch (_) {}
    const tryPlay = () => {
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    };
    try { tryPlay(); } catch (_) {}
    let advanced = false;
    const checkTime = () => {
      if (!videoAutoAdvanceEnabled || advanced) return;
      const duration = video.duration;
      const current = video.currentTime;
      if (duration > 0 && !isNaN(duration) && current >= Math.max(0, duration - ADVANCE_SECONDS_BEFORE_END)) {
        advanced = true;
        advanceToNext();
      }
      if (video.ended) {
        advanced = true;
        advanceToNext();
      }
    };
    const onTimeUpdate = () => checkTime();
    const onEnded = () => {
      if (!videoAutoAdvanceEnabled || advanced) return;
      advanced = true;
      advanceToNext();
    };
    if (videoEndedListener && videoEndedListener.interval) clearInterval(videoEndedListener.interval);
    if (videoEndedListener) {
      try {
        video.removeEventListener('timeupdate', videoEndedListener.timeUpdate);
        video.removeEventListener('ended', videoEndedListener.ended);
      } catch (_) {}
    }
    const poll = setInterval(checkTime, 500);
    videoEndedListener = { timeUpdate: onTimeUpdate, ended: onEnded, interval: poll };
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
  };

  const tryWistiaApi = () => {
    if (typeof window === 'undefined') return false;
    window._wq = window._wq || [];
    if (wistiaConfigRef) {
      try { window._wq.push({ revoke: wistiaConfigRef }); } catch (_) {}
      wistiaConfigRef = null;
    }
    const config = {
      id: '_all',
      onReady: (video) => {
        if (!videoAutoAdvanceEnabled) return;
        try { video.playbackRate(TARGET_PLAYBACK_RATE); } catch (_) {}
        try { video.play().catch(() => video.mute()); } catch (_) {}
        let advanced = false;
        video.bind('timechange', (t) => {
          if (!videoAutoAdvanceEnabled || advanced) return;
          const duration = video.duration();
          if (duration > 0 && t >= duration - ADVANCE_SECONDS_BEFORE_END) {
            advanced = true;
            advanceToNext();
          }
        });
        video.bind('end', () => {
          if (!videoAutoAdvanceEnabled || advanced) return;
          advanced = true;
          advanceToNext();
        });
      },
    };
    wistiaConfigRef = config;
    window._wq.push(config);
    return true;
  };

  const video = findVideoElement();
  if (video) {
    attachNativeListener(video);
    statusCallback?.('Listening for video end');
    return;
  }

  const hasWistia = document.querySelector('[id*="wistia"]') || document.querySelector('.wistia_embed') || document.querySelector('iframe[src*="wistia"]');
  if (hasWistia && tryWistiaApi()) {
    statusCallback?.('Using Wistia API');
    return;
  }

  const obs = new MutationObserver(() => {
    const v = findVideoElement();
    if (v) {
      attachNativeListener(v);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => obs.disconnect(), 15000);
}

function isQuizPage() {
  // Check for answer list structure (ul with aria-labelledby containing choice buttons)
  const answerList = document.querySelector(QUIZ_SELECTORS.answerList);
  if (!answerList) return false;

  const answerItems = answerList.querySelectorAll(QUIZ_SELECTORS.answerItems);
  if (!answerItems || answerItems.length < 2) return false;

  // Check that answer items have clickable buttons
  const buttons = Array.from(answerItems).map(li => li.querySelector(QUIZ_SELECTORS.answerButton)).filter(Boolean);
  if (buttons.length < 2) return false;

  return true;
}

function getQuestionText() {
  const article = document.querySelector(QUIZ_SELECTORS.article);
  if (!article) return '';

  // Find the question area - typically in a div before the answer list
  const answerList = article.querySelector(QUIZ_SELECTORS.answerList);
  let questionContainer = answerList?.previousElementSibling;
  while (questionContainer) {
    const text = questionContainer.textContent?.trim();
    if (text && !text.includes('Atomi Question') && text.length > 5) {
      return text.replace(/Atomi Question\s*/i, '').trim();
    }
    questionContainer = questionContainer.previousElementSibling;
  }

  // Fallback: get all text from article before the answer list
  const allText = article.innerText || article.textContent || '';
  const parts = allText.split(/(?=Choice [A-Z]|50\.|53\.|56\.)/i);
  return (parts[0] || allText).replace(/Atomi Question\s*/i, '').trim();
}

function getAnswers() {
  const answerList = document.querySelector(QUIZ_SELECTORS.answerList);
  if (!answerList) return [];

  const items = answerList.querySelectorAll(QUIZ_SELECTORS.answerItems);
  return Array.from(items).map(li => {
    const btn = li.querySelector(QUIZ_SELECTORS.answerButton);
    if (!btn) return '';
    // Get answer text - exclude "Choice A" etc
    const textEl = btn.querySelector('[class*="Markdown"]') || btn.querySelector('div');
    return (textEl?.textContent || btn.textContent || '').replace(/Choice [A-Z]\s*/i, '').trim();
  }).filter(t => t);
}

function getAnswerButtons() {
  const answerList = document.querySelector(QUIZ_SELECTORS.answerList);
  if (!answerList) return [];

  const items = answerList.querySelectorAll(QUIZ_SELECTORS.answerItems);
  return Array.from(items).map(li => li.querySelector(QUIZ_SELECTORS.answerButton)).filter(Boolean);
}

async function callGroqAPI(apiKey, model, question, answers) {
  const answersText = answers.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const userContent = `Question:\n${question}\n\nPossible answers:\n${answersText}\n\nReply with only the number (1-${answers.length}):`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: 256,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message || {};
  const content = (msg.content || '').trim();
  const reasoning = (msg.reasoning || '').trim();
  const combined = `${content} ${reasoning}`;
  // Parse number from content or reasoning (GPT-OSS puts answer in reasoning when content is empty)
  const matches = [...combined.matchAll(/\b([1-9]\d?)\b/g)];
  const numChoices = answers.length;
  const valid = matches.map(m => parseInt(m[1], 10)).filter(n => n >= 1 && n <= numChoices);
  return valid.length > 0 ? valid[valid.length - 1] : null;
}

async function callGroqAPIForWorkingOut(apiKey, model, question) {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: WORKING_OUT_PROMPT },
        { role: 'user', content: `Question:\n${question}\n\nOutput only the raw working out (LaTeX, no explanation):` },
      ],
      max_tokens: 2048,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message || {};
  return (msg.content || '').trim();
}

function dispatchPasteWithData(mathField, latex) {
  let dt;
  try {
    dt = new DataTransfer();
    dt.setData('text/plain', latex);
  } catch (_) {
    return false;
  }
  const evt = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });
  mathField.focus?.();
  mathField.dispatchEvent(evt);
  return true;
}

function forceSetValue(el, value) {
  try {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
      Object.getOwnPropertyDescriptor(el, 'value');
    if (desc?.set) {
      desc.set.call(el, value);
      return true;
    }
  } catch (_) {}
  el.value = value;
  return false;
}

function setMathFieldValueInPage(mathFieldId, latex) {
  if (!mathFieldId || !document.body) return;
  const safeId = String(mathFieldId).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\u003c');
  document.body.setAttribute('data-atomi-latex-temp', latex);
  const script = document.createElement('script');
  script.textContent = '(function(){var el=document.getElementById("' + safeId + '");var s=document.body.getAttribute("data-atomi-latex-temp");document.body.removeAttribute("data-atomi-latex-temp");if(!el||!s)return;try{if(typeof el.setValue==="function")el.setValue(s,{insertionMode:"replaceAll",format:"latex"});else el.value=s;el.dispatchEvent(new InputEvent("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}catch(e){}})();';
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

async function setMathFieldValue(mathField, latex) {
  const id = mathField.id;
  mathField.focus?.();
  mathField.scrollIntoView?.({ block: 'center' });

  if (id) setMathFieldValueInPage(id, latex);
  dispatchPasteWithData(mathField, latex);
  await new Promise(r => setTimeout(r, 80));

  const opts = { insertionMode: 'replaceAll', format: 'latex' };
  if (typeof mathField.setValue === 'function') {
    mathField.setValue(latex, opts);
  } else if (typeof mathField.insert === 'function') {
    mathField.insert(latex, opts);
  } else if (typeof mathField.executeCommand === 'function') {
    mathField.executeCommand('selectAll');
    mathField.executeCommand('insert', latex, { insertionMode: 'replaceSelection' });
  } else {
    forceSetValue(mathField, latex);
  }

  try {
    mathField.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    mathField.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_) {}

  await new Promise(r => setTimeout(r, 120));
  if (typeof mathField.setValue === 'function') {
    mathField.setValue(latex, opts);
  } else {
    forceSetValue(mathField, latex);
  }
  mathField.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

async function runWorkingOutAutofill(apiKey, statusCallback) {
  const mathField = getMathField();
  let question = getWorkingOutQuestionText();

  if (!mathField) {
    statusCallback?.('No math input found');
    return { success: false, error: 'No math field found' };
  }
  if (!question) {
    question = document.body?.innerText?.slice(0, 3000) || '';
    if (!question) {
      statusCallback?.('No question text found');
      return { success: false, error: 'Could not extract question' };
    }
    statusCallback?.('Using page text...');
  }

  statusCallback?.('Solving working out...');
  try {
    const { model } = await ext.storage.local.get('model');
    const workingOut = await callGroqAPIForWorkingOut(apiKey, model || DEFAULT_MODEL, question);
    if (!workingOut) {
      statusCallback?.('Empty response from API');
      return { success: false, error: 'Empty API response' };
    }
    await setMathFieldValue(mathField, workingOut);
    statusCallback?.('Working out filled');
    return { success: true };
  } catch (err) {
    statusCallback?.(`Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function solveCurrentQuestion(apiKey) {
  const question = getQuestionText();
  const answers = getAnswers();
  const buttons = getAnswerButtons();

  if (!question || answers.length === 0 || buttons.length === 0) {
    return { success: false, error: 'Could not extract question or answers' };
  }

  const { model } = await ext.storage.local.get('model');
  const answerIndex = await callGroqAPI(apiKey, model || DEFAULT_MODEL, question, answers);
  if (answerIndex === null || answerIndex < 1 || answerIndex > buttons.length) {
    return { success: false, error: `Invalid API response (got ${answerIndex})` };
  }

  // Click the correct answer (1-based index from API)
  const button = buttons[answerIndex - 1];
  button.click();
  return { success: true, index: answerIndex };
}

function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCheckAnswerEnabled(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const btn = QUIZ_SELECTORS.checkAnswerBtn(document);
    if (btn && !btn.hasAttribute('aria-disabled')) return btn;
    await waitFor(200);
  }
  return null;
}

async function waitForNextButton(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const btn = QUIZ_SELECTORS.nextButton(document);
    if (btn && !btn.disabled) return btn;
    await waitFor(200);
  }
  return null;
}

async function runSingleAutofill(apiKey, statusCallback) {
  statusCallback('Solving...');
  try {
    const result = await solveCurrentQuestion(apiKey);
    if (result.success) {
      statusCallback(`Selected answer ${result.index}`);
    } else {
      statusCallback(`Error: ${result.error}`);
    }
    return result.success;
  } catch (err) {
    statusCallback(`Error: ${err.message}`);
    return false;
  }
}

async function runAllQuestions(apiKey, statusCallback) {
  if (isAutoRunning) return;
  isAutoRunning = true;

  const runLoop = async () => {
    try {
      while (isAutoRunning && isQuizPage()) {
        statusCallback('Solving current question...');
        let solved;
        try {
          solved = await solveCurrentQuestion(apiKey);
        } catch (err) {
          statusCallback(`Error: ${err.message}`);
          break;
        }
        if (!solved.success) {
          statusCallback(`Stopped: ${solved.error}`);
          break;
        }

        await waitFor(500);

        // Click Check Answer
        const checkBtn = await waitForCheckAnswerEnabled();
        if (checkBtn) {
          checkBtn.click();
          await waitFor(1200);
        }

        // Look for Next button (may appear after checking)
        const nextBtn = await waitForNextButton(8000);
        if (nextBtn) {
          statusCallback('Moving to next question...');
          nextBtn.click();
          await waitFor(2000); // Wait for page/content to update
        } else {
          // No Next button - might be last question or different flow
          statusCallback('Quiz complete!');
          break;
        }
      }
    } finally {
      isAutoRunning = false;
      statusCallback('Ready');
    }
  };

  runLoop();
}

function createPanel() {
  if (panel) return panel;

  panel = document.createElement('div');
  panel.id = 'atomi-autosolver-panel';
  panel.innerHTML = `
    <div class="atomi-panel-header">
      <span>Atomi Auto Solver</span>
      <button type="button" id="atomi-panel-close">×</button>
    </div>
    <div class="atomi-panel-body">
      <div id="atomi-status" class="atomi-status">Ready</div>
      <div id="atomi-api-warning" class="atomi-api-warning" style="display:none;">
        <a href="#" id="atomi-set-api-link">Set your Groq API key</a>
      </div>
      <div class="atomi-buttons">
        <button type="button" id="atomi-autofill" class="atomi-btn atomi-btn-primary">Autofill</button>
        <button type="button" id="atomi-runall" class="atomi-btn atomi-btn-secondary">Run All</button>
        <button type="button" id="atomi-stop" class="atomi-btn atomi-btn-stop">Stop</button>
      </div>
      <div class="atomi-video-section" id="atomi-video-section" style="display:none;">
        <button type="button" id="atomi-video-toggle" class="atomi-btn atomi-btn-secondary">Video: Auto-advance OFF</button>
      </div>
      <div class="atomi-working-out-section" id="atomi-working-out-section" style="display:none;">
        <button type="button" id="atomi-working-out" class="atomi-btn atomi-btn-primary">Autofill Working Out</button>
      </div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #atomi-autosolver-panel {
      position: fixed;
      top: 80px;
      right: 20px;
      width: 220px;
      background: #1a1a2e;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      z-index: 2147483640;
      font-family: system-ui, -apple-system, sans-serif;
      color: #eee;
      overflow: hidden;
    }
    .atomi-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      background: #16213e;
      font-weight: 600;
      font-size: 14px;
    }
    #atomi-panel-close {
      background: none;
      border: none;
      color: #aaa;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #atomi-panel-close:hover { color: #fff; }
    .atomi-panel-body { padding: 14px; }
    .atomi-status {
      font-size: 12px;
      color: #a0a0a0;
      margin-bottom: 10px;
      min-height: 18px;
    }
    .atomi-api-warning {
      font-size: 11px;
      color: #ff9f43;
      margin-bottom: 10px;
    }
    .atomi-api-warning a {
      color: #ff9f43;
      text-decoration: underline;
    }
    .atomi-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    .atomi-video-section, .atomi-working-out-section { margin-top: 10px; }
    .atomi-btn {
      flex: 1;
      min-width: 80px;
      padding: 8px 12px;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .atomi-btn-primary { background: #0f3460; color: #fff; }
    .atomi-btn-primary:hover { background: #1a4a7a; }
    .atomi-btn-secondary { background: #e94560; color: #fff; }
    .atomi-btn-secondary:hover { background: #ff6b6b; }
    .atomi-btn-stop { background: #dc3545; color: #fff; }
    .atomi-btn-stop:hover { background: #c82333; }
    .atomi-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  return panel;
}

function showPanel() {
  createPanel();
  const quizSection = panel.querySelector('.atomi-buttons');
  const videoSection = document.getElementById('atomi-video-section');
  const workingOutSection = document.getElementById('atomi-working-out-section');
  const onQuiz = isQuizPage();
  const onVideo = isVideoPage();
  const onWorkingOut = isWorkingOutPage();
  if (quizSection) quizSection.style.display = onQuiz ? '' : 'none';
  if (videoSection) videoSection.style.display = onVideo ? '' : 'none';
  if (workingOutSection) workingOutSection.style.display = onWorkingOut ? '' : 'none';
  panel.style.display = '';
}

function hidePanel() {
  if (panel) panel.style.display = 'none';
}

function setupPanelListeners() {
  const closeBtn = document.getElementById('atomi-panel-close');
  const autofillBtn = document.getElementById('atomi-autofill');
  const runAllBtn = document.getElementById('atomi-runall');
  const statusEl = document.getElementById('atomi-status');
  const apiWarning = document.getElementById('atomi-api-warning');

  if (closeBtn) closeBtn.onclick = () => hidePanel();

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  const checkApiKey = async () => {
    const videoOnly = isVideoPage() && !isQuizPage() && !isWorkingOutPage();
    const { apiKey } = await ext.storage.local.get('apiKey');
    const hasKey = apiKey && apiKey.trim().length > 0;
    if (apiWarning) apiWarning.style.display = (videoOnly || hasKey) ? 'none' : 'block';
    return hasKey ? apiKey : null;
  };

  if (autofillBtn) {
    autofillBtn.onclick = async () => {
      const apiKey = await checkApiKey();
      if (!apiKey) return;
      autofillBtn.disabled = true;
      await runSingleAutofill(apiKey, setStatus);
      autofillBtn.disabled = false;
    };
  }

  const stopBtn = document.getElementById('atomi-stop');
  if (runAllBtn) {
    runAllBtn.onclick = async () => {
      const apiKey = await checkApiKey();
      if (!apiKey) return;
      runAllBtn.disabled = true;
      await runAllQuestions(apiKey, setStatus);
      runAllBtn.disabled = false;
    };
  }
  if (stopBtn) {
    stopBtn.onclick = () => {
      isAutoRunning = false;
      setStatus('Stopping...');
    };
  }

  const workingOutBtn = document.getElementById('atomi-working-out');
  if (workingOutBtn) {
    workingOutBtn.onclick = async () => {
      const apiKey = await checkApiKey();
      if (!apiKey) return;
      workingOutBtn.disabled = true;
      await runWorkingOutAutofill(apiKey, setStatus);
      workingOutBtn.disabled = false;
    };
  }

  const setApiLink = document.getElementById('atomi-set-api-link');
  if (setApiLink) {
    setApiLink.onclick = (e) => {
      e.preventDefault();
      window.open(ext.runtime.getURL('popup.html'), '_blank');
    };
  }

  const videoToggleBtn = document.getElementById('atomi-video-toggle');
  if (videoToggleBtn) {
    videoToggleBtn.onclick = () => {
      videoAutoAdvanceEnabled = !videoAutoAdvanceEnabled;
      ext.storage.local.set({ videoAutoAdvanceEnabled });
      videoToggleBtn.textContent = `Video: Auto-advance ${videoAutoAdvanceEnabled ? 'ON' : 'OFF'}`;
      videoToggleBtn.classList.toggle('atomi-btn-primary', videoAutoAdvanceEnabled);
      videoToggleBtn.classList.toggle('atomi-btn-secondary', !videoAutoAdvanceEnabled);
      if (videoAutoAdvanceEnabled) {
        setupVideoAutoAdvance(setStatus);
        setStatus('When video ends, will click Next');
      } else {
        setStatus('');
      }
    };
    ext.storage.local.get('videoAutoAdvanceEnabled', (data) => {
      videoAutoAdvanceEnabled = !!data.videoAutoAdvanceEnabled;
      if (videoAutoAdvanceEnabled && !isVideoPage()) {
        setTimeout(() => {
          if (!isVideoPage()) {
            videoAutoAdvanceEnabled = false;
            ext.storage.local.set({ videoAutoAdvanceEnabled });
            videoToggleBtn.textContent = 'Video: Auto-advance OFF';
            videoToggleBtn.classList.remove('atomi-btn-primary');
            videoToggleBtn.classList.add('atomi-btn-secondary');
          }
        }, 2500);
      }
      videoToggleBtn.textContent = `Video: Auto-advance ${videoAutoAdvanceEnabled ? 'ON' : 'OFF'}`;
      videoToggleBtn.classList.toggle('atomi-btn-primary', videoAutoAdvanceEnabled);
      videoToggleBtn.classList.toggle('atomi-btn-secondary', !videoAutoAdvanceEnabled);
      if (videoAutoAdvanceEnabled && isVideoPage()) {
        setupVideoAutoAdvance(setStatus);
        setStatus('Auto-advance on – video will start');
      }
    });
  }

  checkApiKey();
}

// Listen for manual trigger from popup
ext.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'showPanel') {
    showPanel();
    setupPanelListeners();
    return Promise.resolve({ shown: true });
  }
});

let videoAdvanceCheckTimer = 0;
let videoAdvanceDisableScheduled = false;
function checkVideoAutoAdvanceDisable() {
  if (videoAdvanceCheckTimer) return;
  videoAdvanceCheckTimer = setTimeout(() => { videoAdvanceCheckTimer = 0; }, 800);
  ext.storage.local.get('videoAutoAdvanceEnabled', (data) => {
    if (!data.videoAutoAdvanceEnabled) return;
    if (isVideoPage()) return;
    if (videoAdvanceDisableScheduled) return;
    videoAdvanceDisableScheduled = true;
    setTimeout(() => {
      videoAdvanceDisableScheduled = false;
      ext.storage.local.get('videoAutoAdvanceEnabled', (d) => {
        if (!d.videoAutoAdvanceEnabled) return;
        if (isVideoPage()) return;
        ext.storage.local.set({ videoAutoAdvanceEnabled: false });
        videoAutoAdvanceEnabled = false;
        if (panel) {
          const btn = document.getElementById('atomi-video-toggle');
          if (btn) {
            btn.textContent = 'Video: Auto-advance OFF';
            btn.classList.remove('atomi-btn-primary');
            btn.classList.add('atomi-btn-secondary');
          }
        }
      });
    }, 2500);
  });
}

// Run on load
function runInit() {
  if (!document.body) return;
  checkVideoAutoAdvanceDisable();
  if (isQuizPage() || isVideoPage() || isWorkingOutPage()) {
    showPanel();
    setupPanelListeners();
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { runInit(); setTimeout(runInit, 1000); });
} else {
  runInit();
  setTimeout(runInit, 1000);
}

// Re-check when page content might change (SPA navigation)
if (document.body) {
  const observer = new MutationObserver(() => {
    checkVideoAutoAdvanceDisable();
    if ((isQuizPage() || isVideoPage() || isWorkingOutPage()) && !panel) runInit();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

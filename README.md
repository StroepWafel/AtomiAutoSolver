# Atomi Auto Solver

A browser extension for [Atomi](https://learn.getatomi.com) that automatically solves quiz questions using AI and advances through videos when they finish.

## What it does

- **Quiz solver** – Uses AI to answer multiple-choice questions and clicks the correct option for you
- **Video auto-advance** – Sets videos to 2× speed and automatically opens the next page 10 seconds before the end
- **Run All** – Solves entire quizzes automatically
- **Stop** – Cancels a running Run All at any time

## Requirements

- Chrome, Edge, or Firefox
- A [Groq](https://console.groq.com) API key (free tier available)
- Atomi account / access to [learn.getatomi.com](https://learn.getatomi.com)

---

## Installation

1. Download or clone this repository
2. Open the extension page:
   - **Chrome / Edge:** `chrome://extensions/`
   - **Firefox:** `about:debugging#/runtime/this-firefox`
3. Enable **Developer mode**
4. Load the extension:
   - **Chrome / Edge:** Click **Load unpacked** → select the `extension` folder
   - **Firefox:** Click **Load Temporary Add-on...** → select the `extension` folder (or any file inside it)

5. **Chrome + local HTML testing:** If testing with local `.html` files, enable **Allow access to file URLs** for the extension in `chrome://extensions`

---

## Setup

1. Click the extension icon in your browser toolbar
2. Paste your **Groq API key** (get one at [console.groq.com/keys](https://console.groq.com/keys))
3. Choose a **model** (optional – picks from Groq's available models)
4. Click **Save**

---

## Usage

### Quiz pages

When you open an Atomi quiz, a floating panel appears in the top-right corner.

| Button | Action |
|--------|--------|
| **Autofill** | Solves the current question |
| **Run All** | Solves all questions automatically |
| **Stop** | Stops Run All |

If the panel doesn't appear, click the extension icon and choose **Show Solver on This Page**.

### Video pages

| Button | Action |
|--------|--------|
| **Video: Auto-advance OFF** | Click to turn it **ON** – videos play at 2× speed and the next page opens 10 seconds before the end |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Panel doesn't appear | Use **Show Solver on This Page** from the extension popup |
| "Set your Groq API key" | Add your API key in the extension popup and click Save |
| Wrong answers | Try a different model in the popup |
| Video auto-advance doesn't work | Enable it before or while the video plays |
| Local HTML won't run | In Chrome, enable "Allow access to file URLs" for the extension |

---

## Disclaimer

This extension is for educational use. Automating quizzes may violate Atomi's terms of service. Use at your own discretion.

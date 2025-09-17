/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';
import * as THREE from 'three';
import * as lamejs from 'lamejs';

import {
  GoogleGenAI,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import {decode, decodeAudioData, resampleAndEncodeAudio} from './utils';

const ai = new GoogleGenAI({
  apiKey: process.env.API_KEY,
  apiVersion: 'v1alpha',
});
let model = 'lyria-realtime-exp';

interface PromptBase {
  readonly promptId: string;
  readonly type: 'text' | 'audio';
  readonly color: string;
  weight: number;
  x: number;
  y: number;
}

interface TextPrompt extends PromptBase {
  readonly type: 'text';
  text: string;
  modifiers: {
    style: string;
    character: string;
    effect: string;
    density: number;
    tone: number;
  };
}

interface AudioPrompt extends PromptBase {
  readonly type: 'audio';
  name: string; // filename
  data: string; // base64 encoded audio
  waveformData: Float32Array | number[]; // for visualization and serialization
  text: string; // User-provided text direction
  variation: number; // Knob value 0-1
}

type Prompt = TextPrompt | AudioPrompt;

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/** Throttles a callback to be called at most once per `freq` milliseconds. */
function throttle(func: (...args: unknown[]) => void, delay: number) {
  let lastCall = 0;
  return (...args: unknown[]) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      func(...args);
      lastCall = now;
    }
  };
}

const MAJOR_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'];
const MINOR_KEYS = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'Bb', 'F', 'C', 'G', 'D'];
const ALL_KEYS = [
    ...MAJOR_KEYS.map(k => `${k} Major`),
    ...MINOR_KEYS.map(k => `${k} minor`)
].sort();


const PROMPT_TEXT_PRESETS = [
  'Bossa Nova',
  'Minimal Techno',
  'Drum and Bass',
  'Post Punk',
  'Shoegaze',
  'Funk',
  'Chiptune',
  'Lush Strings',
  'Sparkling Arpeggios',
  'Staccato Rhythms',
  'Punchy Kick',
  'Dubstep',
  'K Pop',
  'Neo Soul',
  'Trip Hop',
  'Thrash',
];

const COLORS = [
  '#be00ff', // Purple
  '#0094ff', // Blue
  '#ff00a0', // Magenta
  '#00f5d4', // Teal
  '#ffdd28', // Yellow
  '#3dffab', // Green
  '#ff3e3e', // Red
  '#ff8928', // Orange
];

function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) {
    // If no available colors, pick a random one from the original list.
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// WeightSlider component
// -----------------------------------------------------------------------------
/** A slider for adjusting and visualizing prompt weight. */
@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      display: flex;
      justify-content: center;
      flex-direction: column;
      align-items: center;
      padding: 5px 0;
      box-sizing: border-box;
    }
    .scroll-container {
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value-display {
      font-size: 1.8vmin;
      color: #c0b4f8;
      margin-top: 0.5vmin;
      user-select: none;
      text-align: center;
    }
    .slider-container {
      position: relative;
      width: 10px;
      height: 100%;
      background-color: #0005;
      border: 1px solid #c0b4f8;
    }
    #thumb {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      box-shadow: 0 0 5px, 0 0 10px;
    }
  `;

  @property({type: Number}) value = 0; // Range 0-2
  @property({type: String}) color = '#c0b4f8';

  @query('.scroll-container') private scrollContainer!: HTMLDivElement;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.containerBounds = this.scrollContainer.getBoundingClientRect();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('touchmove', this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener('pointerup', this.handlePointerUp, {once: true});
    this.updateValueFromPosition(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientY);
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.updateValueFromPosition(e.touches[0].clientY);
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    document.body.classList.remove('dragging');
    this.containerBounds = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.005;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchInputEvent();
  }

  private updateValueFromPosition(clientY: number) {
    if (!this.containerBounds) return;

    const trackHeight = this.containerBounds.height;
    // Calculate position relative to the top of the track
    const relativeY = clientY - this.containerBounds.top;
    // Invert and normalize (0 at bottom, 1 at top)
    const normalizedValue =
      1 - Math.max(0, Math.min(trackHeight, relativeY)) / trackHeight;
    // Scale to 0-2 range
    this.value = normalizedValue * 2;

    this.dispatchInputEvent();
  }

  private dispatchInputEvent() {
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const thumbHeightPercent = (this.value / 2) * 100;
    const thumbStyle = styleMap({
      height: `${thumbHeightPercent}%`,
      backgroundColor: this.color,
      boxShadow: `0 0 5px ${this.color}, 0 0 10px ${this.color}`,
      display: this.value > 0.01 ? 'block' : 'none',
    });
    const displayValue = this.value.toFixed(2);

    return html`
      <div
        class="scroll-container"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="slider-container">
          <div id="thumb" style=${thumbStyle}></div>
        </div>
        <div class="value-display">${displayValue}</div>
      </div>
    `;
  }
}

// Base class for icon buttons.
class StyledButton extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
    }
    .button {
      background: linear-gradient(to bottom, #2a1f50, #1a1238);
      border: 1px solid #4a3c99;
      border-radius: 0.5vmin;
      color: #c0b4f8;
      padding: 0.5em 1em;
      font-family: 'Roboto Mono', monospace;
      font-size: 1.8vmin;
      cursor: pointer;
      text-transform: uppercase;
      user-select: none;
      transition: all 0.1s ease-out;
      box-shadow: 
          inset 0 1px 1px rgba(255, 255, 255, 0.1),
          0 2px 3px rgba(0, 0, 0, 0.4),
          0 0 5px #6c52ff80;
    }
    .button:hover, .button.active {
        background: linear-gradient(to bottom, #4a3c99, #3a2e7a);
        color: #fff;
        text-shadow: 0 0 5px #fff;
        box-shadow: 
            inset 0 1px 1px rgba(255, 255, 255, 0.2),
            0 2px 3px rgba(0, 0, 0, 0.4),
            inset 0 0 10px #9c82ff, 
            0 0 10px #6c52ff;
    }
    .button.active {
        animation: pulse 1s infinite;
    }
    .button:active {
      transform: translateY(1px) scale(0.98);
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.4), 0 0 5px #6c52ff80;
    }
    @keyframes pulse {
        0% { background: rgba(255, 0, 160, 0.3); }
        50% { background: rgba(255, 0, 160, 0.6); }
        100% { background: rgba(255, 0, 160, 0.3); }
    }
  ` as CSSResultGroup;

  @property({type: String}) text = '';
  @property({type: Boolean}) active = false;

  override render() {
    return html`<div class=${classMap({ button: true, active: this.active})}>${this.text}</div>`;
  }
}

@customElement('play-pause-button')
export class PlayPauseButton extends StyledButton {
  @property({type: String}) playbackState: PlaybackState = 'stopped';
  
  override render() {
    let text = 'STANDBY';
    if(this.playbackState === 'playing') text = 'ON AIR';
    if(this.playbackState === 'loading') text = 'CONNECTING...';

    return html`<div class=${classMap({ button: true, active: this.playbackState === 'playing'})}>${text}</div>`;
  }
}

@customElement('record-button')
export class RecordButton extends StyledButton {
  @property({ type: Boolean }) isRecording = false;

  override render() {
    const text = this.isRecording ? 'RECORDING...' : 'RECORD';
    return html`<div class=${classMap({ button: true, active: this.isRecording })}>${text}</div>`;
  }
}

@customElement('reset-button')
export class ResetButton extends StyledButton {
  constructor() {
    super();
    this.text = 'RESET';
  }
}

@customElement('add-prompt-button')
export class AddPromptButton extends StyledButton {
  constructor() {
    super();
    this.text = 'NEW TEXT';
  }
}

@customElement('upload-audio-button')
export class UploadAudioButton extends StyledButton {
  constructor() {
    super();
    this.text = 'NEW AUDIO';
  }
}

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #0d021a;
      color: #c0b4f8;
      padding: 15px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 1001;
      border: 1px solid #6c52ff;
      box-shadow: inset 0 0 5px #6c52ff, 0 0 5px #6c52ff;
    }
    button {
      background: none;
      border: 1px solid #6c52ff;
      color: #c0b4f8;
      cursor: pointer;
      width: 25px;
      height: 25px;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({type: String}) message = '';
  @property({type: Boolean}) showing = false;

  override render() {
    return html`<div class=${classMap({showing: this.showing, toast: true})}>
      <div class="message">> ${this.message}</div>
      <button @click=${this.hide}>X</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }
}

@customElement('rotary-knob')
class RotaryKnob extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      width: 10vmin;
      height: 10vmin;
      cursor: ns-resize;
      user-select: none;
    }
    .knob-container {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .knob-base {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 35%, #4a4a4a, #1a1a1a 70%);
      box-shadow: 
          inset 0 0.3vmin 0.5vmin rgba(255, 255, 255, 0.1), 
          inset 0 -0.3vmin 0.5vmin rgba(0, 0, 0, 0.5), 
          0 0.5vmin 1.5vmin rgba(0,0,0,0.8);
      border: 0.2vmin solid #111;
    }
    .knob-indicator {
      position: absolute;
      width: 0.5vmin;
      height: 40%;
      background: var(--glow-color, #ff3e3e);
      bottom: 50%;
      left: 50%;
      transform-origin: bottom center;
      transform: translateX(-50%);
      border-radius: 1vmin;
      box-shadow: 
          0 0 4px var(--glow-color, #ff3e3e), 
          0 0 8px var(--glow-color, #ff3e3e),
          inset 0 0 2px rgba(255,255,255,0.5);
    }
    .knob-value {
        position: absolute;
        bottom: -2vmin;
        color: var(--glow-color, #c0b4f8);
        font-size: 1.5vmin;
    }
  `;

  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = -1;
  @property({ type: Number }) max = 1;

  private startY = 0;
  private startValue = 0;

  private onPointerDown(e: PointerEvent) {
    e.preventDefault();
    this.startY = e.clientY;
    this.startValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  private onPointerMove = (e: PointerEvent) => {
    const deltaY = this.startY - e.clientY;
    const range = this.max - this.min;
    // Adjust sensitivity: larger divisor = less sensitive
    const newValue = this.startValue + (deltaY / 150) * range;
    this.value = Math.max(this.min, Math.min(this.max, newValue));
    this.dispatchEvent(new CustomEvent('input', { detail: { value: this.value } }));
  }

  private onPointerUp = () => {
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', this.onPointerMove);
  }

  override render() {
    const totalAngleRange = 270; // e.g., from -135 to +135 degrees
    const startAngle = -135;
    const normalizedValue = (this.value - this.min) / (this.max - this.min);
    const rotation = startAngle + normalizedValue * totalAngleRange;

    return html`
      <div class="knob-container" @pointerdown=${this.onPointerDown}>
        <div class="knob-base"></div>
        <div class="knob-indicator" style=${styleMap({ transform: `translateX(-50%) rotate(${rotation}deg)` })}></div>
      </div>
    `;
  }
}


/** A single text prompt input */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    :host {
      height: 42vmin;
      width: 25vmin;
      position: absolute;
      user-select: none;
      --glow-color: #c0b4f8;
      font-size: 1.5vmin;
    }
    .prompt {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      overflow: hidden;
      border: 1px solid;
      background-color: rgba(13, 2, 26, 0.7);
      backdrop-filter: blur(5px);
    }
    .prompt.active {
      animation-name: pulse-glow;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
    }
    @keyframes pulse-glow {
      0%, 100% {
        box-shadow: inset 0 0 10px var(--glow-color), 0 0 10px var(--glow-color);
      }
      50% {
        box-shadow: inset 0 0 20px var(--glow-color), 0 0 20px var(--glow-color);
      }
    }
    .header {
      width: 100%;
      display: flex;
      height: 2.5vmin;
      border-bottom: 1px solid;
    }
    .drag-handle {
      flex-grow: 1;
      cursor: grab;
      background-color: rgba(108, 82, 255, 0.1);
    }
    .remove-button {
      background: #0d021a;
      color: #c0b4f8;
      border: none;
      border-left: 1px solid;
      width: 2.5vmin;
      height: 100%;
      font-size: 1.5vmin;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0.5;
      transition: all 0.2s;
      z-index: 10;
    }
    .remove-button:hover {
      opacity: 1;
      background: #ff00a0;
      color: #fff;
    }
    .main-content {
      display: flex;
      flex-grow: 1;
      width: 100%;
      overflow: hidden;
    }
    .slider-column {
      width: 6vmin;
      height: 100%;
      border-right: 1px solid;
    }
    weight-slider {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }
    .controls-column {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      position: relative; /* for canvas positioning */
    }
    #text {
      font-family: 'Roboto Mono', monospace;
      font-size: 2vmin;
      width: 100%;
      min-height: 6vmin;
      padding: 0.8vmin;
      box-sizing: border-box;
      text-align: center;
      word-wrap: break-word;
      overflow-y: auto;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      background: transparent;
      scrollbar-width: none;
      user-select: text;
      position: relative; /* for canvas layering */
      z-index: 2; /* for canvas layering */
    }
    #text::-webkit-scrollbar {
      display: none;
    }
    .energy-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
    }
    .modifiers {
      border-top: 1px solid;
      padding: 0.5vmin;
      position: relative; /* for canvas layering */
      z-index: 2; /* for canvas layering */
      background: rgba(13, 2, 26, 0.7); /* ensure background is solid */
    }
    .mod-header {
        text-align: center;
        text-transform: uppercase;
        font-size: 1.3vmin;
        padding-bottom: 0.5vmin;
        cursor: pointer;
        opacity: 0.7;
    }
    .mod-controls.hidden {
        display: none;
    }
    .mod-row {
        display: grid;
        grid-template-columns: 6vmin 1fr;
        gap: 0.5vmin;
        align-items: center;
        margin-bottom: 0.5vmin;
    }
    .mod-row label {
        text-align: right;
        font-size: 1.3vmin;
    }
    .mod-row select, .mod-row input {
        width: 100%;
        background: rgba(13, 2, 26, 0.8);
        border: 1px solid;
        color: #c0b4f8;
        font-family: 'Roboto Mono', monospace;
        font-size: 1.3vmin;
    }
    .mod-row input[type=range] {
        -webkit-appearance: none;
        background: transparent;
        padding: 0;
    }
    .mod-row input[type=range]::-webkit-slider-runnable-track {
        height: 1px;
        background: var(--glow-color);
        border: 1px solid var(--glow-color);
    }
    .mod-row input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none;
        height: 1.5vmin;
        width: 0.8vmin;
        background: var(--glow-color);
        margin-top: -0.7vmin;
    }

    .knob-area {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1vmin;
      border-top: 1px solid;
      padding-top: 1vmin;
    }

    .knob-label {
        font-size: 1.3vmin;
        text-transform: uppercase;
    }

    :host([filtered='true']) #text {
      background: #800;
      color: #f00;
      text-shadow: 0 0 5px #f00;
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) text = '';
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '';
  @property({type: Object}) modifiers = { style: 'Normal', character: 'Default', effect: 'None', density: 0.5, tone: 0 };
  @property({type: Object}) frequencyData: Uint8Array | null = null;
  @property({type: Number}) bpm = 120;
  @state() private modsVisible = true;

  @query('weight-slider') private weightInput!: WeightSlider;
  @query('#text') private textInput!: HTMLSpanElement;
  @query('.energy-canvas') private canvas!: HTMLCanvasElement;

  override updated(changedProperties: Map<string, unknown>) {
    if (this.weight > 0.01 && this.frequencyData) {
      this.drawEnergyField();
    } else if (changedProperties.has('weight') && this.weight <= 0.01) {
      // Clear canvas when stopped or weight is zero
      if (this.canvas) {
        const ctx = this.canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
  }

  private drawEnergyField() {
    if (!this.isConnected || !this.canvas || !this.frequencyData) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);

    // Calculate audio features from frequency data
    const bassEnergy = this.frequencyData.slice(0, 10).reduce((s, v) => s + v, 0) / (10 * 255);
    const midEnergy = this.frequencyData.slice(40, 150).reduce((s, v) => s + v, 0) / (110 * 255);
    
    const lineCount = Math.floor(bassEnergy * 20 + this.weight * 15);
    ctx.strokeStyle = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 5 + midEnergy * 10;

    for(let i=0; i < lineCount; i++) {
        ctx.beginPath();
        const y = Math.random() * height;
        const xWobble = (Math.random() - 0.5) * midEnergy * width * 0.2;
        const x1 = (Math.random() * width * 0.2) + xWobble;
        const x2 = width - (Math.random() * width * 0.2) + xWobble;
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.lineWidth = 0.5 + Math.random() * this.weight * 1.0 + bassEnergy * 2.0;
        ctx.globalAlpha = Math.random() * this.weight * 0.4 + bassEnergy * 0.5;
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.updateText();
      (e.target as HTMLElement).blur();
    }
  }

  private dispatchPromptChange() {
    const detail: Partial<TextPrompt> = {
      text: this.text,
      weight: this.weight,
      modifiers: this.modifiers,
    }
    this.dispatchEvent(
      new CustomEvent<Partial<TextPrompt>>('prompt-changed', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private updateText() {
    const newText = this.textInput.textContent?.trim();
    if (newText === '' || newText === this.text) {
      this.textInput.textContent = this.text;
      return;
    }
    this.text = newText ?? '';
    this.dispatchPromptChange();
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private updateModifiers(e: Event) {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const key = target.dataset.key;
    const value = target.nodeName === 'INPUT' ? (target as HTMLInputElement).valueAsNumber : target.value;
    if(key) {
        this.modifiers = { ...this.modifiers, [key]: value };
        this.dispatchPromptChange();
    }
  }

  private updateKnobModifier(key: string, value: number) {
    this.modifiers = { ...this.modifiers, [key]: value };
    this.dispatchPromptChange();
  }

  private dispatchPromptRemoved() {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: this.promptId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const isActive = this.weight > 0.01;
    const promptClasses = classMap({ prompt: true, active: isActive });
    const style = styleMap({
        'border-color': this.color,
        'box-shadow': `inset 0 0 10px ${this.color}80, 0 0 10px ${this.color}80`,
        '--glow-color': this.color,
        'animation-duration': isActive ? `${60 / this.bpm}s` : 'none',
    });
    const headerStyle = styleMap({
        'border-color': this.color,
    });
     const removeButtonStyle = styleMap({
        'border-color': this.color,
    });
    const mainContentStyle = styleMap({
      'border-color': this.color,
    });
    const textStyle = styleMap({
      'color': this.color,
      'text-shadow': `0 0 5px ${this.color}`
    });
    const modifierStyles = styleMap({
      'border-color': this.color
    });

    return html`<div class=${promptClasses} style=${style}>
      <div class="header" style=${headerStyle}>
        <div class="drag-handle"></div>
        <button class="remove-button" style=${removeButtonStyle} @click=${this.dispatchPromptRemoved}>X</button>
      </div>
      <div class="main-content">
        <div class="slider-column" style=${mainContentStyle}>
            <weight-slider
            id="weight"
            value=${this.weight}
            color=${this.color}
            @input=${this.updateWeight}></weight-slider>
        </div>
        <div class="controls-column">
            <canvas class="energy-canvas"></canvas>
            <span
                id="text"
                style=${textStyle}
                spellcheck="false"
                contenteditable="plaintext-only"
                @keydown=${this.handleTextKeyDown}
                @blur=${this.updateText}
                >${this.text}</span>
            <div class="modifiers" style=${modifierStyles}>
                <div class="mod-header" @click=${() => this.modsVisible = !this.modsVisible}>
                    MODIFIERS [${this.modsVisible ? '-' : '+'}]
                </div>
                <div class=${classMap({'mod-controls': true, 'hidden': !this.modsVisible})}>
                    <div class="mod-row">
                        <label for="style-${this.promptId}">Style</label>
                        <select id="style-${this.promptId}" data-key="style" .value=${this.modifiers.style} @change=${this.updateModifiers}>
                            <option>Normal</option>
                            <option>Staccato</option>
                            <option>Legato</option>
                            <option>Pizzicato</option>
                        </select>
                    </div>
                    <div class="mod-row">
                        <label for="character-${this.promptId}">Character</label>
                        <select id="character-${this.promptId}" data-key="character" .value=${this.modifiers.character} @change=${this.updateModifiers}>
                            <option>Default</option>
                            <option>Muffled</option>
                            <option>Bright</option>
                            <option>Gritty</option>
                            <option>Atmospheric</option>
                        </select>
                    </div>
                    <div class="mod-row">
                        <label for="effect-${this.promptId}">FX</label>
                        <select id="effect-${this.promptId}" data-key="effect" .value=${this.modifiers.effect} @change=${this.updateModifiers}>
                            <option>None</option>
                            <option>Reverb</option>
                            <option>Echo</option>
                            <option>Phaser</option>
                        </select>
                    </div>
                    <div class="mod-row">
                        <label for="density-${this.promptId}">Density</label>
                        <input id="density-${this.promptId}" type="range" data-key="density" min="0" max="1" step="0.01" .value=${String(this.modifiers.density)} @input=${this.updateModifiers}>
                    </div>
                </div>
            </div>
             <div class="knob-area" style=${styleMap({'border-color': this.color})}>
                <rotary-knob 
                    .value=${this.modifiers.tone ?? 0}
                    @input=${(e: CustomEvent) => this.updateKnobModifier('tone', e.detail.value)}>
                </rotary-knob>
                <div class="knob-label">TONE</div>
            </div>
        </div>
      </div>
    </div>`;
  }
}

/** A single audio prompt input */
@customElement('audio-prompt-controller')
class AudioPromptController extends LitElement {
  static override styles = css`
    :host {
      height: 42vmin; /* Match text prompt height */
      width: 25vmin;
      position: absolute;
      user-select: none;
      --glow-color: #c0b4f8;
      font-size: 1.5vmin;
    }
    .prompt {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      overflow: hidden;
      border: 1px solid;
      background-color: rgba(13, 2, 26, 0.7);
      backdrop-filter: blur(5px);
    }
    .prompt.active {
      animation-name: pulse-glow;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
    }
    @keyframes pulse-glow {
      0%, 100% {
        box-shadow: inset 0 0 10px var(--glow-color), 0 0 10px var(--glow-color);
      }
      50% {
        box-shadow: inset 0 0 20px var(--glow-color), 0 0 20px var(--glow-color);
      }
    }
     .header {
      width: 100%;
      display: flex;
      height: 2.5vmin;
      border-bottom: 1px solid;
    }
    .drag-handle {
      flex-grow: 1;
      cursor: grab;
      background-color: rgba(108, 82, 255, 0.1);
    }
    .remove-button {
      background: #0d021a;
      color: #c0b4f8;
      border: none;
      border-left: 1px solid;
      width: 2.5vmin;
      height: 100%;
      font-size: 1.5vmin;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      opacity: 0.5;
      transition: all 0.2s;
      z-index: 10;
    }
    .remove-button:hover {
      opacity: 1;
      background: #ff00a0;
      color: #fff;
    }
    .main-content {
      display: flex;
      flex-grow: 1;
      width: 100%;
      overflow: hidden;
    }
    .slider-column {
      width: 6vmin;
      height: 100%;
      border-right: 1px solid;
    }
    weight-slider {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }
    .controls-column {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 1vmin;
      padding: 0.8vmin;
      box-sizing: border-box;
      text-align: center;
      overflow: hidden;
    }
    .file-name {
      width: 100%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 1.8vmin;
      flex-shrink: 0;
    }
    .waveform-canvas {
      width: 100%;
      flex-grow: 1;
      min-height: 8vmin;
      image-rendering: pixelated;
    }
    #text {
      color: var(--glow-color);
      text-shadow: 0 0 5px var(--glow-color);
      font-family: 'Roboto Mono', monospace;
      font-size: 1.8vmin;
      width: 100%;
      min-height: 4vmin;
      padding: 0.8vmin;
      margin: 0.5vmin 0;
      box-sizing: border-box;
      text-align: center;
      word-wrap: break-word;
      overflow-y: auto;
      border: none;
      outline: none;
      background: #0003;
      scrollbar-width: none;
      user-select: text;
      border-top: 1px solid;
      border-bottom: 1px solid;
      border-color: inherit;
    }
    #text::-webkit-scrollbar {
      display: none;
    }
    .knob-area {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1vmin;
      width: 100%;
    }
    .knob-label {
      font-size: 1.3vmin;
      text-transform: uppercase;
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) name = '';
  @property({type: Object}) waveformData: Float32Array | number[] | null = null;
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '';
  @property({type: String}) text = '';
  @property({type: Number}) variation = 0.1;
  @property({type: Object}) frequencyData: Uint8Array | null = null;
  @property({type: Number}) bpm = 120;

  @query('weight-slider') private weightInput!: WeightSlider;
  @query('.waveform-canvas') private canvas!: HTMLCanvasElement;
  @query('#text') private textInput!: HTMLSpanElement;

  override firstUpdated() {
    this.drawWaveform(); // Initial draw
  }

  override updated(changedProperties: Map<string, unknown>) {
    // Redraw if data changes
    if (changedProperties.has('waveformData') || changedProperties.has('frequencyData') || changedProperties.has('color')) {
        this.drawWaveform();
    }
  }

  drawWaveform() {
    if (!this.isConnected || !this.canvas || !this.waveformData) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);

    const isActive = this.weight > 0.01;
    // Calculate audio features for reactivity
    let bassEnergy = 0;
    if (this.frequencyData && isActive) {
        bassEnergy = this.frequencyData.slice(0, 10).reduce((s, v) => s + v, 0) / (10 * 255);
    }
    
    ctx.strokeStyle = this.color;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = isActive ? 5 + bassEnergy * 15 : 5;
    ctx.lineWidth = isActive ? 1 + this.weight * 1.0 + bassEnergy * 2.5 : 1;
    ctx.beginPath();
    
    const data = this.waveformData;
    const sliceWidth = width * 1.0 / data.length;
    let x = 0;
    for(let i = 0; i < data.length; i++) {
        const v = data[i];
        // add a subtle "breathing" effect based on bass
        const verticalPulse = height / 2 * (1 + bassEnergy * 0.2);
        const y = (v * verticalPulse) + height/2;
        if(i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        x += sliceWidth;
    }
    ctx.stroke();
  }

  private dispatchPromptChange() {
    const detail: Partial<AudioPrompt> = {
      weight: this.weight,
      text: this.text,
      variation: this.variation,
    };
    this.dispatchEvent(
      new CustomEvent<Partial<AudioPrompt>>('prompt-changed', {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.updateText();
      (e.target as HTMLElement).blur();
    }
  }

  private updateText() {
    let newText = this.textInput.textContent?.trim();
    if (newText === '') {
      newText = 'Direct Reference...';
      this.textInput.textContent = newText;
    }
    if (newText === this.text) {
      return;
    }
    this.text = newText ?? 'Direct Reference...';
    this.dispatchPromptChange();
  }

  private updateVariation(value: number) {
    this.variation = value;
    this.dispatchPromptChange();
  }

  private dispatchPromptRemoved() {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: this.promptId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const isActive = this.weight > 0.01;
    const promptClasses = classMap({ prompt: true, active: isActive });
    const style = styleMap({
      'border-color': this.color,
      'box-shadow': `inset 0 0 10px ${this.color}80, 0 0 10px ${this.color}80`,
      '--glow-color': this.color,
      'animation-duration': isActive ? `${60 / this.bpm}s` : 'none',
    });
     const headerStyle = styleMap({
        'border-color': this.color,
    });
     const removeButtonStyle = styleMap({
        'border-color': this.color,
    });
    const controlsStyle = styleMap({
      'color': this.color,
      'text-shadow': `0 0 5px ${this.color}`,
    });
    const textStyle = styleMap({
      'border-color': this.color,
    });

    return html`<div class=${promptClasses} style=${style}>
      <div class="header" style=${headerStyle}>
        <div class="drag-handle"></div>
        <button class="remove-button" style=${removeButtonStyle} @click=${this.dispatchPromptRemoved}>X</button>
      </div>
      <div class="main-content">
        <div class="slider-column" style=${styleMap({'border-color': this.color})}>
            <weight-slider
            id="weight"
            value=${this.weight}
            color=${this.color}
            @input=${this.updateWeight}></weight-slider>
        </div>
        <div class="controls-column" style=${controlsStyle}>
            <div class="file-name" title=${this.name}>${this.name}</div>
            <canvas class="waveform-canvas" width="150" height="100"></canvas>
            <span id="text"
                style=${textStyle}
                spellcheck="false"
                contenteditable="plaintext-only"
                @keydown=${this.handleTextKeyDown}
                @blur=${this.updateText}
            >${this.text}</span>
            <div class="knob-area">
                <rotary-knob 
                    .value=${this.variation}
                    .min=${0}
                    .max=${1}
                    @input=${(e: CustomEvent) => this.updateVariation(e.detail.value)}>
                </rotary-knob>
                <div class="knob-label">VARIATION</div>
            </div>
        </div>
      </div>
    </div>`;
  }
}

@customElement('fx-slider')
class FxSlider extends LitElement {
  static override styles = css`
    .fx-slider-container {
      display: contents; /* Part of the parent grid */
    }
    input[type=range] {
      -webkit-appearance: none;
      width: 100%;
      background: transparent;
      grid-column: 2 / 3;
    }
    .disabled input[type=range] {
        opacity: 0.5;
        pointer-events: none;
    }
    input[type=range]:focus {
      outline: none;
    }
    input[type=range]::-webkit-slider-runnable-track {
      width: 100%;
      height: 1px;
      cursor: pointer;
      background: #c0b4f8;
      border: 1px solid #c0b4f8;
    }
    input[type=range]::-webkit-slider-thumb {
      border: 1px solid #a094d8;
      height: 2vmin;
      width: 2vmin;
      border-radius: 50%;
      background: radial-gradient(circle at 50% 40%, #e0d9ff, #c0b4f8);
      box-shadow: 
          inset 0 1px 1px rgba(255, 255, 255, 0.5),
          0 2px 3px rgba(0,0,0,0.4),
          0 0 8px #c0b4f8;
      cursor: pointer;
      -webkit-appearance: none;
      margin-top: -1vmin;
    }
    span {
      grid-column: 3 / 4;
      font-size: 1.3vmin;
    }
  `;
  @property() label = '';
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property() unit = '';
  @property({type: Boolean}) disabled = false;

  private onInput(e: Event) {
    if (this.disabled) return;
    const target = e.target as HTMLInputElement;
    this.dispatchEvent(new CustomEvent('fx-change', {
      detail: {
        value: parseFloat(target.value),
        label: this.label
      },
      bubbles: true,
      composed: true
    }));
  }

  override render() {
    const displayValue = this.label === 'BPM' || this.label === 'Diversity' || this.label === 'Bits'
        ? this.value.toFixed(0) 
        : this.value.toFixed(2);
    return html`
      <div class=${classMap({'fx-slider-container': true, 'disabled': this.disabled})}>
        <input type="range" 
          min=${this.min} 
          max=${this.max} 
          step=${this.step} 
          .value=${String(this.value)}
          @input=${this.onInput}
          ?disabled=${this.disabled}
        />
        <span>${displayValue}${this.unit}</span>
      </div>
    `;
  }
}

/** Component for the PromptDJ UI. */
@customElement('prompt-dj')
class PromptDj extends LitElement {
  static override styles = css`
    :host {
      height: 100vh;
      width: 100vw;
      display: grid;
      grid-template-rows: 1fr auto;
      grid-template-columns: 1fr;
      position: relative;
      font-size: 1.8vmin;
      overflow: hidden;
      position: relative;
      --glitch-offset-x1: 0em;
      --glitch-offset-y1: 0em;
      --glitch-clip-y1-start: 0%;
      --glitch-clip-y1-end: 0%;
      --glitch-offset-x2: 0em;
      --glitch-offset-y2: 0em;
      --glitch-clip-y2-start: 100%;
      --glitch-clip-y2-end: 100%;
    }

    #main-title {
      position: fixed;
      top: 2vmin;
      left: 50%;
      transform: translateX(-50%);
      font-family: 'VT323', monospace;
      font-size: 6vmin;
      font-weight: 700;
      text-transform: uppercase;
      color: #39ff14; /* Neon green */
      text-shadow: 0 0 5px #39ff14, 0 0 10px #39ff14, 0 0 20px #39ff14;
      z-index: 1000;
      pointer-events: none;
      user-select: none;
    }
    .glitch {
      position: relative;
    }
    .glitch > span {
      position: absolute;
      top: 0;
      left: 0;
      opacity: 0.8;
    }
    .glitch > span:first-of-type {
      color: #ff00ff; /* Magenta */
      clip-path: polygon(
        0 var(--glitch-clip-y1-start),
        100% var(--glitch-clip-y1-start),
        100% var(--glitch-clip-y1-end),
        0 var(--glitch-clip-y1-end)
      );
      transform: translate(var(--glitch-offset-x1), var(--glitch-offset-y1));
    }
    .glitch > span:last-of-type {
      color: #00ffff; /* Cyan */
      clip-path: polygon(
        0 var(--glitch-clip-y2-start),
        100% var(--glitch-clip-y2-start),
        100% var(--glitch-clip-y2-end),
        0 var(--glitch-clip-y2-end)
      );
      transform: translate(var(--glitch-offset-x2), var(--glitch-offset-y2));
    }

    #three-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      pointer-events: none;
    }

    #node-canvas {
        grid-row: 1 / 2;
        grid-column: 1 / 2;
        position: relative;
        width: 100%;
        height: 100%;
        z-index: 10;
    }

    .dj-console {
        grid-row: 2 / 3;
        grid-column: 1 / 2;
        width: 100%;
        padding: 1vmin;
        box-sizing: border-box;
        z-index: 20;
        display: flex;
        gap: 1vmin;
        align-items: stretch;
        background: rgba(13, 2, 26, 0.7);
        border-top: 1px solid #6c52ff;
        backdrop-filter: blur(10px);
    }
    
    .console-section {
        padding: 1vmin;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 1vmin;
        border: 1px solid #6c52ff40;
    }
    .console-section.main-controls {
        flex-direction: row;
        align-items: center;
    }
    .console-section.master-visualizer {
        flex-grow: 1;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 1vmin;
    }
    #kaoss-pad {
        width: 100%;
        flex-grow: 1;
        cursor: crosshair;
        position: relative;
        background: #0d021a80;
        border: 1px solid #ff00a0;
        box-shadow: inset 0 0 10px #ff00a080;
        touch-action: none; /* for mobile */
    }
    #kaoss-canvas {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }
    #kaoss-crosshair {
        position: absolute;
        width: 3vmin;
        height: 3vmin;
        border-radius: 50%;
        background: #ff00a0;
        border: 2px solid #fff;
        box-shadow: 0 0 15px #ff00a0, 0 0 25px #ff00a0;
        transform: translate(-50%, -50%);
        pointer-events: none;
        transition: opacity 0.2s;
    }
    .kaoss-controls {
        display: flex;
        gap: 1vmin;
        padding: 0 1vmin 1vmin 1vmin;
    }
    .kaoss-controls select {
        flex-grow: 1;
        background: rgba(13, 2, 26, 0.7);
        border: 1px solid #6c52ff;
        color: #c0b4f8;
        font-family: 'Roboto Mono', monospace;
        font-size: 1.5vmin;
        padding: 0.2vmin;
        box-shadow: inset 0 0 2px #6c52ff80;
    }
    .kaoss-controls button {
        background: rgba(13, 2, 26, 0.5);
        border: 1px solid #6c52ff;
        color: #c0b4f8;
        cursor: pointer;
        text-transform: uppercase;
        user-select: none;
        transition: all 0.1s;
        padding: 0.5vmin 1vmin;
        font-size: 1.3vmin;
        font-family: 'Roboto Mono', monospace;
    }
    .kaoss-controls button.active {
        background: #ff00a0;
        color: #fff;
        box-shadow: 0 0 10px #ff00a0;
    }
    
    .panel-header {
        cursor: pointer;
        user-select: none;
        margin-bottom: 0.5vmin;
        text-transform: uppercase;
        font-weight: bold;
        color: #fff;
    }
    .controls-grid {
        display: grid;
        grid-template-columns: 10vmin 1fr 7vmin;
        align-items: center;
        gap: 1vmin;
        color: #c0b4f8;
        font-size: 1.5vmin;
    }
    .control-label {
        text-align: right;
        user-select: none;
        cursor: pointer;
        transition: color 0.2s;
    }
    .control-label:hover {
        color: #fff;
    }
    .disabled .control-label {
        color: #554a86;
        cursor: default;
    }
    .key-selector {
      background: rgba(13, 2, 26, 0.7);
      border: 1px solid #6c52ff;
      color: #c0b4f8;
      font-family: 'Roboto Mono', monospace;
      font-size: 1.5vmin;
      padding: 0.2vmin;
      width: 100%;
      grid-column: 2 / 4;
      box-shadow: inset 0 0 2px #6c52ff80;
    }
    .key-selector:focus {
        outline: none;
        box-shadow: 0 0 5px #6c52ff;
    }

    .mute-controls {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 1vmin;
        margin-top: 1vmin;
    }
    .mute-button {
        background: rgba(13, 2, 26, 0.5);
        border: 1px solid #6c52ff;
        color: #c0b4f8;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        text-transform: uppercase;
        user-select: none;
        transition: all 0.1s;
        padding: 0.5vmin;
        font-size: 1.3vmin;
        text-align: center;
        font-family: 'Roboto Mono', monospace;
    }
    .mute-button:hover {
        background: rgba(108, 82, 255, 0.3);
        color: #fff;
    }
    .mute-button.active {
        background: #ff00a0;
        color: #fff;
        box-shadow: 0 0 10px #ff00a0;
    }
    .performance-fx-pads {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(2, 1fr);
      gap: 1vmin;
      flex-grow: 1;
    }
  `;

  @property({
    type: Object,
    attribute: false,
  })
  private prompts: Map<string, Prompt>;
  private nextPromptId: number; // Monotonically increasing ID for new prompts
  private session: LiveMusicSession;
  // Fix: Add missing `sampleRate` property. The model outputs audio at 48kHz.
  private readonly sampleRate = 48000;
  // Fix: Cast window to `any` to allow for vendor-prefixed `webkitAudioContext`.
  private audioContext = new (window.AudioContext || (window as any).webkitAudioContext)(
    {sampleRate: this.sampleRate},
  );
  private outputNode: GainNode;
  private analyserNode: AnalyserNode;
  @state() private frequencyData: Uint8Array;
  @state() private timeDomainData: Uint8Array;
  
  private nextStartTime = 0;
  private readonly bufferTime = 2; // adds an audio buffer in case of netowrk latency
  @state() private playbackState: PlaybackState = 'stopped';
  @property({type: Object})
  private filteredPrompts = new Set<string>();
  private connectionError = true;

  // Drag and Drop State
  private draggedPromptId: string | null = null;
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  // Three.js background properties
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private stars: THREE.Points;
  
  // Kaoss Pad properties
  @state() private kaossXY = { x: 0.5, y: 0.5 };
  @state() private isKaossActive = false;
  @state() private isKaossHeld = false;
  @state() private activeKaossProgram = 'LPF Sweep Delay';
  @query('#kaoss-pad') private kaossPadEl!: HTMLDivElement;
  @query('#kaoss-canvas') private kaossCanvas!: HTMLCanvasElement;
  private kaossLastTap = 0; // For double-tap detection

  // Audio FX properties
  @state() private lowPassFreq = 22050;
  @state() private highPassFreq = 20;
  @state() private reverbMix = 0;
  @state() private delayTime = 0.5;
  @state() private delayFeedback = 0.3;
  @state() private delayMix = 0;
  @state() private distortionAmount = 0;
  @state() private phaserRate = 0.5;
  @state() private phaserMix = 0;
  @state() private bitDepth = 8;
  @state() private sampleRateReduction = 4;
  @state() private vinylCrackle = 0;

  @state() private isLpfOn = true;
  @state() private isHpfOn = true;
  @state() private isReverbOn = true;
  @state() private isDelayOn = true;
  @state() private isDistortionOn = true;
  @state() private isPhaserOn = true;
  @state() private isBitCrusherOn = false;
  @state() private isVinylSimOn = false;
  @state() private isFxPanelVisible = true;
  
  // Music properties
  @state() private bpm = 120;
  @state() private musicalKey = 'C Major';
  @state() private noBass = false;
  @state() private noDrums = false;
  @state() private noMelody = false;
  @state() private temperature = 0.75;
  @state() private topK = 40;
  @state() private guidanceScale = 7;

  private masterOut: GainNode;
  private lowPassFilter: BiquadFilterNode;
  private highPassFilter: BiquadFilterNode;
  
  private bitCrusherNode: ScriptProcessorNode;
  private bitCrusherBypass: GainNode;
  private bitCrusherLastSample: number[] = [0,0];

  private distortionNode: WaveShaperNode;
  private distortionBypass: GainNode;

  private phaserStages: BiquadFilterNode[];
  private phaserLFO: OscillatorNode;
  private phaserLfoGain: GainNode;
  private phaserBypass: GainNode;
  private phaserWet: GainNode;

  private reverbNode: ConvolverNode;
  private reverbBypass: GainNode;
  private reverbWet: GainNode;
  
  private delayNode: DelayNode;
  private delayFeedbackGain: GainNode;
  private delayBypass: GainNode;
  private delayWet: GainNode;

  private vinylNoiseNode: AudioBufferSourceNode;
  private vinylNoiseGain: GainNode;

  // Recording properties
  @state() private isRecording = false;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private mp3Encoder: lamejs.Mp3Encoder | null = null;
  private mp3Data: Int8Array[] = [];

  // Performance FX state
  @state() private activeFxPad: string | null = null;
  private performanceFxTimeout: number | null = null;


  @query('toast-message') private toastMessage!: ToastMessage;
  @query('#three-canvas') private threeCanvas!: HTMLCanvasElement;
  
  constructor(prompts: Map<string, Prompt>) {
    super();
    this.prompts = prompts;
    this.nextPromptId = this.prompts.size;
    
    // Create audio nodes
    this.outputNode = this.audioContext.createGain();
    this.masterOut = this.audioContext.createGain();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.frequencyData = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.timeDomainData = new Uint8Array(this.analyserNode.frequencyBinCount);

    this.lowPassFilter = this.audioContext.createBiquadFilter();
    this.lowPassFilter.type = 'lowpass';
    
    this.highPassFilter = this.audioContext.createBiquadFilter();
    this.highPassFilter.type = 'highpass';

    this.bitCrusherNode = this.audioContext.createScriptProcessor(4096, 2, 2);
    this.bitCrusherNode.onaudioprocess = this.bitCrusherProcess.bind(this);
    this.bitCrusherBypass = this.audioContext.createGain();

    this.distortionNode = this.audioContext.createWaveShaper();
    this.distortionBypass = this.audioContext.createGain();
    
    this.phaserBypass = this.audioContext.createGain();
    this.phaserWet = this.audioContext.createGain();
    this.phaserLFO = this.audioContext.createOscillator();
    this.phaserLfoGain = this.audioContext.createGain();
    this.phaserStages = [];
    const phaserStageCount = 4;
    for (let i = 0; i < phaserStageCount; i++) {
        const stage = this.audioContext.createBiquadFilter();
        stage.type = 'allpass';
        stage.frequency.value = 350 + (i * 100);
        this.phaserLFO.connect(this.phaserLfoGain);
        this.phaserLfoGain.connect(stage.detune);
        this.phaserStages.push(stage);
    }
    this.phaserLFO.type = 'sine';
    this.phaserLFO.start();

    this.delayNode = this.audioContext.createDelay(5.0);
    this.delayFeedbackGain = this.audioContext.createGain();
    this.delayBypass = this.audioContext.createGain();
    this.delayWet = this.audioContext.createGain();
    
    this.reverbNode = this.audioContext.createConvolver();
    this.reverbBypass = this.audioContext.createGain();
    this.reverbWet = this.audioContext.createGain();

    this.vinylNoiseNode = this.audioContext.createBufferSource();
    this.vinylNoiseGain = this.audioContext.createGain();
    this.vinylNoiseNode.start();

    // --- Connect Serial Audio Graph ---
    this.outputNode.connect(this.lowPassFilter);
    this.lowPassFilter.connect(this.highPassFilter);
    
    // Bit Crusher Stage
    this.highPassFilter.connect(this.bitCrusherNode);
    this.highPassFilter.connect(this.bitCrusherBypass);
    this.bitCrusherNode.connect(this.distortionNode);
    this.bitCrusherNode.connect(this.distortionBypass);
    this.bitCrusherBypass.connect(this.distortionNode);
    this.bitCrusherBypass.connect(this.distortionBypass);

    // Distortion Stage
    this.distortionNode.connect(this.phaserBypass);
    this.distortionBypass.connect(this.phaserBypass);

    // Phaser Stage
    this.distortionNode.connect(this.phaserStages[0]);
    this.distortionBypass.connect(this.phaserStages[0]);
    for (let i = 1; i < this.phaserStages.length; i++) {
        this.phaserStages[i - 1].connect(this.phaserStages[i]);
    }
    this.phaserStages[phaserStageCount - 1].connect(this.phaserWet);
    
    // Delay Stage
    this.phaserBypass.connect(this.delayBypass);
    this.phaserWet.connect(this.delayBypass);
    this.phaserBypass.connect(this.delayNode);
    this.phaserWet.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedbackGain);
    this.delayFeedbackGain.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);

    // Reverb Stage
    this.delayBypass.connect(this.reverbBypass);
    this.delayWet.connect(this.reverbBypass);
    this.delayBypass.connect(this.reverbNode);
    this.delayWet.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbWet);

    // Final Mix & Analysis
    this.reverbBypass.connect(this.analyserNode);
    this.reverbWet.connect(this.analyserNode);
    
    // Parallel FX (Vinyl Sim)
    this.vinylNoiseNode.connect(this.vinylNoiseGain);
    this.vinylNoiseGain.connect(this.analyserNode);
    
    this.analyserNode.connect(this.masterOut);
    this.masterOut.connect(this.audioContext.destination);

    this.updateFxChain();
    this.createReverbImpulseResponse();
    this.createVinylNoiseBuffer();
  }

  private bitCrusherProcess(e: AudioProcessingEvent) {
    const inputL = e.inputBuffer.getChannelData(0);
    const inputR = e.inputBuffer.getChannelData(1);
    const outputL = e.outputBuffer.getChannelData(0);
    const outputR = e.outputBuffer.getChannelData(1);
    const step = Math.pow(0.5, this.bitDepth);
    const srr = Math.round(this.sampleRateReduction);

    for (let i = 0; i < e.inputBuffer.length; i++) {
        // Sample rate reduction
        if (i % srr === 0) {
            this.bitCrusherLastSample[0] = inputL[i];
            this.bitCrusherLastSample[1] = inputR[i];
        }
        // Bit depth reduction (quantization)
        outputL[i] = step * Math.floor(this.bitCrusherLastSample[0] / step + 0.5);
        outputR[i] = step * Math.floor(this.bitCrusherLastSample[1] / step + 0.5);
    }
  }

  private makeDistortionCurve(amount: number) {
    const k = amount * 100;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
  };

  private updateFxChain() {
    const time = this.audioContext.currentTime;
    const rampTime = time + 0.02;

    this.lowPassFilter.frequency.linearRampToValueAtTime(this.isLpfOn ? this.lowPassFreq : 22050, rampTime);
    this.highPassFilter.frequency.linearRampToValueAtTime(this.isHpfOn ? this.highPassFreq : 20, rampTime);
    
    this.bitCrusherBypass.gain.linearRampToValueAtTime(this.isBitCrusherOn ? 0 : 1, rampTime);
    if (this.isBitCrusherOn) {
        this.bitCrusherNode.connect(this.distortionNode);
        this.bitCrusherNode.connect(this.distortionBypass);
    } else {
        try { this.bitCrusherNode.disconnect(); } catch(e) {}
    }

    this.distortionNode.curve = this.makeDistortionCurve(this.distortionAmount);
    this.distortionBypass.gain.linearRampToValueAtTime(this.isDistortionOn ? 0 : 1, rampTime);

    this.phaserLFO.frequency.linearRampToValueAtTime(this.phaserRate, rampTime);
    this.phaserLfoGain.gain.linearRampToValueAtTime(2000, rampTime); // depth
    this.phaserWet.gain.linearRampToValueAtTime(this.phaserMix, rampTime);
    this.phaserBypass.gain.linearRampToValueAtTime(this.isPhaserOn ? 1 - this.phaserMix : 1, rampTime);

    this.delayNode.delayTime.linearRampToValueAtTime(this.delayTime, rampTime);
    this.delayFeedbackGain.gain.linearRampToValueAtTime(this.delayFeedback, rampTime);
    this.delayWet.gain.linearRampToValueAtTime(this.delayMix, rampTime);
    this.delayBypass.gain.linearRampToValueAtTime(this.isDelayOn ? 1 - this.delayMix : 1, rampTime);

    this.reverbWet.gain.linearRampToValueAtTime(this.reverbMix, rampTime);
    this.reverbBypass.gain.linearRampToValueAtTime(this.isReverbOn ? 1 - this.reverbMix : 1, rampTime);

    this.vinylNoiseGain.gain.linearRampToValueAtTime(this.isVinylSimOn ? this.vinylCrackle : 0, rampTime);
  }

  private async createReverbImpulseResponse() {
    const sampleRate = this.audioContext.sampleRate;
    const length = sampleRate * 2; // 2 seconds reverb
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    const impulseL = impulse.getChannelData(0);
    const impulseR = impulse.getChannelData(1);

    for (let i = 0; i < length; i++) {
      const n = i / length;
      impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, 2.5);
      impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, 2.5);
    }
    this.reverbNode.buffer = impulse;
  }

  private createVinylNoiseBuffer() {
      const bufferSize = this.audioContext.sampleRate * 2; // 2 seconds of noise
      const buffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
          output[i] = Math.random() * 2 - 1;
      }
      this.vinylNoiseNode.buffer = buffer;
      this.vinylNoiseNode.loop = true;
  }

  override async firstUpdated() {
    await this.connectToSession();
    this.setMusicGenerationConfig();
    this.setSessionPrompts();
    this.initThree();
    this._animateLoop();
    this.layoutInitialPrompts();
    window.addEventListener('resize', this.handleResize.bind(this));
  }

  private layoutInitialPrompts() {
    // If prompts are already stored in localStorage, the user has likely positioned them.
    // This function will only re-layout the initial default prompts on the very first load.
    if (localStorage.getItem('prompts')) {
      return;
    }

    const newPrompts = new Map(this.prompts);
    let i = 0;
    for (const prompt of newPrompts.values()) {
        // Recalculate positions based on the now-correct window dimensions.
        prompt.x = window.innerWidth * 0.2 + (i * window.innerWidth * 0.15);
        prompt.y = window.innerHeight * 0.4;
        i++;
    }
    this.prompts = newPrompts;
    setStoredPrompts(this.prompts); // Save the corrected initial layout.
  }
  
  disconnectedCallback() {
      super.disconnectedCallback();
      window.removeEventListener('resize', this.handleResize.bind(this));
  }

  private handleResize() {
    // Background canvas
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private initThree() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.z = 50;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.threeCanvas,
      alpha: true,
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // Starfield
    const starVertices = [];
    for (let i = 0; i < 10000; i++) {
        const x = (Math.random() - 0.5) * 2000;
        const y = (Math.random() - 0.5) * 2000;
        const z = (Math.random() - 0.5) * 2000;
        starVertices.push(x, y, z);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starVertices, 3));
    const starMaterial = new THREE.PointsMaterial({ color: 0x6c52ff, size: 0.7 });
    this.stars = new THREE.Points(starGeometry, starMaterial);
    this.scene.add(this.stars);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(ambientLight);
  }

  private getAverageFrequency(data: Uint8Array, start: number, end: number): number {
      let sum = 0;
      for (let i = start; i < end; i++) {
          sum += data[i];
      }
      return (sum / (end - start)) / 255; // Normalize to 0-1
  }
  
  private drawKaossVisuals() {
    if (!this.kaossCanvas) return;
    const ctx = this.kaossCanvas.getContext('2d');
    if (!ctx) return;

    const width = this.kaossCanvas.width;
    const height = this.kaossCanvas.height;
    ctx.clearRect(0, 0, width, height);
    
    // 1. Bass Pulse (background)
    const bass = this.getAverageFrequency(this.frequencyData, 0, 10); // ~0-234 Hz
    ctx.fillStyle = `rgba(255, 0, 160, ${bass * 0.4})`;
    ctx.fillRect(0, 0, width, height);

    // 2. Reactive Grid
    const mids = this.getAverageFrequency(this.frequencyData, 40, 200); // ~930Hz - 4.7kHz
    const gridSpacing = width / 12;
    ctx.strokeStyle = `rgba(255, 0, 160, ${mids * 0.7})`;
    ctx.lineWidth = 1 + mids * 2;
    ctx.shadowColor = '#ff00a0';
    ctx.shadowBlur = 8;
    for (let x = gridSpacing; x < width; x += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
    for (let y = gridSpacing; y < height; y += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    ctx.shadowBlur = 0;
    
    // 3. Live Oscilloscope (using time domain data)
    ctx.strokeStyle = '#00f5d4'; // Teal for contrast
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#00f5d4';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    const sliceWidth = width * 1.0 / this.analyserNode.frequencyBinCount;
    let x = 0;
    for (let i = 0; i < this.analyserNode.frequencyBinCount; i++) {
        const v = this.timeDomainData[i] / 128.0; // normalize to 0-2 range
        const y = (v - 1.0) * (height * 0.45) + (height / 2); // center and scale

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        x += sliceWidth;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }


  private _animateLoop() {
    requestAnimationFrame(this._animateLoop.bind(this));

    // Update audio data arrays in place
    this.analyserNode.getByteFrequencyData(this.frequencyData);
    this.analyserNode.getByteTimeDomainData(this.timeDomainData);

    // Create new arrays from the data to trigger property updates in child components.
    // This will also trigger the parent's update cycle via the @state decorator.
    this.requestUpdate();

    const bass = this.getAverageFrequency(this.frequencyData, 0, 10);
    const mids = this.getAverageFrequency(this.frequencyData, 40, 200);
    const treble = this.getAverageFrequency(this.frequencyData, 500, 1000);

    // Animate title glitch
    const glitchIntensity = (treble * 1.5) + (bass * 0.5);
    if (Math.random() < glitchIntensity * 0.3) {
      const x1 = (Math.random() - 0.5) * glitchIntensity * 0.1;
      const y1 = (Math.random() - 0.5) * glitchIntensity * 0.1;
      const clipStart1 = Math.random() * 90;
      const clipEnd1 = clipStart1 + Math.random() * (100 - clipStart1);

      const x2 = (Math.random() - 0.5) * glitchIntensity * 0.1;
      const y2 = (Math.random() - 0.5) * glitchIntensity * 0.1;
      const clipStart2 = Math.random() * 90;
      const clipEnd2 = clipStart2 + Math.random() * (100 - clipStart2);

      this.style.setProperty('--glitch-offset-x1', `${x1}em`);
      this.style.setProperty('--glitch-offset-y1', `${y1}em`);
      this.style.setProperty('--glitch-clip-y1-start', `${clipStart1}%`);
      this.style.setProperty('--glitch-clip-y1-end', `${clipEnd1}%`);

      this.style.setProperty('--glitch-offset-x2', `${x2}em`);
      this.style.setProperty('--glitch-offset-y2', `${y2}em`);
      this.style.setProperty('--glitch-clip-y2-start', `${clipStart2}%`);
      this.style.setProperty('--glitch-clip-y2-end', `${clipEnd2}%`);
    } else {
      // Reset to a non-glitched state
      this.style.setProperty('--glitch-clip-y1-start', `0%`);
      this.style.setProperty('--glitch-clip-y1-end', `0%`);
      this.style.setProperty('--glitch-clip-y2-start', `100%`);
      this.style.setProperty('--glitch-clip-y2-end', `100%`);
    }

    // Animate background scene
    if (this.stars) {
      this.stars.rotation.y += 0.0001 + mids * 0.0015;
      // Animate star size with bass, with some decay to smooth it out
      const starMaterial = this.stars.material as THREE.PointsMaterial;
      const targetSize = 0.7 + bass * 1.8;
      starMaterial.size += (targetSize - starMaterial.size) * 0.1; // Smoothing
    }
    this.renderer.render(this.scene, this.camera);

    this.drawKaossVisuals();
  }

  private async connectToSession() {
    this.session = await ai.live.music.connect({
      model: model,
      callbacks: {
        onmessage: async (e: LiveMusicServerMessage) => {
          console.log('Received message from the server: %s\n');
          console.log(e);
          if (e.setupComplete) {
            this.connectionError = false;
          }
          if (e.filteredPrompt) {
            this.filteredPrompts = new Set([
              ...this.filteredPrompts,
              e.filteredPrompt.text,
            ]);
            this.toastMessage.show(e.filteredPrompt.filteredReason);
          }
          if (e.serverContent?.audioChunks?.[0]?.data) {
            if (
              this.playbackState === 'paused' ||
              this.playbackState === 'stopped'
            )
              return;
            const audioBuffer = await decodeAudioData(
              decode(e.serverContent.audioChunks[0].data),
              this.audioContext,
              48000,
              2,
            );
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.outputNode);
            if (this.nextStartTime === 0) {
              this.nextStartTime =
                this.audioContext.currentTime + this.bufferTime;
              setTimeout(() => {
                this.playbackState = 'playing';
              }, this.bufferTime * 1000);
            }

            if (this.nextStartTime < this.audioContext.currentTime) {
              console.log('under run');
              this.playbackState = 'loading';
              this.nextStartTime = 0;
              return;
            }
            source.start(this.nextStartTime);
            this.nextStartTime += audioBuffer.duration;
          }
        },
        onerror: (e: ErrorEvent) => {
          console.log('Error occurred: %s\n', JSON.stringify(e));
          this.connectionError = true;
          this.stopAudio();
          this.toastMessage.show('Connection error, please restart audio.');
        },
        onclose: (e: CloseEvent) => {
          console.log('Connection closed.');
          this.connectionError = true;
          this.stopAudio();
          this.toastMessage.show('Connection error, please restart audio.');
        },
      },
    });
  }
  
  private getModifierText(modifiers: TextPrompt['modifiers']): string {
    const parts: string[] = [];
    if (modifiers.style && modifiers.style !== 'Normal') parts.push(modifiers.style.toLowerCase());
    if (modifiers.character && modifiers.character !== 'Default') parts.push(modifiers.character.toLowerCase());
    if (modifiers.effect && modifiers.effect !== 'None') parts.push(`with ${modifiers.effect.toLowerCase()}`);
    
    // Use a neutral point of 0.5 for density for clearer prompting
    if (modifiers.density < 0.3) parts.push('sparse arrangement');
    else if (modifiers.density > 0.7) parts.push('dense, layered arrangement');
    
    const tone = modifiers.tone ?? 0;
    if (tone < -0.7) parts.push('very dark and muffled tone');
    else if (tone < -0.2) parts.push('dark tone');
    else if (tone > 0.7) parts.push('very bright and shimmering tone');
    else if (tone > 0.2) parts.push('bright tone');

    return parts.join(', ');
  }

  private applyModifiers(prompt: TextPrompt): string {
    const modifierText = this.getModifierText(prompt.modifiers);
    return [prompt.text, modifierText].filter(Boolean).join(', ');
  }

  private setSessionPrompts = throttle(async () => {
    let performanceFxPrompt = '';
    if(this.activeFxPad) {
        switch(this.activeFxPad) {
            case 'Filter Sweep': performanceFxPrompt = 'white noise filter sweep up'; break;
            case 'Riser': performanceFxPrompt = 'dramatic synth riser'; break;
            case 'Glitch Stutter': performanceFxPrompt = 'stuttering, glitchy, repeating rhythm'; break;
            case 'Tape Stop': performanceFxPrompt = 'dramatic tape stop effect'; break;
            case 'Vinyl Break': performanceFxPrompt = 'add a vinyl record scratch and stop'; break;
        }
    }
    
    const promptsToSend: ({ text: string; weight: number; } | { audio: string; weight: number; })[] = [];
    
    for (const p of this.prompts.values()) {
        let weight = p.weight;
        if(this.activeFxPad === 'Beat Mute' && p.type === 'text' && (p.text.toLowerCase().includes('drum') || p.text.toLowerCase().includes('kick') || p.text.toLowerCase().includes('beat'))) {
            weight = 0;
        }

        if (weight <= 0.01) continue;

        if (p.type === 'text') {
            if (this.filteredPrompts.has(p.text)) continue;
            const modifiedText = this.applyModifiers(p);
            promptsToSend.push({ text: modifiedText, weight: weight });
        } else { // type is 'audio'
            const audioPrompt = p as AudioPrompt;
            promptsToSend.push({ audio: audioPrompt.data, weight: weight });

            // Create the accompanying text prompt based on variation and text input
            let generatedText = '';
            if (audioPrompt.variation <= 0.1) {
                generatedText = 'a direct, faithful reinterpretation of the reference audio';
            } else if (audioPrompt.variation > 0.1 && audioPrompt.variation <= 0.4) {
                generatedText = 'a slightly varied reinterpretation of the reference audio';
            } else if (audioPrompt.variation > 0.4 && audioPrompt.variation <= 0.7) {
                generatedText = 'a creative variation based on the reference audio';
            } else { // > 0.7
                generatedText = 'a complex and highly creative reinterpretation inspired by the reference audio';
            }
            
            if (audioPrompt.text && audioPrompt.text.trim() !== 'Direct Reference...') {
                generatedText += `, with ${audioPrompt.text.trim()}`;
            }
        
            if (generatedText) {
                promptsToSend.push({ text: generatedText, weight: weight });
            }
        }
    }

    if(performanceFxPrompt) {
        promptsToSend.push({ text: performanceFxPrompt, weight: 2.0 });
    }
    if(this.noBass) {
        promptsToSend.push({ text: 'no bass, no bassline', weight: 2.0 });
    }
    if(this.noDrums) {
        promptsToSend.push({ text: 'no drums, no percussion, no beat', weight: 2.0 });
    }
    if(this.noMelody) {
        promptsToSend.push({ text: 'no melody, no lead instrument', weight: 2.0 });
    }

    try {
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
    } catch (e) {
      this.toastMessage.show(e.message);
      this.pauseAudio();
    }
  }, 200);

  private setMusicGenerationConfig = throttle(async () => {
    if (!this.session) return;
    const config: LiveMusicGenerationConfig = {
        bpm: this.bpm,
        musicalKey: this.musicalKey,
        // The following are experimental parameters and may not be fully supported.
        // Casting to `any` to bypass strict TypeScript checks.
        temperature: this.temperature,
        topK: this.topK,
        guidanceScale: this.guidanceScale,
    } as any;
    try {
        await this.session.setMusicGenerationConfig({ musicGenerationConfig: config });
    } catch (e) {
        this.toastMessage.show(e.message);
    }
  }, 200);

  private handlePromptChanged(e: CustomEvent<Partial<Prompt>>) {
    const controller = e.target as HTMLElement;
    const promptId = controller.getAttribute('promptId');
    if (!promptId) return;

    const prompt = this.prompts.get(promptId);
    if (!prompt) return;

    const updatedPrompt = { ...prompt, ...e.detail };
    
    const updatedPrompts = new Map(this.prompts);
    updatedPrompts.set(promptId, updatedPrompt as Prompt);
    this.prompts = updatedPrompts;
    this.setSessionPrompts();
    setStoredPrompts(this.prompts);
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (
      this.playbackState === 'paused' ||
      this.playbackState === 'stopped'
    ) {
      if (this.connectionError) {
        await this.connectToSession();
        this.setMusicGenerationConfig();
        this.setSessionPrompts();
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      this.stopAudio();
    }
  }

  private pauseAudio() {
    if (this.isRecording) this.handleRecord();
    this.session.pause();
    this.playbackState = 'paused';
    this.masterOut.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.masterOut.gain.linearRampToValueAtTime(
      0,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.lowPassFilter);
  }

  private loadAudio() {
    this.audioContext.resume();
    this.session.play();
    this.playbackState = 'loading';
    this.masterOut.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.masterOut.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
  }

  private stopAudio() {
    if (this.isRecording) this.handleRecord();
    this.session.stop();
    this.playbackState = 'stopped';
    this.masterOut.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.nextStartTime = 0;
  }
  
  private handleRecord() {
    if (this.isRecording) {
      // Stop recording
      this.isRecording = false;
      this.scriptProcessor?.disconnect();
      this.scriptProcessor = null;

      const finalBuffer = this.mp3Encoder?.flush();
      if (finalBuffer && finalBuffer.length > 0) {
        this.mp3Data.push(finalBuffer);
      }

      // Manually concatenate the Int8Array chunks into a single buffer.
      let totalLength = 0;
      this.mp3Data.forEach(chunk => {
        totalLength += chunk.length;
      });
      const concatenatedMp3 = new Int8Array(totalLength);
      let offset = 0;
      this.mp3Data.forEach(chunk => {
        concatenatedMp3.set(chunk, offset);
        offset += chunk.length;
      });

      const blob = new Blob([concatenatedMp3], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `prompt-dj-session-${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.mp3`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();

      this.mp3Data = [];
      this.mp3Encoder = null;
      this.toastMessage.show('MP3 recording saved.');
      
      // Reconnect analyser to master out
      this.analyserNode.disconnect();
      this.analyserNode.connect(this.masterOut);

    } else {
      // Start recording
      if (this.playbackState !== 'playing') {
        this.toastMessage.show('Start playback before recording.');
        return;
      }
      this.isRecording = true;
      this.mp3Encoder = new lamejs.Mp3Encoder(1, this.audioContext.sampleRate, 128);
      this.mp3Data = [];
      const bufferSize = 4096;
      this.scriptProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.scriptProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!this.isRecording || !this.mp3Encoder) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const samples = new Int16Array(inputData.length);
        for(let i = 0; i < inputData.length; i++) {
            samples[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
        }
        const mp3buf = this.mp3Encoder.encodeBuffer(samples);
        if (mp3buf.length > 0) {
            this.mp3Data.push(mp3buf);
        }
      };
      
      this.analyserNode.disconnect();
      this.analyserNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.masterOut);
      this.toastMessage.show('Recording started...');
    }
  }

  private async handleAddPrompt() {
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const offsetX = (this.prompts.size % 10) * 20 - 100;
    const offsetY = Math.floor(this.prompts.size / 10) * 20 - 100;
    const newPrompt: TextPrompt = {
      promptId: newPromptId,
      type: 'text',
      text: 'New Prompt',
      weight: 0,
      color: getUnusedRandomColor(usedColors),
      x: window.innerWidth / 2 - 100 + offsetX,
      y: window.innerHeight / 2 - 250 + offsetY,
      modifiers: { style: 'Normal', character: 'Default', effect: 'None', density: 0.5, tone: 0 },
    };
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    await this.setSessionPrompts();
    setStoredPrompts(this.prompts);

    await this.updateComplete;

    const newPromptElement = this.renderRoot.querySelector<PromptController>(
      `prompt-controller[promptId="${newPromptId}"]`,
    );
    if (newPromptElement) {
      const textSpan =
        newPromptElement.shadowRoot?.querySelector<HTMLSpanElement>('#text');
      if (textSpan) {
        textSpan.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }
  
  private async handleUploadAudio() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if(!file) return;

      this.toastMessage.show('Analyzing reference track...');

      try {
        const arrayBuffer = await file.arrayBuffer();
        const {data, waveformData} = await resampleAndEncodeAudio(arrayBuffer, this.audioContext);
        
        const newPromptId = `prompt-${this.nextPromptId++}`;
        const usedColors = [...this.prompts.values()].map((p) => p.color);
        const offsetX = (this.prompts.size % 10) * 20 - 100;
        const offsetY = Math.floor(this.prompts.size / 10) * 20 - 100;
        const newPrompt: AudioPrompt = {
            promptId: newPromptId,
            type: 'audio',
            name: file.name,
            data,
            waveformData,
            weight: 1, // Start with weight 1
            color: getUnusedRandomColor(usedColors),
            x: window.innerWidth / 2 - 100 + offsetX,
            y: window.innerHeight / 2 - 250 + offsetY,
            text: 'Direct Reference...',
            variation: 0.1,
        };
        const newPrompts = new Map(this.prompts);
        newPrompts.set(newPromptId, newPrompt);
        this.prompts = newPrompts;

        await this.setSessionPrompts();
        setStoredPrompts(this.prompts);
        this.toastMessage.show('Reference track added.');
      } catch (error) {
        console.error('Error processing audio file:', error);
        this.toastMessage.show('Error: Could not process audio file.');
      }

    };
    input.click();
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation();
    const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) {
      this.prompts.delete(promptIdToRemove);
      const newPrompts = new Map(this.prompts);
      this.prompts = newPrompts;
      this.setSessionPrompts();
      setStoredPrompts(this.prompts);
    }
  }

  private async handleReset() {
    if (this.connectionError) {
      await this.connectToSession();
      this.setMusicGenerationConfig();
      this.setSessionPrompts();
    }
    this.pauseAudio();
    this.session.resetContext();
    this.session?.setMusicGenerationConfig({
      musicGenerationConfig: {},
    });
    setTimeout(this.loadAudio.bind(this), 100);
  }

  private handlePointerDown(e: PointerEvent) {
    const path = e.composedPath();
    const originalTarget = path[0] as HTMLElement;

    const controller = path.find(
      (el) =>
        el instanceof HTMLElement &&
        (el.tagName === 'PROMPT-CONTROLLER' ||
          el.tagName === 'AUDIO-PROMPT-CONTROLLER'),
    ) as HTMLElement | undefined;
    
    // Check if the drag handle is in the shadow root of the controller
    const dragHandle = controller?.shadowRoot?.querySelector('.drag-handle');
    if (!controller || !dragHandle || !path.includes(dragHandle)) {
      return;
    }

    this.draggedPromptId = controller.getAttribute('promptId');
    if (!this.draggedPromptId) return;

    const prompt = this.prompts.get(this.draggedPromptId);
    if (!prompt) return;

    this.dragOffsetX = e.clientX - prompt.x;
    this.dragOffsetY = e.clientY - prompt.y;
    
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp, { once: true });
  }

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.draggedPromptId) return;
    
    const prompt = this.prompts.get(this.draggedPromptId);
    if (!prompt) return;

    const newX = e.clientX - this.dragOffsetX;
    const newY = e.clientY - this.dragOffsetY;
    
    const newPrompts = new Map(this.prompts);
    newPrompts.set(this.draggedPromptId, {
      ...prompt,
      x: newX,
      y: newY,
    });
    this.prompts = newPrompts;
  };
  
  private handlePointerUp = (e: PointerEvent) => {
    if (this.draggedPromptId) {
        setStoredPrompts(this.prompts);
    }
    this.draggedPromptId = null;
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', this.handlePointerMove);
  };
  
  private handleControlChange(e: CustomEvent<{ value: number, label: string }>) {
    const { value, label } = e.detail;
    let configChanged = false;
    switch (label) {
      case 'LPF': this.lowPassFreq = value; break;
      case 'HPF': this.highPassFreq = value; break;
      case 'Distort': this.distortionAmount = value; break;
      case 'Phaser Rate': this.phaserRate = value; break;
      case 'Phaser Mix': this.phaserMix = value; break;
      case 'Delay Time': this.delayTime = value; break;
      case 'Delay Fbk': this.delayFeedback = value; break;
      case 'Delay Mix': this.delayMix = value; break;
      case 'Reverb': this.reverbMix = value; break;
      case 'Bits': this.bitDepth = value; break;
      case 'Rate': this.sampleRateReduction = value; break;
      case 'Crackle': this.vinylCrackle = value; break;
      case 'BPM': 
        this.bpm = value;
        configChanged = true;
        break;
      case 'Temp':
        this.temperature = value;
        configChanged = true;
        break;
      case 'Diversity':
        this.topK = value;
        configChanged = true;
        break;
      case 'Guidance':
        this.guidanceScale = value;
        configChanged = true;
        break;
    }
    if (configChanged) {
        this.setMusicGenerationConfig();
    } else {
        this.updateFxChain();
    }
  }

  private handleFxToggle(effect: string) {
      switch(effect) {
          case 'LPF': this.isLpfOn = !this.isLpfOn; break;
          case 'HPF': this.isHpfOn = !this.isHpfOn; break;
          case 'Distortion': this.isDistortionOn = !this.isDistortionOn; break;
          case 'Phaser': this.isPhaserOn = !this.isPhaserOn; break;
          case 'Delay': this.isDelayOn = !this.isDelayOn; break;
          case 'Reverb': this.isReverbOn = !this.isReverbOn; break;
          case 'Bit Crush': this.isBitCrusherOn = !this.isBitCrusherOn; break;
          case 'Vinyl Sim': this.isVinylSimOn = !this.isVinylSimOn; break;
      }
      this.requestUpdate();
      this.updateFxChain();
  }

  private handleKeyChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    this.musicalKey = target.value;
    this.setMusicGenerationConfig();
  }

  private toggleMute(element: 'bass' | 'drums' | 'melody') {
    switch(element) {
        case 'bass': this.noBass = !this.noBass; break;
        case 'drums': this.noDrums = !this.noDrums; break;
        case 'melody': this.noMelody = !this.noMelody; break;
    }
    this.setSessionPrompts();
  }
  
  private handleFxPad(fxName: string) {
    if (this.performanceFxTimeout) {
        clearTimeout(this.performanceFxTimeout);
        this.performanceFxTimeout = null;
    }
    
    if (this.activeFxPad === fxName) {
        // Deactivate
        this.activeFxPad = null;
    } else {
        // Activate
        this.activeFxPad = fxName;
        // Auto-deactivate after a short time
        this.performanceFxTimeout = window.setTimeout(() => {
            this.activeFxPad = null;
            this.setSessionPrompts();
        }, 2000); // Effect lasts for 2 seconds
    }
    this.setSessionPrompts();
  }
  
  private handleKaossPointerDown(e: PointerEvent) {
    this.isKaossActive = true;
    
    const now = Date.now();
    if (now - this.kaossLastTap < 300) { // Double tap
        this.isKaossHeld = !this.isKaossHeld;
    }
    this.kaossLastTap = now;

    // Instantly apply current FX state, overriding any ramps
    const time = this.audioContext.currentTime;
    this.reverbWet.gain.cancelScheduledValues(time);
    this.delayWet.gain.cancelScheduledValues(time);
    this.updateFxChain(); // This will apply state values immediately

    window.addEventListener('pointermove', this.handleKaossPointerMove);
    window.addEventListener('pointerup', this.handleKaossPointerUp);
    this.updateKaossPosition(e);
  }

  private handleKaossPointerMove = (e: PointerEvent) => {
    if (!this.isKaossActive) return;
    this.updateKaossPosition(e);
  }

  private handleKaossPointerUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', this.handleKaossPointerMove);
    window.removeEventListener('pointerup', this.handleKaossPointerUp);
    if (this.isKaossHeld) return;

    this.isKaossActive = false;
    
    // Ramp down the wet signals for a tail
    const time = this.audioContext.currentTime;
    const releaseTime = 0.25; // 250ms
    this.reverbWet.gain.cancelScheduledValues(time);
    this.reverbWet.gain.linearRampToValueAtTime(0, time + releaseTime);
    this.delayWet.gain.cancelScheduledValues(time);
    this.delayWet.gain.linearRampToValueAtTime(0, time + releaseTime);

    // After the tail, reset state to neutral so sliders are accurate
    setTimeout(() => {
        if (this.isKaossActive) return; // a new touch started
        this.resetFxToNeutral();
    }, releaseTime * 1000);
  }
  
  private updateKaossPosition(e: PointerEvent) {
      if (!this.kaossPadEl) return;
      const bounds = this.kaossPadEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width));
      const y = Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height));
      this.kaossXY = { x, y };
      this.updateKaossFx();
  }
  
  private updateKaossFx() {
    const { x, y } = this.kaossXY;
    // Invert Y because screen coordinates have Y=0 at the top
    const invertedY = 1 - y;

    switch(this.activeKaossProgram) {
        case 'LPF Sweep Delay':
            // X: cutoff 100 Hz–18 kHz (log curve)
            this.lowPassFreq = 100 * Math.pow(18000/100, x);
            // Y: delay feedback 0–0.85, wet 0.2–0.9
            this.delayFeedback = invertedY * 0.85;
            this.delayMix = 0.2 + (invertedY * 0.7);
            
            this.isLpfOn = true;
            this.isDelayOn = true;
            this.isHpfOn = false;
            this.isReverbOn = false;
            this.reverbMix = 0; // Ensure other FX are off
            break;
        case 'HPF + Reverb Wash':
            // X: HPF 60 Hz–2 kHz
            this.highPassFreq = 60 * Math.pow(2000/60, x);
            // Y: wet 0.15–0.8
            this.reverbMix = 0.15 + (invertedY * 0.65);

            this.isHpfOn = true;
            this.isReverbOn = true;
            this.isLpfOn = false;
            this.isDelayOn = false;
            this.delayMix = 0; // Ensure other FX are off
            break;
    }
    this.updateFxChain();
  }
  
  private resetFxToNeutral() {
    this.reverbMix = 0;
    this.delayMix = 0;
    this.lowPassFreq = 22050;
    this.highPassFreq = 20;
    this.updateFxChain();
  }
  
  private handleKaossProgramChange(e: Event) {
    this.activeKaossProgram = (e.target as HTMLSelectElement).value;
    if (this.isKaossActive) {
        this.updateKaossFx();
    }
  }


  override render() {
    return html`
        <h1 id="main-title" class="glitch">
          <span aria-hidden="true">REJECT REACTOR</span>
          REJECT REACTOR
          <span aria-hidden="true">REJECT REACTOR</span>
        </h1>
        <canvas id="three-canvas"></canvas>
        <main id="node-canvas" 
             @prompt-changed=${this.handlePromptChanged}
             @prompt-removed=${this.handlePromptRemoved}
             @pointerdown=${this.handlePointerDown}>
            ${this.renderPrompts()}
        </main>

        <div class="dj-console">
            <div class="console-section main-controls">
                <play-pause-button
                @click=${this.handlePlayPause}
                .playbackState=${this.playbackState}></play-pause-button>
                <record-button 
                @click=${this.handleRecord}
                .isRecording=${this.isRecording}></record-button>
                <reset-button @click=${this.handleReset}></reset-button>
            </div>
            <div class="console-section prompt-controls">
                 <div class="panel-header">PROMPTS</div>
                <add-prompt-button @click=${this.handleAddPrompt}></add-prompt-button>
                <upload-audio-button @click=${this.handleUploadAudio}></upload-audio-button>
            </div>
             <div class="console-section master-visualizer">
                <div id="kaoss-pad" 
                    @pointerdown=${this.handleKaossPointerDown}>
                    <canvas id="kaoss-canvas" width="300" height="200"></canvas>
                    <div id="kaoss-crosshair" style=${styleMap({
                        left: `${this.kaossXY.x * 100}%`,
                        top: `${this.kaossXY.y * 100}%`,
                        opacity: this.isKaossActive ? 1 : 0
                    })}></div>
                </div>
                <div class="kaoss-controls">
                    <select @change=${this.handleKaossProgramChange} .value=${this.activeKaossProgram}>
                        <option>LPF Sweep Delay</option>
                        <option>HPF + Reverb Wash</option>
                    </select>
                    <button class=${classMap({active: this.isKaossHeld})} @click=${() => this.isKaossHeld = !this.isKaossHeld}>HOLD</button>
                </div>
            </div>
             <div id="music-controls-panel" class="console-section">
                <div class="panel-header">MUSIC CONTROLS</div>
                <div class="controls-grid" @fx-change=${this.handleControlChange}>
                    <div class="control-label">BPM</div>
                    <fx-slider label="BPM" min="60" max="180" step="1" .value=${this.bpm} unit=""></fx-slider>
                    
                    <div class="control-label">KEY</div>
                    <select class="key-selector" @change=${this.handleKeyChange} .value=${this.musicalKey}>
                        ${ALL_KEYS.map(key => html`<option value=${key}>${key}</option>`)}
                    </select>

                    <div class="control-label" title="Controls randomness. Higher values are more creative.">TEMP</div>
                    <fx-slider label="Temp" min="0" max="1" step="0.01" .value=${this.temperature}></fx-slider>
                    
                    <div class="control-label" title="Controls variety. Higher values are more diverse.">DIVERSITY</div>
                    <fx-slider label="Diversity" min="1" max="50" step="1" .value=${this.topK}></fx-slider>
                    
                    <div class="control-label" title="How strongly the model follows the prompts.">GUIDANCE</div>
                    <fx-slider label="Guidance" min="1" max="20" step="0.5" .value=${this.guidanceScale}></fx-slider>
                </div>
                <div class="mute-controls">
                  <button class=${classMap({'mute-button': true, 'active': this.noBass})} @click=${() => this.toggleMute('bass')}>NO BASS</button>
                  <button class=${classMap({'mute-button': true, 'active': this.noDrums})} @click=${() => this.toggleMute('drums')}>NO DRUMS</button>
                  <button class=${classMap({'mute-button': true, 'active': this.noMelody})} @click=${() => this.toggleMute('melody')}>NO MELODY</button>
                </div>
            </div>
            <div id="fx-panel" class="console-section">
                <div class="panel-header" @click=${() => this.isFxPanelVisible = !this.isFxPanelVisible}>
                    MASTER FX [${this.isFxPanelVisible ? '-' : '+'}]
                </div>
                ${this.isFxPanelVisible ? html`
                    <div class="controls-grid" @fx-change=${this.handleControlChange}>
                        <div class="control-label" @click=${() => this.handleFxToggle('LPF')}>LPF [${this.isLpfOn ? 'ON' : 'OFF'}]</div>
                        <fx-slider label="LPF" min="20" max="22050" step="1" .value=${this.lowPassFreq} unit="Hz" ?disabled=${!this.isLpfOn}></fx-slider>
                        
                        <div class="control-label" @click=${() => this.handleFxToggle('HPF')}>HPF [${this.isHpfOn ? 'ON' : 'OFF'}]</div>
                        <fx-slider label="HPF" min="20" max="22050" step="1" .value=${this.highPassFreq} unit="Hz" ?disabled=${!this.isHpfOn}></fx-slider>
                        
                        <div class="control-label" @click=${() => this.handleFxToggle('Bit Crush')}>BIT CRUSH</div>
                        <fx-slider label="Bits" min="1" max="16" step="1" .value=${this.bitDepth} ?disabled=${!this.isBitCrusherOn}></fx-slider>
                        
                        <div class="control-label" @click=${() => this.handleFxToggle('Bit Crush')}></div>
                        <fx-slider label="Rate" min="1" max="40" step="1" .value=${this.sampleRateReduction} ?disabled=${!this.isBitCrusherOn}></fx-slider>

                        <div class="control-label" @click=${() => this.handleFxToggle('Distortion')}>DISTORT</div>
                        <fx-slider label="Distort" min="0" max="1" step="0.01" .value=${this.distortionAmount} ?disabled=${!this.isDistortionOn}></fx-slider>

                        <div class="control-label" @click=${() => this.handleFxToggle('Phaser')}>PHASER</div>
                        <fx-slider label="Phaser Mix" min="0" max="1" step="0.01" .value=${this.phaserMix} ?disabled=${!this.isPhaserOn}></fx-slider>

                        <div class="control-label" @click=${() => this.handleFxToggle('Delay')}>DELAY</div>
                        <fx-slider label="Delay Mix" min="0" max="1" step="0.01" .value=${this.delayMix} ?disabled=${!this.isDelayOn}></fx-slider>
                        
                        <div class="control-label" @click=${() => this.handleFxToggle('Reverb')}>REVERB</div>
                        <fx-slider label="Reverb" min="0" max="1" step="0.01" .value=${this.reverbMix} ?disabled=${!this.isReverbOn}></fx-slider>

                        <div class="control-label" @click=${() => this.handleFxToggle('Vinyl Sim')}>VINYL SIM</div>
                        <fx-slider label="Crackle" min="0" max="0.2" step="0.001" .value=${this.vinylCrackle} ?disabled=${!this.isVinylSimOn}></fx-slider>
                    </div>
                ` : ''}
            </div>
            <div class="console-section performance-fx">
                <div class="panel-header">PERFORMANCE FX</div>
                <div class="performance-fx-pads">
                    <button class=${classMap({'fx-pad': true, 'active': this.activeFxPad === 'Filter Sweep'})} @click=${() => this.handleFxPad('Filter Sweep')}>Filter Sweep</button>
                    <button class=${classMap({'fx-pad': true, 'active': this.activeFxPad === 'Riser'})} @click=${() => this.handleFxPad('Riser')}>Riser</button>
                    <button class=${classMap({'fx-pad': true, 'active': this.activeFxPad === 'Beat Mute'})} @click=${() => this.handleFxPad('Beat Mute')}>Beat Mute</button>
                    <button class=${classMap({'fx-pad': true, 'active': this.activeFxPad === 'Glitch Stutter'})} @click=${() => this.handleFxPad('Glitch Stutter')}>Glitch Stutter</button>
                    <button class=${classMap({'fx-pad': true, 'active': this.activeFxPad === 'Tape Stop'})} @click=${() => this.handleFxPad('Tape Stop')}>Tape Stop</button>
                    <button class=${classMap({'fx-pad': true, 'active': this.activeFxPad === 'Vinyl Break'})} @click=${() => this.handleFxPad('Vinyl Break')}>Vinyl Break</button>
                </div>
            </div>
        </div>
      <toast-message></toast-message>
    `;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      const style = styleMap({
        transform: `translate(${prompt.x}px, ${prompt.y}px)`,
      });
      if (prompt.type === 'text') {
        return html`<prompt-controller style=${style}
          .promptId=${prompt.promptId}
          filtered=${this.filteredPrompts.has(prompt.text)}
          .text=${prompt.text}
          .weight=${prompt.weight}
          .color=${prompt.color}
          .modifiers=${prompt.modifiers}
          .frequencyData=${this.frequencyData}
          .bpm=${this.bpm}>
        </prompt-controller>`;
      } else { // audio prompt
        return html`<audio-prompt-controller style=${style}
          .promptId=${prompt.promptId}
          .name=${prompt.name}
          .waveformData=${prompt.waveformData}
          .weight=${prompt.weight}
          .color=${prompt.color}
          .text=${(prompt as AudioPrompt).text}
          .variation=${(prompt as AudioPrompt).variation}
          .frequencyData=${this.frequencyData}
          .bpm=${this.bpm}>
        </audio-prompt-controller>`;
      }
    });
  }
}

function gen(parent: HTMLElement) {
  const initialPrompts = getStoredPrompts();

  const pdj = new PromptDj(initialPrompts);
  parent.appendChild(pdj);
}

function getStoredPrompts(): Map<string, Prompt> {
  const {localStorage} = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      // Use `any` to handle legacy prompt structures flexibly.
      const parsedPrompts = JSON.parse(storedPrompts) as any[];
      const prompts = parsedPrompts.map((p) => {
        if (p.type === 'text') {
          const defaultModifiers = { style: 'Normal', character: 'Default', effect: 'None', density: 0.5, tone: 0 };
          // Backwards compatibility for text prompts saved before modifiers.
          p.modifiers = { ...defaultModifiers, ...(p.modifiers || {}) };
        } else if (p.type === 'audio') {
          // Audio prompts no longer use modifiers. Remove them if they exist
          // from older versions stored in localStorage.
          delete p.modifiers;
          
          // Add new fields with defaults if they don't exist
          p.text = p.text || 'Direct Reference...';
          p.variation = p.variation ?? 0.1;

          // Re-hydrate waveform data if it's a plain array.
          if (p.waveformData && !(p.waveformData instanceof Float32Array)) {
            p.waveformData = new Float32Array(p.waveformData as number[]);
          }
        }
        return p as Prompt;
      });
      return new Map(prompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts', e);
    }
  }
  
  const defaultTextModifiers = { style: 'Normal', character: 'Default', effect: 'None', density: 0.5, tone: 0 };
  const numDefaultPrompts = Math.min(4, PROMPT_TEXT_PRESETS.length);
  const shuffledPresetTexts = [...PROMPT_TEXT_PRESETS].sort(
    () => Math.random() - 0.5,
  );
  const defaultPrompts: TextPrompt[] = [];
  const usedColors: string[] = [];
  for (let i = 0; i < numDefaultPrompts; i++) {
    const text = shuffledPresetTexts[i];
    const color = getUnusedRandomColor(usedColors);
    usedColors.push(color);
    defaultPrompts.push({
      promptId: `prompt-${i}`,
      type: 'text',
      text,
      weight: 0,
      color,
      x: window.innerWidth * 0.2 + (i * window.innerWidth * 0.15),
      y: window.innerHeight * 0.4,
      modifiers: { ...defaultTextModifiers },
    });
  }
  const promptsToActivate = [...defaultPrompts].sort(() => Math.random() - 0.5);
  const numToActivate = Math.min(2, defaultPrompts.length);
  for (let i = 0; i < numToActivate; i++) {
    if (promptsToActivate[i]) {
      promptsToActivate[i].weight = 1;
    }
  }
  return new Map(defaultPrompts.map((p) => [p.promptId, p]));
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  const promptsToStore = [...prompts.values()].map(p => {
    if (p.type === 'audio' && p.waveformData instanceof Float32Array) {
      return { ...p, waveformData: Array.from(p.waveformData) };
    }
    return p;
  });
  const storedPrompts = JSON.stringify(promptsToStore);
  const {localStorage} = window;
  localStorage.setItem('prompts', storedPrompts);
}

function main(container: HTMLElement) {
  gen(container);
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'prompt-controller': PromptController;
    'audio-prompt-controller': AudioPromptController;
    'add-prompt-button': AddPromptButton;
    'upload-audio-button': UploadAudioButton,
    'play-pause-button': PlayPauseButton;
    'record-button': RecordButton;
    'reset-button': ResetButton;
    'weight-slider': WeightSlider;
    'toast-message': ToastMessage;
    'fx-slider': FxSlider;
    'rotary-knob': RotaryKnob;
  }
}
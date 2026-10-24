import { useEffect, useRef } from "react";

const BAR_STEP_MS = 200;
const RING_CAPACITY = 160;
const BAR_WIDTH_PX = 3;
const BAR_GAP_PX = 3;
const MIN_BAR_HEIGHT_PX = 3;
const EDGE_PADDING_PX = 4;
const DOT_LEVEL = 0.04;
const DOT_RADIUS_PX = 1.2;
const VOICE_HOLD_MS = 250;
const SPEECH_FLOOR_HZ = 100;
const SPEECH_CEILING_HZ = 4000;
const GATE_RATIO = 5;
const GATE_FLOOR = 0.01;

interface VoiceWaveformProps {
  analyser: AnalyserNode | null;
}

/**
 * Scrolling dictation waveform. The whole bar row slides continuously every
 * frame; a new bar enters on the left (stop button side) once per BAR_STEP_MS.
 * Bars grow only while speech-band energy clears an adaptive noise gate, and a
 * short hold keeps the gate open between syllables. Both edges fade out through
 * a gradient mask. Drawing runs in a requestAnimationFrame loop so the Composer
 * never re-renders per frame.
 */
export function VoiceWaveform({ analyser }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !analyser) return;

    let frame = 0;
    let lastFrameAt = 0;
    let offset = 0;
    let cssWidth = 0;
    let cssHeight = 0;
    let barColor = "#171717";
    let noiseFloor = 0.5;
    let voiceUntil = 0;
    let currentLevel = 0;
    let edgeMask: CanvasGradient | null = null;
    const step = BAR_WIDTH_PX + BAR_GAP_PX;
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const levels = new Float32Array(RING_CAPACITY);
    const sampleRate = analyser.context.sampleRate;
    const firstBin = Math.floor(SPEECH_FLOOR_HZ / (sampleRate / 2) * frequencyData.length);
    const lastBin = Math.floor(SPEECH_CEILING_HZ / (sampleRate / 2) * frequencyData.length);

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      cssWidth = Math.max(1, rect.width);
      cssHeight = Math.max(1, rect.height);
      canvas.width = Math.max(1, Math.round(cssWidth * scale));
      canvas.height = Math.max(1, Math.round(cssHeight * scale));
      context.setTransform(scale, 0, 0, scale, 0, 0);
      barColor = getComputedStyle(document.documentElement)
        .getPropertyValue("--text").trim() || barColor;
      const fadeWidth = Math.min(cssWidth * 0.1, 64);
      edgeMask = context.createLinearGradient(0, 0, cssWidth, 0);
      edgeMask.addColorStop(0, "rgba(0,0,0,0)");
      edgeMask.addColorStop(fadeWidth / cssWidth, "rgba(0,0,0,1)");
      edgeMask.addColorStop(1 - fadeWidth / cssWidth, "rgba(0,0,0,1)");
      edgeMask.addColorStop(1, "rgba(0,0,0,0)");
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number): void => {
      frame = requestAnimationFrame(draw);
      const elapsed = lastFrameAt === 0 ? BAR_STEP_MS : Math.min(100, now - lastFrameAt);
      lastFrameAt = now;

      // Continuous sub-frame scroll; a slot shift only marks a new bar entering.
      offset += (elapsed / BAR_STEP_MS) * step;
      while (offset >= step) {
        offset -= step;
        for (let index = RING_CAPACITY - 1; index > 0; index -= 1) {
          levels[index] = levels[index - 1];
        }
      }

      analyser.getByteFrequencyData(frequencyData);
      let energySum = 0;
      let speechPeak = 0;
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        energySum += frequencyData[bin];
        if (frequencyData[bin] > speechPeak) speechPeak = frequencyData[bin];
      }
      const energy = energySum / (lastBin - firstBin) / 255;
      noiseFloor = Math.min(noiseFloor, energy);
      noiseFloor += (energy - noiseFloor) * 0.0006;
      const detected = energy > Math.max(noiseFloor * GATE_RATIO, GATE_FLOOR);
      if (detected) voiceUntil = now + VOICE_HOLD_MS;
      const voice = detected || now < voiceUntil;

      // Instant attack, soft release; the entering bar updates live every frame.
      const target = voice ? Math.min(1, speechPeak / 255) : 0;
      currentLevel = target >= currentLevel ? target : currentLevel * 0.82 + target * 0.18;
      levels[0] = currentLevel;

      context.clearRect(0, 0, cssWidth, cssHeight);
      const count = Math.max(8, Math.min(RING_CAPACITY, Math.floor(cssWidth / step)));
      const center = cssHeight / 2;
      const maxBarHeight = Math.max(MIN_BAR_HEIGHT_PX, cssHeight - EDGE_PADDING_PX * 2);
      context.fillStyle = barColor;
      context.globalAlpha = 1;
      for (let index = 0; index <= count; index += 1) {
        const magnitude = levels[index];
        const x = offset + (index - 1) * step;
        if (magnitude < DOT_LEVEL) {
          context.beginPath();
          context.arc(x + BAR_WIDTH_PX / 2, center, DOT_RADIUS_PX, 0, Math.PI * 2);
          context.fill();
          continue;
        }
        const height = Math.max(MIN_BAR_HEIGHT_PX, magnitude * maxBarHeight);
        const top = center - height / 2;
        const radius = Math.min(BAR_WIDTH_PX / 2, height / 2);
        context.beginPath();
        context.moveTo(x, top + radius);
        context.arcTo(x, top, x + BAR_WIDTH_PX, top, radius);
        context.arcTo(x + BAR_WIDTH_PX, top, x + BAR_WIDTH_PX, top + height, radius);
        context.arcTo(x + BAR_WIDTH_PX, top + height, x, top + height, radius);
        context.arcTo(x, top + height, x, top, radius);
        context.closePath();
        context.fill();
      }

      if (edgeMask) {
        context.globalCompositeOperation = "destination-in";
        context.fillStyle = edgeMask;
        context.fillRect(0, 0, cssWidth, cssHeight);
        context.globalCompositeOperation = "source-over";
      }
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [analyser]);

  return <canvas ref={canvasRef} />;
}

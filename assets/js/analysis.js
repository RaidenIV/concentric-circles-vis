/**
 * analysis.js — offline FFT analysis of the decoded AudioBuffer.
 *
 * The original build read a realtime AnalyserNode, which can only be sampled
 * at wall-clock speed. Video export has to evaluate the visualizer at
 * arbitrary timestamps, so the whole track is analyzed up front into a
 * per-frame magnitude timeline that both the preview loop and the export loop
 * sample by playhead time. The band split, the dB mapping and the 0.8
 * smoothing constant reproduce AnalyserNode.getByteFrequencyData().
 */
import { FREQ_BANDS, LOW_FREQ_BAND, engine } from "./config.js";
import { state } from "./core.js";
import { clamp, nextEventLoopTurn } from "./utils.js";

const MIN_DECIBELS = -100;
const MAX_DECIBELS = -30;
const MAX_ANALYSIS_FRAMES = 24000;

function createFftWorkspace(size) {
  const levels = Math.log2(size);
  if (!Number.isInteger(levels)) {
    throw new Error("FFT size must be a power of two.");
  }

  const real = new Float32Array(size);
  const imaginary = new Float32Array(size);
  const bitReversedIndices = new Uint32Array(size);
  const windowValues = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    let value = index;
    let reversed = 0;
    for (let bit = 0; bit < levels; bit += 1) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    bitReversedIndices[index] = reversed;
    // Blackman window, matching the Web Audio AnalyserNode.
    windowValues[index] =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * index) / (size - 1)) +
      0.08 * Math.cos((4 * Math.PI * index) / (size - 1));
  }

  const stages = [];
  for (let blockSize = 2; blockSize <= size; blockSize *= 2) {
    const halfBlock = blockSize / 2;
    const phaseStep = (-2 * Math.PI) / blockSize;
    const cosine = new Float32Array(halfBlock);
    const sine = new Float32Array(halfBlock);
    for (let offset = 0; offset < halfBlock; offset += 1) {
      const angle = phaseStep * offset;
      cosine[offset] = Math.cos(angle);
      sine[offset] = Math.sin(angle);
    }
    stages.push({ blockSize, halfBlock, cosine, sine });
  }

  return { size, real, imaginary, bitReversedIndices, windowValues, stages };
}

function fillFftInput(workspace, channels, channelScale, frameStart) {
  const { size, real, imaginary, bitReversedIndices, windowValues } = workspace;
  const sampleCount = channels[0].length;

  for (let offset = 0; offset < size; offset += 1) {
    const sourceIndex = frameStart + offset;
    let sample = 0;
    if (sourceIndex >= 0 && sourceIndex < sampleCount) {
      for (let channel = 0; channel < channels.length; channel += 1) {
        sample += channels[channel][sourceIndex] * channelScale;
      }
    }
    const destination = bitReversedIndices[offset];
    real[destination] = sample * windowValues[offset];
    imaginary[destination] = 0;
  }
}

function runFft(workspace) {
  const { size, real, imaginary, stages } = workspace;

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const { blockSize, halfBlock, cosine, sine } = stages[stageIndex];
    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      for (let offset = 0; offset < halfBlock; offset += 1) {
        const evenIndex = blockStart + offset;
        const oddIndex = evenIndex + halfBlock;
        const oddReal =
          real[oddIndex] * cosine[offset] - imaginary[oddIndex] * sine[offset];
        const oddImaginary =
          real[oddIndex] * sine[offset] + imaginary[oddIndex] * cosine[offset];
        const evenReal = real[evenIndex];
        const evenImaginary = imaginary[evenIndex];

        real[oddIndex] = evenReal - oddReal;
        imaginary[oddIndex] = evenImaginary - oddImaginary;
        real[evenIndex] = evenReal + oddReal;
        imaginary[evenIndex] = evenImaginary + oddImaginary;
      }
    }
  }
}

function bandBinRange(minimumHz, maximumHz, sampleRate, binCount) {
  const nyquist = sampleRate / 2;
  const minimumBin = Math.floor((minimumHz / nyquist) * binCount);
  const maximumBin = Math.floor((maximumHz / nyquist) * binCount);
  return {
    minimumBin: clamp(minimumBin, 0, binCount - 1),
    maximumBin: clamp(Math.max(maximumBin, minimumBin + 1), 1, binCount)
  };
}

/**
 * Analyze the decoded buffer into a per-frame magnitude timeline.
 * Returns a deterministic per-frame analysis timeline including frequency
 * bands, low-frequency energy, spectral flux, spectral centroid and the
 * references required by amplitude-normalization modes.
 */
export async function analyzeAudioBuffer(
  audioBuffer,
  fftSize,
  smoothing,
  onProgress = () => {}
) {
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;

  let fps = engine.ANALYSIS_FPS;
  let frameCount = Math.max(1, Math.ceil(duration * fps));
  if (frameCount > MAX_ANALYSIS_FRAMES) {
    fps = MAX_ANALYSIS_FRAMES / duration;
    frameCount = MAX_ANALYSIS_FRAMES;
  }

  const workspace = createFftWorkspace(fftSize);
  const binCount = fftSize / 2;
  const channels = [];
  for (let index = 0; index < audioBuffer.numberOfChannels; index += 1) {
    channels.push(audioBuffer.getChannelData(index));
  }
  const channelScale = 1 / Math.max(1, channels.length);

  const bands = FREQ_BANDS.map(() => new Float32Array(frameCount));
  const low = new Float32Array(frameCount);
  const flux = new Float32Array(frameCount);
  const centroid = new Float32Array(frameCount);
  const overall = new Float32Array(frameCount);
  const adaptivePeak = new Float32Array(frameCount);

  const bandRanges = FREQ_BANDS.map((band) =>
    bandBinRange(band.min, band.max, sampleRate, binCount)
  );
  const lowRange = bandBinRange(
    LOW_FREQ_BAND.min,
    LOW_FREQ_BAND.max,
    sampleRate,
    binCount
  );

  const smoothed = new Float32Array(binCount);
  const normalized = new Float32Array(binCount);
  const previousNormalized = new Float32Array(binCount);
  const decibelRange = MAX_DECIBELS - MIN_DECIBELS;
  const smoothingFactor = clamp(smoothing, 0, 0.95);
  const hop = sampleRate / fps;

  let lastYield = performance.now();

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameStart = Math.round(frameIndex * hop) - Math.floor(fftSize / 2);
    fillFftInput(workspace, channels, channelScale, frameStart);
    runFft(workspace);

    const { real, imaginary } = workspace;
    let fluxSum = 0;
    let centroidWeighted = 0;
    let centroidMagnitude = 0;

    for (let bin = 0; bin < binCount; bin += 1) {
      const magnitude =
        Math.sqrt(real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) /
        fftSize;
      smoothed[bin] =
        smoothingFactor * smoothed[bin] + (1 - smoothingFactor) * magnitude;

      const decibels = 20 * Math.log10(Math.max(smoothed[bin], 1e-12));
      const byteValue = clamp(
        ((decibels - MIN_DECIBELS) / decibelRange) * 255,
        0,
        255
      );
      normalized[bin] = byteValue / 255;

      const difference = normalized[bin] - previousNormalized[bin];
      if (difference > 0) fluxSum += difference;
      previousNormalized[bin] = normalized[bin];

      const frequencyHz = (bin * sampleRate) / fftSize;
      if (frequencyHz >= 20 && frequencyHz <= Math.min(20000, sampleRate / 2)) {
        centroidWeighted += frequencyHz * normalized[bin];
        centroidMagnitude += normalized[bin];
      }
    }

    flux[frameIndex] = fluxSum / binCount;

    let bandTotal = 0;
    for (let bandIndex = 0; bandIndex < bandRanges.length; bandIndex += 1) {
      const { minimumBin, maximumBin } = bandRanges[bandIndex];
      let sum = 0;
      for (let bin = minimumBin; bin < maximumBin; bin += 1) {
        sum += normalized[bin];
      }
      const bandValue = sum / (maximumBin - minimumBin);
      bands[bandIndex][frameIndex] = bandValue;
      bandTotal += bandValue;
    }
    overall[frameIndex] = bandTotal / Math.max(1, bandRanges.length);

    if (centroidMagnitude > 1e-5) {
      const centroidHz = centroidWeighted / centroidMagnitude;
      const maxHz = Math.min(20000, sampleRate / 2);
      centroid[frameIndex] = clamp(
        Math.log(Math.max(20, centroidHz) / 20) / Math.log(maxHz / 20),
        0,
        1
      );
    } else {
      centroid[frameIndex] = 0.5;
    }

    let lowSum = 0;
    for (let bin = lowRange.minimumBin; bin < lowRange.maximumBin; bin += 1) {
      lowSum += normalized[bin];
    }
    low[frameIndex] = lowSum / (lowRange.maximumBin - lowRange.minimumBin);

    const now = performance.now();
    if (now - lastYield > 60) {
      lastYield = now;
      onProgress((frameIndex + 1) / frameCount);
      await nextEventLoopTurn();
    }
  }

  // Percentile-based track peak is more robust than one clipped frame.
  const sortedOverall = Array.from(overall).sort((a, b) => a - b);
  const percentileIndex = Math.min(
    sortedOverall.length - 1,
    Math.max(0, Math.floor(sortedOverall.length * 0.98))
  );
  const trackPeak = Math.max(0.05, sortedOverall[percentileIndex] || 0.05);

  // Low anchor for attractor traversal. `overall` is a mean of dB-domain band
  // values, so a track occupies a narrow, elevated slice of 0..1 and dividing
  // by the peak alone maps that slice into the bottom of the control range.
  // Anchoring both ends rescales whatever range the track actually uses.
  const floorIndex = Math.min(
    sortedOverall.length - 1,
    Math.max(0, Math.floor(sortedOverall.length * 0.10))
  );
  const overallFloor = Math.max(0, sortedOverall[floorIndex] || 0);

  // Precompute a time-based adaptive reference so preview and deterministic
  // export use the same gain envelope at a given source timestamp.
  const frameDelta = 1 / Math.max(1, fps);
  const attack = 1 - Math.exp(-frameDelta / 0.08);
  const release = 1 - Math.exp(-frameDelta / 1.2);
  let adaptive = Math.max(0.08, overall[0] || 0);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const signal = overall[frameIndex];
    const factor = signal > adaptive ? attack : release;
    adaptive += (signal - adaptive) * factor;
    adaptive = Math.max(0.08, adaptive);
    adaptivePeak[frameIndex] = adaptive;
  }

  onProgress(1);
  return {
    fps, frameCount, bands, low, flux, centroid, overall, adaptivePeak,
    trackPeak, overallFloor, duration
  };
}

function normalizeAmplitude(rawValue, referenceValue = 1) {
  const gain = clamp(Number(state.inputGain) || 1, 0.25, 4);
  const floor = clamp((Number(state.noiseFloor) || 0) / 100, 0, 0.3);
  const dynamicRange = clamp(Number(state.dynamicRange) || 60, 24, 96);
  const adjusted = Math.max(0, rawValue * gain - floor);
  const reference = Math.max(0.04, referenceValue * gain - floor);
  const normalized = clamp(adjusted / reference, 0, 1);
  const exponent = 60 / dynamicRange;
  return clamp(Math.pow(normalized, exponent), 0, 1);
}

/** Write the magnitudes for a given playhead time into shared state. */
export function sampleAnalysisAtTime(seconds) {
  const analysis = state.analysis;
  if (!analysis) {
    state.magnitudes.fill(0);
    state.lowFreqMagnitude = 0;
    state.spectralEnergy = 0;
    state.attractorEnergy = 0;
    return;
  }

  const frameIndex = clamp(
    Math.round(seconds * analysis.fps),
    0,
    analysis.frameCount - 1
  );

  let reference = 1;
  if (state.amplitudeMode === "track") {
    reference = analysis.trackPeak || 1;
  } else if (state.amplitudeMode === "adaptive") {
    reference = analysis.adaptivePeak?.[frameIndex] || analysis.trackPeak || 1;
  }

  for (let bandIndex = 0; bandIndex < analysis.bands.length; bandIndex += 1) {
    state.magnitudes[bandIndex] = normalizeAmplitude(
      analysis.bands[bandIndex][frameIndex],
      reference
    );
  }
  state.lowFreqMagnitude = normalizeAmplitude(analysis.low[frameIndex], reference);
  state.spectralCentroid = analysis.centroid?.[frameIndex] ?? 0.5;
  const rawOverall = analysis.overall?.[frameIndex] || 0;
  state.spectralEnergy = normalizeAmplitude(rawOverall, reference);

  // Chaotic-attractor traversal needs the track's actual loudness contrast.
  // Adaptive amplitude normalization intentionally keeps visual amplitude near
  // a stable level, which is useful for particle size/brightness but makes it
  // a poor speed control. Keep a separate track-relative energy signal so a
  // quiet passage stays quiet and a loud passage produces a visibly faster
  // traversal regardless of the selected amplitude-normalization mode.
  const attractorPeak = Math.max(0.04, analysis.trackPeak || 0.04);
  const attractorFloor = Math.min(
    Math.max(0, Number(analysis.overallFloor) || 0),
    attractorPeak * 0.9
  );
  const attractorSpan = Math.max(0.02, attractorPeak - attractorFloor);
  state.attractorEnergy = clamp(
    (rawOverall - attractorFloor) / attractorSpan,
    0,
    1
  );
  state.adaptiveReference = analysis.adaptivePeak?.[frameIndex] || 0;
}

/** Reduce the decoded buffer to min/max peak pairs for the loop waveform. */
export function computeWaveformPeaks(audioBuffer, bucketCount = 900) {
  const channel = audioBuffer.getChannelData(0);
  const samplesPerBucket = Math.max(1, Math.floor(channel.length / bucketCount));
  const peaks = new Float32Array(bucketCount * 2);

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * samplesPerBucket;
    const end = Math.min(channel.length, start + samplesPerBucket);
    let minimum = 0;
    let maximum = 0;
    for (let index = start; index < end; index += 1) {
      const sample = channel[index];
      if (sample < minimum) minimum = sample;
      if (sample > maximum) maximum = sample;
    }
    peaks[bucket * 2] = minimum;
    peaks[bucket * 2 + 1] = maximum;
  }

  return peaks;
}

/**
 * Estimate tempo by autocorrelating the spectral-flux onset envelope produced
 * during analysis. Returns a BPM in the 70–180 range.
 */
export function detectTempo(analysis) {
  if (!analysis || !analysis.flux) return null;

  const { flux, fps } = analysis;
  const frameCount = flux.length;
  if (frameCount < fps * 4) return null;

  // Remove the slow-moving mean so sustained loudness does not dominate.
  const windowSize = Math.round(fps * 0.5);
  const envelope = new Float32Array(frameCount);
  let runningSum = 0;
  for (let index = 0; index < frameCount; index += 1) {
    runningSum += flux[index];
    if (index >= windowSize) runningSum -= flux[index - windowSize];
    const mean = runningSum / Math.min(index + 1, windowSize);
    envelope[index] = Math.max(0, flux[index] - mean);
  }

  const minimumBpm = 70;
  const maximumBpm = 180;
  const minimumLag = Math.floor((60 / maximumBpm) * fps);
  const maximumLag = Math.ceil((60 / minimumBpm) * fps);

  let bestLag = 0;
  let bestScore = -Infinity;

  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let score = 0;
    for (let index = 0; index + lag < frameCount; index += 1) {
      score += envelope[index] * envelope[index + lag];
    }
    score /= frameCount - lag;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (!bestLag) return null;
  const bpm = (60 * fps) / bestLag;
  return clamp(Math.round(bpm), 40, 300);
}

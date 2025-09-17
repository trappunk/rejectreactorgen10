/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

interface AudioBlob {
    data: string;
    mimeType: string;
}

function encode(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createBlobFromFloat32(data: Float32Array): AudioBlob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // convert float32 -1 to 1 to int16 -32768 to 32767
    int16[i] = Math.max(-32768, Math.min(32767, data[i] * 32768));
  }

  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

async function resampleAudioBuffer(
  audioBuffer: AudioBuffer,
  targetSampleRate: number
): Promise<AudioBuffer> {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const duration = audioBuffer.duration;
    const offlineCtx = new OfflineAudioContext(
        numberOfChannels,
        duration * targetSampleRate,
        targetSampleRate
    );
    const bufferSource = offlineCtx.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(offlineCtx.destination);
    bufferSource.start();
    return await offlineCtx.startRendering();
}

async function resampleAndEncodeAudio(arrayBuffer: ArrayBuffer, audioContext: AudioContext): Promise<{data: string, waveformData: Float32Array}> {
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const resampledBuffer = await resampleAudioBuffer(audioBuffer, 16000);

  // Downmix to mono by averaging channels
  const numChannels = resampledBuffer.numberOfChannels;
  const length = resampledBuffer.length;
  const monoChannel = new Float32Array(length);

  if (numChannels > 1) {
    const channels = Array.from({ length: numChannels }, (_, i) => resampledBuffer.getChannelData(i));
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let j = 0; j < numChannels; j++) {
        sum += channels[j][i];
      }
      monoChannel[i] = sum / numChannels;
    }
  } else {
    monoChannel.set(resampledBuffer.getChannelData(0));
  }

  // Create waveform data for visualization (downsampled)
  const waveformLength = 1024;
  const waveformData = new Float32Array(waveformLength);
  const step = Math.floor(length / waveformLength);
  for(let i=0; i < waveformLength; i++) {
    const start = i * step;
    const end = start + step;
    let max = 0;
    for (let j = start; j < end; j++) {
      const val = Math.abs(monoChannel[j]);
      if (val > max) {
        max = val;
      }
    }
    waveformData[i] = max;
  }


  const audioBlob = createBlobFromFloat32(monoChannel);
  return { data: audioBlob.data, waveformData };
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  // The number of audio samples per channel.
  const numSamples = Math.floor(data.byteLength / 2 / numChannels);
  
  // Bail if we have no audio data.
  if (numSamples === 0) {
    return ctx.createBuffer(numChannels, 1, sampleRate);
  }

  const audioBuffer = ctx.createBuffer(numChannels, numSamples, sampleRate);

  // A DataView is required to read the 16-bit little-endian samples.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    let dataIndex = channel * 2; // byte offset for the channel
    for (let i = 0; i < numSamples; i++) {
      // Get the 16-bit sample and convert it to a float.
      const sample = view.getInt16(dataIndex, true); 
      channelData[i] = sample / 32768.0;
      dataIndex += numChannels * 2; // Move to the next sample for this channel
    }
  }
  return audioBuffer;
}

export {decode, decodeAudioData, encode, resampleAndEncodeAudio};
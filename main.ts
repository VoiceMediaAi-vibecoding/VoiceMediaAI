// ============= PIPELINE STT+LLM+TTS v6.0.0 =============
// Replaces OpenAI Realtime API with batch STT + Chat Completions + streaming TTS
// Cost reduction: ~97% (no audio tokens to OpenAI)

import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

// Load environment variables
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const RELAY_SHARED_SECRET = Deno.env.get("RELAY_SHARED_SECRET");

const PORT = parseInt(Deno.env.get("PORT") || "8080");

console.log(`🚀 Pipeline Relay Server v6.0.0 starting on port ${PORT}...`);
console.log(`   Mode: STT (Whisper) + LLM (Chat Completions) + TTS (ElevenLabs)`);

// ============ G.711 μ-law CODEC ============
const ULAW_DECODE_TABLE: Int16Array = new Int16Array([
  -32124, -31100, -30076, -29052, -28028, -27004, -25980, -24956,
  -23932, -22908, -21884, -20860, -19836, -18812, -17788, -16764,
  -15996, -15484, -14972, -14460, -13948, -13436, -12924, -12412,
  -11900, -11388, -10876, -10364, -9852, -9340, -8828, -8316,
  -7932, -7676, -7420, -7164, -6908, -6652, -6396, -6140,
  -5884, -5628, -5372, -5116, -4860, -4604, -4348, -4092,
  -3900, -3772, -3644, -3516, -3388, -3260, -3132, -3004,
  -2876, -2748, -2620, -2492, -2364, -2236, -2108, -1980,
  -1884, -1820, -1756, -1692, -1628, -1564, -1500, -1436,
  -1372, -1308, -1244, -1180, -1116, -1052, -988, -924,
  -876, -844, -812, -780, -748, -716, -684, -652,
  -620, -588, -556, -524, -492, -460, -428, -396,
  -372, -356, -340, -324, -308, -292, -276, -260,
  -244, -228, -212, -196, -180, -164, -148, -132,
  -120, -112, -104, -96, -88, -80, -72, -64,
  -56, -48, -40, -32, -24, -16, -8, 0,
  32124, 31100, 30076, 29052, 28028, 27004, 25980, 24956,
  23932, 22908, 21884, 20860, 19836, 18812, 17788, 16764,
  15996, 15484, 14972, 14460, 13948, 13436, 12924, 12412,
  11900, 11388, 10876, 10364, 9852, 9340, 8828, 8316,
  7932, 7676, 7420, 7164, 6908, 6652, 6396, 6140,
  5884, 5628, 5372, 5116, 4860, 4604, 4348, 4092,
  3900, 3772, 3644, 3516, 3388, 3260, 3132, 3004,
  2876, 2748, 2620, 2492, 2364, 2236, 2108, 1980,
  1884, 1820, 1756, 1692, 1628, 1564, 1500, 1436,
  1372, 1308, 1244, 1180, 1116, 1052, 988, 924,
  876, 844, 812, 780, 748, 716, 684, 652,
  620, 588, 556, 524, 492, 460, 428, 396,
  372, 356, 340, 324, 308, 292, 276, 260,
  244, 228, 212, 196, 180, 164, 148, 132,
  120, 112, 104, 96, 88, 80, 72, 64,
  56, 48, 40, 32, 24, 16, 8, 0
]);

function decodeUlaw(base64Audio: string): Int16Array {
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const pcm = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    pcm[i] = ULAW_DECODE_TABLE[bytes[i]];
  }
  return pcm;
}

function calculateRmsDb(pcm: Int16Array): number {
  if (pcm.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    sum += pcm[i] * pcm[i];
  }
  const rms = Math.sqrt(sum / pcm.length);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms / 32768);
}

// ============ WAV ENCODER ============
function createWavBuffer(pcmData: Int16Array, sampleRate: number = 8000): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length * 2;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true);  // AudioFormat (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM data
  const int16View = new Int16Array(buffer, headerSize);
  int16View.set(pcmData);

  return new Uint8Array(buffer);
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ============ SYSTEM PROMPT TRUNCATION ============
// Aggressive truncation for fast LLM responses
const MAX_SYSTEM_PROMPT_CHARS = 2000; // ~500 tokens for FAST responses

function truncateSystemPrompt(prompt: string): string {
  if (prompt.length <= MAX_SYSTEM_PROMPT_CHARS) return prompt;
  
  // Find a natural break point
  const truncated = prompt.substring(0, MAX_SYSTEM_PROMPT_CHARS);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastNewline = truncated.lastIndexOf('\n');
  const breakPoint = Math.max(lastPeriod, lastNewline, MAX_SYSTEM_PROMPT_CHARS - 100);
  
  const result = prompt.substring(0, breakPoint + 1);
  console.log(`[LLM] Truncated: ${prompt.length} -> ${result.length} chars`);
  return result;
}

// ============ TURN MANAGER ============
interface TurnResult {
  type: 'turn_complete';
  pcmBuffer: Int16Array;
  durationMs: number;
}

interface VADConfig {
  silenceThresholdDb: number;
  silenceDurationMs: number;
  prefixBufferMs: number;
  minTurnDurationMs: number;
  sampleRate: number;
}

class TurnManager {
  private config: VADConfig;
  private pcmChunks: Int16Array[] = [];
  private prefixBuffer: Int16Array[] = [];
  private isUserSpeaking: boolean = false;
  private silenceStartTime: number | null = null;
  private turnStartTime: number | null = null;
  private maxPrefixChunks: number;
  private samplesPerChunk: number = 160; // 20ms at 8kHz

  // Stats
  private totalChunksReceived: number = 0;
  private totalVoiceChunks: number = 0;

  constructor(config: Partial<VADConfig> = {}) {
    this.config = {
      silenceThresholdDb: config.silenceThresholdDb ?? -40,
      silenceDurationMs: config.silenceDurationMs ?? 600, // Reduced from 800ms for faster response
      prefixBufferMs: config.prefixBufferMs ?? 300,
      minTurnDurationMs: config.minTurnDurationMs ?? 300,
      sampleRate: config.sampleRate ?? 8000,
    };
    const chunkDurationMs = (this.samplesPerChunk / this.config.sampleRate) * 1000;
    this.maxPrefixChunks = Math.ceil(this.config.prefixBufferMs / chunkDurationMs);
    console.log(`[TURN] Initialized: threshold=${this.config.silenceThresholdDb}dB, silence=${this.config.silenceDurationMs}ms, minTurn=${this.config.minTurnDurationMs}ms`);
  }

  processChunk(base64Audio: string): TurnResult | null {
    this.totalChunksReceived++;
    const pcm = decodeUlaw(base64Audio);
    const rmsDb = calculateRmsDb(pcm);
    const now = Date.now();
    const hasVoice = rmsDb >= this.config.silenceThresholdDb;

    // Always maintain prefix buffer
    this.prefixBuffer.push(pcm);
    if (this.prefixBuffer.length > this.maxPrefixChunks) {
      this.prefixBuffer.shift();
    }

    if (hasVoice) {
      this.totalVoiceChunks++;
      if (!this.isUserSpeaking) {
        // Transition: silence -> speaking
        this.isUserSpeaking = true;
        this.silenceStartTime = null;
        this.turnStartTime = now;
        // Include prefix buffer
        this.pcmChunks = [...this.prefixBuffer];
        console.log(`[TURN] Voice started at ${rmsDb.toFixed(1)}dB, prefix=${this.prefixBuffer.length} chunks`);
      } else {
        // Continue speaking
        this.pcmChunks.push(pcm);
      }
    } else {
      // Silence
      if (this.isUserSpeaking) {
        // Still might be speaking (short pause)
        this.pcmChunks.push(pcm); // Include silence in buffer

        if (!this.silenceStartTime) {
          this.silenceStartTime = now;
        }

        const silenceDuration = now - this.silenceStartTime;

        if (silenceDuration >= this.config.silenceDurationMs) {
          // End of turn detected
          const turnDuration = this.turnStartTime ? now - this.turnStartTime : 0;

          if (turnDuration >= this.config.minTurnDurationMs && this.pcmChunks.length > 0) {
            // Concatenate all PCM chunks
            const totalSamples = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const combinedPcm = new Int16Array(totalSamples);
            let offset = 0;
            for (const chunk of this.pcmChunks) {
              combinedPcm.set(chunk, offset);
              offset += chunk.length;
            }

            console.log(`[TURN] Complete: ${turnDuration}ms, ${this.pcmChunks.length} chunks, ${totalSamples} samples`);

            // Reset state
            this.isUserSpeaking = false;
            this.silenceStartTime = null;
            this.turnStartTime = null;
            this.pcmChunks = [];

            return {
              type: 'turn_complete',
              pcmBuffer: combinedPcm,
              durationMs: turnDuration,
            };
          } else {
            // Turn too short, discard
            console.log(`[TURN] Discarded (too short: ${turnDuration}ms)`);
            this.isUserSpeaking = false;
            this.silenceStartTime = null;
            this.turnStartTime = null;
            this.pcmChunks = [];
          }
        }
      }
    }

    return null;
  }

  isCurrentlySpeaking(): boolean {
    return this.isUserSpeaking;
  }

  interruptAndGetPartial(): Int16Array | null {
    if (this.pcmChunks.length === 0) return null;
    const totalSamples = this.pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combinedPcm = new Int16Array(totalSamples);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      combinedPcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.reset();
    return combinedPcm;
  }

  reset(): void {
    this.pcmChunks = [];
    this.isUserSpeaking = false;
    this.silenceStartTime = null;
    this.turnStartTime = null;
  }

  getStats(): { received: number; voice: number; voicePercent: number } {
    const voicePercent = this.totalChunksReceived > 0
      ? (this.totalVoiceChunks / this.totalChunksReceived) * 100
      : 0;
    return {
      received: this.totalChunksReceived,
      voice: this.totalVoiceChunks,
      voicePercent,
    };
  }
}

// ============ WHISPER STT ============
async function transcribeWithWhisper(
  pcmBuffer: Int16Array,
  language: string,
  prompt?: string | null
): Promise<{ text: string; durationSec: number }> {
  const startTime = Date.now();
  const wavBuffer = createWavBuffer(pcmBuffer, 8000);
  const durationSec = pcmBuffer.length / 8000;

  const formData = new FormData();
  formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-1');

  if (language && language !== 'auto') {
    formData.append('language', language);
  }
  if (prompt) {
    formData.append('prompt', prompt);
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Whisper API error: ${response.status} - ${error}`);
  }

  const result = await response.json();
  const elapsed = Date.now() - startTime;
  console.log(`[STT] Whisper: "${result.text.substring(0, 60)}..." (${durationSec.toFixed(1)}s audio, ${elapsed}ms latency)`);

  return { text: result.text, durationSec };
}

// ============ LLM CHAT COMPLETIONS ============
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function generateLLMResponse(
  systemPrompt: string,
  conversationHistory: ChatMessage[],
  userMessage: string,
  temperature: number = 0.7
): Promise<LLMResult> {
  const startTime = Date.now();

  // Aggressive truncation for speed
  const truncatedPrompt = truncateSystemPrompt(systemPrompt);

  // Only keep last 4 messages for minimal context, maximum speed
  const recentHistory = conversationHistory.slice(-4);

  const messages: ChatMessage[] = [
    { role: 'system', content: truncatedPrompt },
    ...recentHistory,
    { role: 'user', content: userMessage },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens: 150, // Very short for fast responses
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Chat Completions error: ${response.status} - ${error}`);
  }

  const result = await response.json();
  const elapsed = Date.now() - startTime;
  const text = result.choices[0]?.message?.content || '';
  const inputTokens = result.usage?.prompt_tokens || 0;
  const outputTokens = result.usage?.completion_tokens || 0;

  console.log(`[LLM] ${elapsed}ms (${inputTokens}+${outputTokens} tokens): "${text.substring(0, 50)}..."`);

  return { text, inputTokens, outputTokens };
}

// ============ PRICING (NEW PIPELINE) ============
const PRICING = {
  WHISPER_PER_MINUTE: 0.006,        // $0.006/min
  GPT4O_MINI_INPUT: 0.00000015,     // $0.15/1M tokens
  GPT4O_MINI_OUTPUT: 0.0000006,     // $0.60/1M tokens
  ELEVENLABS_PER_CHAR: 0.00003,     // ~$30/1M chars
};

interface CallMetrics {
  turnsCount: number;
  sttDurationSec: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  ttsCharacters: number;
  latencies: {
    turnEnd_to_stt: number[];
    stt_to_llm: number[];
    llm_to_ttsFirstChunk: number[];
  };
}

function calculatePipelineCost(metrics: CallMetrics): number {
  const sttCost = (metrics.sttDurationSec / 60) * PRICING.WHISPER_PER_MINUTE;
  const llmInputCost = metrics.llmInputTokens * PRICING.GPT4O_MINI_INPUT;
  const llmOutputCost = metrics.llmOutputTokens * PRICING.GPT4O_MINI_OUTPUT;
  const ttsCost = metrics.ttsCharacters * PRICING.ELEVENLABS_PER_CHAR;
  return sttCost + llmInputCost + llmOutputCost + ttsCost;
}

// ============ AGENT CONFIG ============
async function loadAgentConfig(agentId: string) {
  const defaultConfig = {
    systemPrompt: "You are a helpful AI assistant for phone calls. Respond in Spanish. Be concise and helpful.",
    voice: "alloy",
    voiceProvider: "elevenlabs",
    elevenlabsVoiceId: "EXAVITQu4vr4xnSDxMaL",
    elevenlabsModel: "eleven_turbo_v2_5",
    name: "Asistente Virtual",
    greeting: null as string | null,
    whisperLanguage: "es",
    whisperPrompt: null as string | null,
    silenceDurationMs: 600, // Reduced default for faster response
    prefixPaddingMs: 300,
    temperature: 0.8,
  };

  try {
    const url = `${SUPABASE_URL}/functions/v1/relay-agent-config`;
    console.log(`[AGENT] Fetching config: ${agentId}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-secret': RELAY_SHARED_SECRET!,
      },
      body: JSON.stringify({ agentId }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[AGENT] Error:`, data);
      return defaultConfig;
    }

    console.log(`✅ Loaded agent: ${data.name} (${data.id})`);
    console.log(`   Voice: ElevenLabs ${data.elevenlabsVoiceId || 'default'}`);
    console.log(`   Greeting: ${data.greeting?.substring(0, 60) || 'none'}...`);

    return {
      systemPrompt: data.systemPrompt || defaultConfig.systemPrompt,
      voice: data.voice || "alloy",
      voiceProvider: data.voiceProvider || "elevenlabs",
      elevenlabsVoiceId: data.elevenlabsVoiceId || defaultConfig.elevenlabsVoiceId,
      elevenlabsModel: data.elevenlabsModel || "eleven_turbo_v2_5",
      name: data.name || defaultConfig.name,
      greeting: data.greeting || null,
      whisperLanguage: data.whisperLanguage || "es",
      whisperPrompt: data.whisperPrompt || null,
      silenceDurationMs: Math.min(data.silenceDurationMs ?? 600, 800), // Cap at 800ms max
      prefixPaddingMs: data.prefixPaddingMs ?? 300,
      temperature: data.temperature ?? 0.8,
    };
  } catch (e) {
    console.error("[AGENT] Error fetching config:", e);
    return defaultConfig;
  }
}

// ============ MAIN WEBSOCKET HANDLER ============
type Provider = 'twilio' | 'telnyx';

interface UrlParams {
  agentId: string | null;
  callLogId: string | null;
  provider: Provider;
}

function handleWebSocket(socket: WebSocket, urlParams: UrlParams) {
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let callLogId: string | null = urlParams.callLogId;
  let provider: Provider = urlParams.provider;

  let agentConfig = {
    systemPrompt: "",
    voice: "alloy",
    voiceProvider: "elevenlabs",
    elevenlabsVoiceId: "EXAVITQu4vr4xnSDxMaL",
    elevenlabsModel: "eleven_turbo_v2_5",
    name: "Asistente",
    greeting: null as string | null,
    whisperLanguage: "es",
    whisperPrompt: null as string | null,
    silenceDurationMs: 600,
    prefixPaddingMs: 300,
    temperature: 0.8,
  };

  let turnManager: TurnManager | null = null;
  let twilioPlaybackToken = 0;
  let isProcessingTurn = false;
  let isTTSPlaying = false;
  let isCallEnded = false; // Track if call has ended

  // Conversation state
  const conversationHistory: ChatMessage[] = [];
  const conversationTranscript: { role: string; text: string }[] = [];

  // Call tracking
  let callStartTime: number | null = null;
  const metrics: CallMetrics = {
    turnsCount: 0,
    sttDurationSec: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
    ttsCharacters: 0,
    latencies: {
      turnEnd_to_stt: [],
      stt_to_llm: [],
      llm_to_ttsFirstChunk: [],
    },
  };

  // Helpers
  const sendToCaller = (msg: Record<string, unknown>) => {
    if (socket.readyState !== WebSocket.OPEN || isCallEnded) return;
    socket.send(JSON.stringify(msg));
  };

  const sendAudioToCaller = (payloadBase64: string) => {
    if (!streamSid || isCallEnded) return;
    if (provider === 'telnyx') {
      sendToCaller({ event: 'media', stream_id: streamSid, media: { payload: payloadBase64 } });
    } else {
      sendToCaller({ event: 'media', streamSid, media: { payload: payloadBase64 } });
    }
  };

  const clearCallerAudio = () => {
    if (!streamSid || isCallEnded) return;
    if (provider === 'telnyx') {
      sendToCaller({ event: 'clear', stream_id: streamSid });
    } else {
      sendToCaller({ event: 'clear', streamSid });
    }
  };

  // ElevenLabs TTS streaming
  async function streamElevenLabsTTS(text: string, currentToken: number): Promise<void> {
    // Check if call is still active before starting TTS
    if (isCallEnded || socket.readyState !== WebSocket.OPEN) {
      console.log(`[TTS] Skipped - call ended`);
      return;
    }

    const ttsStartTime = Date.now();
    let firstChunkTime: number | null = null;

    try {
      const voiceId = agentConfig.elevenlabsVoiceId || "EXAVITQu4vr4xnSDxMaL";
      console.log(`[TTS] Starting ElevenLabs: "${text.substring(0, 50)}..."`);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: agentConfig.elevenlabsModel || "eleven_turbo_v2_5",
            voice_settings: { stability: 0.4, similarity_boost: 0.7 },
          }),
        }
      );

      if (!response.ok || !response.body) {
        console.error("[TTS] API error:", response.status);
        return;
      }

      metrics.ttsCharacters += text.length;

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      const CHUNK_SIZE = 160;
      let chunksSent = 0;

      while (true) {
        // Check interruption or call end
        if (currentToken !== twilioPlaybackToken || isCallEnded || socket.readyState !== WebSocket.OPEN) {
          reader.cancel();
          console.log(`[TTS] Interrupted after ${chunksSent} chunks`);
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            const latency = firstChunkTime - ttsStartTime;
            metrics.latencies.llm_to_ttsFirstChunk.push(latency);
            console.log(`[TTS] First chunk in ${latency}ms`);
          }

          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer, 0);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          while (buffer.length >= CHUNK_SIZE) {
            const chunk = buffer.slice(0, CHUNK_SIZE);
            buffer = buffer.slice(CHUNK_SIZE);

            if (streamSid && socket.readyState === WebSocket.OPEN && !isCallEnded) {
              sendAudioToCaller(base64Encode(chunk));
              chunksSent++;
            }
          }
        }
      }

      // Send remaining
      if (buffer.length > 0 && streamSid && socket.readyState === WebSocket.OPEN && !isCallEnded) {
        sendAudioToCaller(base64Encode(buffer));
        chunksSent++;
      }

      const totalTime = Date.now() - ttsStartTime;
      console.log(`[TTS] Complete: ${chunksSent} chunks, ${totalTime}ms`);
    } catch (error) {
      console.error("[TTS] Error:", error);
    }
  }

  // Process a complete user turn
  async function processTurn(pcmBuffer: Int16Array, turnDurationMs: number): Promise<void> {
    if (isProcessingTurn || isCallEnded) {
      console.log("[TURN] Already processing or call ended, skipping");
      return;
    }

    isProcessingTurn = true;
    isTTSPlaying = true;
    const turnEndTime = Date.now();
    const currentPlaybackToken = ++twilioPlaybackToken;

    try {
      metrics.turnsCount++;

      // === STT ===
      const sttStartTime = Date.now();
      const { text: userText, durationSec } = await transcribeWithWhisper(
        pcmBuffer,
        agentConfig.whisperLanguage,
        agentConfig.whisperPrompt
      );
      const sttLatency = Date.now() - sttStartTime;
      metrics.latencies.turnEnd_to_stt.push(sttLatency);
      metrics.sttDurationSec += durationSec;

      if (!userText.trim()) {
        console.log("[TURN] Empty transcription, skipping");
        isProcessingTurn = false;
        isTTSPlaying = false;
        return;
      }

      // Check if interrupted or call ended
      if (currentPlaybackToken !== twilioPlaybackToken || isCallEnded) {
        console.log("[TURN] Interrupted during STT");
        isProcessingTurn = false;
        isTTSPlaying = false;
        return;
      }

      conversationTranscript.push({ role: 'user', text: userText });
      conversationHistory.push({ role: 'user', content: userText });

      // === LLM === (pass minimal history for speed)
      const llmStartTime = Date.now();
      const { text: assistantText, inputTokens, outputTokens } = await generateLLMResponse(
        agentConfig.systemPrompt,
        conversationHistory.slice(-4), // Only last 4 messages
        userText,
        agentConfig.temperature
      );
      const llmLatency = Date.now() - llmStartTime;
      metrics.latencies.stt_to_llm.push(llmLatency);
      metrics.llmInputTokens += inputTokens;
      metrics.llmOutputTokens += outputTokens;

      if (!assistantText.trim()) {
        console.log("[TURN] Empty LLM response, skipping");
        isProcessingTurn = false;
        isTTSPlaying = false;
        return;
      }

      // Check if interrupted or call ended
      if (currentPlaybackToken !== twilioPlaybackToken || isCallEnded) {
        console.log("[TURN] Interrupted during LLM");
        isProcessingTurn = false;
        isTTSPlaying = false;
        return;
      }

      conversationTranscript.push({ role: 'agent', text: assistantText });
      conversationHistory.push({ role: 'assistant', content: assistantText });

      // === TTS ===
      await streamElevenLabsTTS(assistantText, currentPlaybackToken);

      const totalLatency = Date.now() - turnEndTime;
      console.log(`[LATENCY] Total turn: ${totalLatency}ms (STT: ${sttLatency}ms, LLM: ${llmLatency}ms)`);

    } catch (error) {
      console.error("[TURN] Processing error:", error);
    } finally {
      isProcessingTurn = false;
      isTTSPlaying = false;
    }
  }

  // Finalize call
  const finalizeCall = async () => {
    if (!callLogId) {
      console.log("[TRACKING] No callLogId, skipping finalization");
      return;
    }

    const duration = callStartTime
      ? Math.round((Date.now() - callStartTime) / 1000)
      : 0;

    const transcript = conversationTranscript
      .map(m => `${m.role}: ${m.text}`)
      .join('\n');

    const estimatedCost = calculatePipelineCost(metrics);
    const turnStats = turnManager?.getStats() || { received: 0, voice: 0, voicePercent: 0 };

    // Calculate average latencies
    const avgLatency = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    console.log(`[TRACKING] Finalizing call ${callLogId}:`);
    console.log(`  Duration: ${duration}s, Turns: ${metrics.turnsCount}`);
    console.log(`  STT audio: ${metrics.sttDurationSec.toFixed(1)}s`);
    console.log(`  LLM tokens: ${metrics.llmInputTokens} in, ${metrics.llmOutputTokens} out`);
    console.log(`  TTS chars: ${metrics.ttsCharacters}`);
    console.log(`  Estimated Cost: $${estimatedCost.toFixed(4)}`);
    console.log(`  Avg Latencies: STT=${avgLatency(metrics.latencies.turnEnd_to_stt)}ms, LLM=${avgLatency(metrics.latencies.stt_to_llm)}ms, TTS=${avgLatency(metrics.latencies.llm_to_ttsFirstChunk)}ms`);
    console.log(`  Voice activity: ${turnStats.voicePercent.toFixed(1)}% (${turnStats.voice}/${turnStats.received} chunks)`);

    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/update-call-log`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RELAY_SHARED_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          call_log_id: callLogId,
          duration_seconds: duration,
          transcript: transcript,
          status: 'completed',
          ended_at: new Date().toISOString(),
          usage: {
            // New pipeline metrics
            pipeline_version: '6.0.0',
            turns_count: metrics.turnsCount,
            stt_duration_sec: metrics.sttDurationSec,
            llm_input_tokens: metrics.llmInputTokens,
            llm_output_tokens: metrics.llmOutputTokens,
            tts_characters: metrics.ttsCharacters,
            estimated_cost: estimatedCost,
            voice_activity_percent: turnStats.voicePercent,
            avg_latency_stt_ms: avgLatency(metrics.latencies.turnEnd_to_stt),
            avg_latency_llm_ms: avgLatency(metrics.latencies.stt_to_llm),
            avg_latency_tts_ms: avgLatency(metrics.latencies.llm_to_ttsFirstChunk),
            // Legacy fields for backwards compatibility
            input_tokens: metrics.llmInputTokens,
            output_tokens: metrics.llmOutputTokens,
            audio_input_tokens: 0,
            audio_output_tokens: 0,
            text_input_tokens: metrics.llmInputTokens,
            text_output_tokens: metrics.llmOutputTokens,
          },
        }),
      });

      if (!response.ok) {
        console.error("[TRACKING] Failed to update call log:", await response.text());
      } else {
        console.log("[TRACKING] Call log updated successfully");
      }
    } catch (error) {
      console.error("[TRACKING] Error updating call log:", error);
    }
  };

  // Main message handler
  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data as string);

      switch (data.event) {
        case 'connected':
          console.log(`[${provider.toUpperCase()}] Connected`);
          break;

        case 'start':
          // Auto-detect provider
          if (typeof data.stream_id === 'string' || typeof data?.start?.call_control_id === 'string') {
            provider = 'telnyx';
            streamSid = (data.stream_id || data?.start?.stream_id || null) as string | null;
            callSid = (data?.start?.call_control_id || null) as string | null;
          } else {
            provider = 'twilio';
            streamSid = (data?.start?.streamSid || null) as string | null;
            callSid = (data?.start?.callSid || null) as string | null;
          }

          callStartTime = Date.now();
          callLogId = callLogId || data?.start?.customParameters?.call_log_id || data?.start?.customParameters?.callLogId || null;

          console.log(`[${provider.toUpperCase()}] Stream started - SID: ${streamSid}, Call: ${callSid}`);
          console.log(`[TRACKING] Call log ID: ${callLogId || 'none'}`);

          const startAgentId = data?.start?.customParameters?.agent_id || data?.start?.customParameters?.agentId || null;
          const effectiveAgentId = (startAgentId || urlParams.agentId || "default").toString();
          console.log(`[AGENT] Loading config for: ${effectiveAgentId}`);

          agentConfig = await loadAgentConfig(effectiveAgentId);

          // Initialize turn manager with faster settings
          turnManager = new TurnManager({
            silenceThresholdDb: -40,
            silenceDurationMs: agentConfig.silenceDurationMs,
            prefixBufferMs: agentConfig.prefixPaddingMs,
            minTurnDurationMs: 300,
          });

          // Send greeting immediately
          if (agentConfig.greeting) {
            console.log(`[GREETING] Playing: "${agentConfig.greeting.substring(0, 50)}..."`);
            isTTSPlaying = true;
            conversationTranscript.push({ role: 'agent', text: agentConfig.greeting });
            conversationHistory.push({ role: 'assistant', content: agentConfig.greeting });
            metrics.turnsCount++;

            await streamElevenLabsTTS(agentConfig.greeting, twilioPlaybackToken);
            isTTSPlaying = false;
          }
          break;

        case 'media':
          if (turnManager && socket.readyState === WebSocket.OPEN && !isCallEnded) {
            // Detect barge-in while TTS is playing
            if (isTTSPlaying) {
              const pcm = decodeUlaw(data.media.payload);
              const rmsDb = calculateRmsDb(pcm);
              if (rmsDb >= -35) { // Slightly higher threshold for barge-in
                console.log(`[BARGE-IN] Detected at ${rmsDb.toFixed(1)}dB, interrupting TTS`);
                twilioPlaybackToken++;
                clearCallerAudio();
                isTTSPlaying = false;
              }
            }

            // Process through turn manager
            const turnResult = turnManager.processChunk(data.media.payload);

            if (turnResult && turnResult.type === 'turn_complete') {
              // Don't process if currently speaking
              if (!isProcessingTurn && !isTTSPlaying) {
                processTurn(turnResult.pcmBuffer, turnResult.durationMs);
              }
            }
          }
          break;

        case 'stop':
          isCallEnded = true; // Mark call as ended immediately
          console.log(`[${provider.toUpperCase()}] Stream stopped`);

          // Log final metrics
          const cost = calculatePipelineCost(metrics);
          console.log(`[METRICS SUMMARY]`);
          console.log(`  Turns: ${metrics.turnsCount}`);
          console.log(`  STT Duration: ${metrics.sttDurationSec.toFixed(1)}s`);
          console.log(`  LLM Tokens: ${metrics.llmInputTokens} in, ${metrics.llmOutputTokens} out`);
          console.log(`  TTS Characters: ${metrics.ttsCharacters}`);
          console.log(`  Estimated Cost: $${cost.toFixed(4)}`);

          if (turnManager) {
            const stats = turnManager.getStats();
            console.log(`[VAD SUMMARY] Voice: ${stats.voice}/${stats.received} chunks (${stats.voicePercent.toFixed(1)}%)`);
          }

          await finalizeCall();
          break;
      }
    } catch (error) {
      console.error(`[${provider.toUpperCase()}] Message error:`, error);
    }
  };

  socket.onerror = (error) => console.error(`[${provider.toUpperCase()}] WebSocket error:`, error);
  socket.onclose = () => {
    isCallEnded = true;
    console.log(`[${provider.toUpperCase()}] WebSocket closed`);
  };
}

// ============ HTTP SERVER ============
Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ 
      status: "ok", 
      version: "6.0.0",
      mode: "STT+LLM+TTS Pipeline",
    }), { headers: { "Content-Type": "application/json" } });
  }

  if (upgradeHeader.toLowerCase() === "websocket") {
    const agentId = url.searchParams.get('agentId');
    const callLogId = url.searchParams.get('callLogId');
    const providerParam = (url.searchParams.get('provider') || 'twilio').toLowerCase();
    const provider: Provider = providerParam === 'telnyx' ? 'telnyx' : 'twilio';
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWebSocket(socket, { agentId, callLogId, provider });
    return response;
  }

  return new Response("Pipeline Relay Server v6.0.0 - STT+LLM+TTS", { status: 200 });
});

console.log(`✅ Pipeline Relay Server v6.0.0 running on port ${PORT}`);
console.log(`   No OpenAI Realtime API - 97% cost reduction`);

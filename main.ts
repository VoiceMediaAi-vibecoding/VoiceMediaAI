import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

// Load environment variables
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const RELAY_SHARED_SECRET = Deno.env.get("RELAY_SHARED_SECRET");

const PORT = parseInt(Deno.env.get("PORT") || "8080");

console.log(`🚀 Realtime Relay Server v5.1.0 starting on port ${PORT}...`);

// ============ LOCAL VAD IMPLEMENTATION ============
// G.711 μ-law decode table (standard ITU-T G.711)
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

interface VADConfig {
  silenceThresholdDb: number;    // dB threshold (e.g., -40)
  silenceDurationMs: number;     // ms of silence to stop (e.g., 800)
  prefixBufferMs: number;        // ms of audio to include before voice (e.g., 300)
  sampleRate: number;            // Sample rate (8000 for telephony)
}

class LocalVAD {
  private config: VADConfig;
  private audioBuffer: string[] = [];
  private silenceStartTime: number | null = null;
  private isSpeaking: boolean = false;
  private maxBufferChunks: number;
  private samplesPerChunk: number = 160; // 20ms at 8kHz
  
  // Stats for logging
  private totalChunksReceived: number = 0;
  private totalChunksSent: number = 0;
  
  constructor(config: Partial<VADConfig> = {}) {
    this.config = {
      silenceThresholdDb: config.silenceThresholdDb ?? -40,
      silenceDurationMs: config.silenceDurationMs ?? 800,
      prefixBufferMs: config.prefixBufferMs ?? 300,
      sampleRate: config.sampleRate ?? 8000,
    };
    
    // Calculate max buffer chunks: prefixBufferMs worth of 20ms chunks
    const chunkDurationMs = (this.samplesPerChunk / this.config.sampleRate) * 1000;
    this.maxBufferChunks = Math.ceil(this.config.prefixBufferMs / chunkDurationMs);
    
    console.log(`[VAD] Initialized: threshold=${this.config.silenceThresholdDb}dB, silence=${this.config.silenceDurationMs}ms, prefix=${this.config.prefixBufferMs}ms`);
  }
  
  private decodeUlaw(base64Audio: string): Int16Array {
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
  
  private calculateRmsDb(pcm: Int16Array): number {
    if (pcm.length === 0) return -Infinity;
    
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      sum += pcm[i] * pcm[i];
    }
    const rms = Math.sqrt(sum / pcm.length);
    
    // Normalize to dB (relative to max 16-bit value)
    if (rms === 0) return -Infinity;
    return 20 * Math.log10(rms / 32768);
  }
  
  processChunk(base64Audio: string): { shouldSend: boolean; chunks: string[] } {
    this.totalChunksReceived++;
    
    // Decode and analyze
    const pcm = this.decodeUlaw(base64Audio);
    const rmsDb = this.calculateRmsDb(pcm);
    
    const now = Date.now();
    const hasVoice = rmsDb >= this.config.silenceThresholdDb;
    
    // Add to rolling buffer (always, for prefix padding)
    this.audioBuffer.push(base64Audio);
    if (this.audioBuffer.length > this.maxBufferChunks) {
      this.audioBuffer.shift();
    }
    
    let chunksToSend: string[] = [];
    let shouldSend = false;
    
    if (hasVoice) {
      // Voice detected
      if (!this.isSpeaking) {
        // Transition from silence to speaking
        this.isSpeaking = true;
        this.silenceStartTime = null;
        
        // Send prefix buffer (audio before speech started)
        chunksToSend = [...this.audioBuffer];
        this.totalChunksSent += chunksToSend.length;
        
        console.log(`[VAD] Voice started at ${rmsDb.toFixed(1)}dB, sending ${chunksToSend.length} prefix chunks`);
      } else {
        // Continuing to speak
        chunksToSend = [base64Audio];
        this.totalChunksSent++;
      }
      shouldSend = true;
    } else {
      // Silence detected
      if (this.isSpeaking) {
        // Still might be speaking (short pause)
        if (!this.silenceStartTime) {
          this.silenceStartTime = now;
        }
        
        const silenceDuration = now - this.silenceStartTime;
        
        if (silenceDuration < this.config.silenceDurationMs) {
          // Short pause, keep sending
          chunksToSend = [base64Audio];
          this.totalChunksSent++;
          shouldSend = true;
        } else {
          // Long silence, stop sending
          this.isSpeaking = false;
          this.silenceStartTime = null;
          
          const reduction = this.totalChunksReceived > 0 
            ? ((1 - this.totalChunksSent / this.totalChunksReceived) * 100).toFixed(1)
            : '0';
          console.log(`[VAD] Voice ended. Stats: received=${this.totalChunksReceived}, sent=${this.totalChunksSent} (${reduction}% reduction)`);
        }
      }
      // If not speaking and silence, don't send anything (filtered out)
    }
    
    return { shouldSend, chunks: chunksToSend };
  }
  
  getStats(): { received: number; sent: number; reductionPercent: number } {
    const reductionPercent = this.totalChunksReceived > 0 
      ? (1 - this.totalChunksSent / this.totalChunksReceived) * 100
      : 0;
    return {
      received: this.totalChunksReceived,
      sent: this.totalChunksSent,
      reductionPercent,
    };
  }
  
  reset() {
    this.audioBuffer = [];
    this.silenceStartTime = null;
    this.isSpeaking = false;
  }
}

// ============ TOKEN USAGE TRACKING ============
interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  textInputTokens: number;
  textOutputTokens: number;
}

// OpenAI Realtime API pricing (January 2025)
const PRICING = {
  AUDIO_INPUT_PER_TOKEN: 0.0001,    // $100/1M tokens
  AUDIO_OUTPUT_PER_TOKEN: 0.0002,   // $200/1M tokens
  TEXT_INPUT_PER_TOKEN: 0.000005,   // $5/1M tokens
  TEXT_OUTPUT_PER_TOKEN: 0.00002,   // $20/1M tokens
};

function calculateCost(usage: UsageMetrics): number {
  return (
    usage.audioInputTokens * PRICING.AUDIO_INPUT_PER_TOKEN +
    usage.audioOutputTokens * PRICING.AUDIO_OUTPUT_PER_TOKEN +
    usage.textInputTokens * PRICING.TEXT_INPUT_PER_TOKEN +
    usage.textOutputTokens * PRICING.TEXT_OUTPUT_PER_TOKEN
  );
}

// ============ AGENT CONFIG ============
async function loadAgentConfig(agentId: string) {
  const defaultConfig = {
    systemPrompt: "You are a helpful AI assistant for phone calls. Respond in Spanish. Be concise and helpful.",
    voice: "alloy",
    voiceProvider: "openai",
    elevenlabsVoiceId: null as string | null,
    elevenlabsModel: "eleven_turbo_v2_5",
    name: "Asistente Virtual",
    greeting: null as string | null,
    // Local VAD settings (in dB and ms) - NOT the same as OpenAI's server_vad threshold (0-1 scale)
    localVadThresholdDb: -40,      // dB threshold for voice detection
    localVadSilenceMs: 800,        // ms of silence before stopping
    localVadPrefixMs: 300,         // ms of audio to buffer before voice
    whisperLanguage: "es",
    whisperPrompt: null as string | null,
    vadThreshold: -40,
    silenceDurationMs: 800,
    prefixPaddingMs: 300,
  };

  try {
    const url = `${SUPABASE_URL}/functions/v1/relay-agent-config`;
    console.log(`[AGENT_FETCH] Calling: ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-secret': RELAY_SHARED_SECRET!,
      },
      body: JSON.stringify({ agentId }),
    });

    const data = await response.json();
    console.log(`[AGENT_FETCH] Status: ${response.status}`);

    if (!response.ok) {
      console.error(`[AGENT_FETCH] Error:`, data);
      return defaultConfig;
    }

    console.log(`✅ Loaded agent: ${data.name} (${data.id})`);
    console.log(`   Voice Provider: ${data.voiceProvider}, Voice: ${data.voice}`);
    console.log(`   ElevenLabs Voice ID: ${data.elevenlabsVoiceId}`);
    console.log(`   Greeting: ${data.greeting?.substring(0, 80)}...`);

    // IMPORTANT: data.vadThreshold from DB is for OpenAI's server_vad (0-1 scale)
    // Local VAD needs dB values (negative, like -40dB). 
    // We use fixed sensible defaults for local VAD.
    return {
      systemPrompt: data.systemPrompt || defaultConfig.systemPrompt,
      voice: data.voice || "alloy",
      voiceProvider: data.voiceProvider || "openai",
      elevenlabsVoiceId: data.elevenlabsVoiceId,
      elevenlabsModel: data.elevenlabsModel || "eleven_turbo_v2_5",
      name: data.name || defaultConfig.name,
      greeting: data.greeting || null,
      whisperLanguage: data.whisperLanguage || "es",
      whisperPrompt: data.whisperPrompt || null,
      // Use fixed dB threshold for local VAD (NOT the 0-1 scale from DB)
      localVadThresholdDb: defaultConfig.localVadThresholdDb,
      localVadSilenceMs: data.silenceDurationMs ?? defaultConfig.localVadSilenceMs,
      localVadPrefixMs: data.prefixPaddingMs ?? defaultConfig.localVadPrefixMs,
    };
  } catch (e) {
    console.error("[AGENT] Error fetching agent config:", e);
    return defaultConfig;
  }
}

type Provider = 'twilio' | 'telnyx';

type RelayUrlParams = {
  agentId: string | null;
  callLogId: string | null;
  provider: Provider;
};

function handleWebSocket(socket: WebSocket, urlParams: RelayUrlParams) {
  let openAIWs: WebSocket | null = null;
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let agentConfig = {
    systemPrompt: "",
    voice: "alloy",
    voiceProvider: "openai",
    elevenlabsVoiceId: null as string | null,
    elevenlabsModel: "eleven_turbo_v2_5",
    name: "Asistente",
    greeting: null as string | null,
    whisperLanguage: "es",
    whisperPrompt: null as string | null,
    // Local VAD settings (dB-based, NOT 0-1 scale)
    localVadThresholdDb: -40,
    localVadSilenceMs: 800,
    localVadPrefixMs: 300,
  };
  let useElevenLabs = false;
  let audioBuffer: string[] = [];
  let twilioPlaybackToken = 0;
  
  // Local VAD instance
  let localVAD: LocalVAD | null = null;
  
  // Call tracking variables
  let callStartTime: number | null = null;
  let callLogId: string | null = null;
  let conversationTranscript: { role: string; text: string }[] = [];
  
  // Token usage tracking
  let usageMetrics: UsageMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    audioInputTokens: 0,
    audioOutputTokens: 0,
    textInputTokens: 0,
    textOutputTokens: 0,
  };
  
  // Multi-provider support
  let provider: Provider = urlParams.provider;

  // Prefer URL-provided callLogId (Telnyx passes it in the WS URL)
  callLogId = urlParams.callLogId;

  const sendToCaller = (msg: Record<string, unknown>) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  };

  const sendAudioToCaller = (payloadBase64: string) => {
    if (!streamSid) return;

    // Twilio expects streamSid; Telnyx expects stream_id.
    if (provider === 'telnyx') {
      sendToCaller({ event: 'media', stream_id: streamSid, media: { payload: payloadBase64 } });
    } else {
      sendToCaller({ event: 'media', streamSid, media: { payload: payloadBase64 } });
    }
  };

  const clearCallerAudio = () => {
    if (!streamSid) return;
    if (provider === 'telnyx') {
      sendToCaller({ event: 'clear', stream_id: streamSid });
    } else {
      sendToCaller({ event: 'clear', streamSid });
    }
  };

  const cleanup = () => {
    if (openAIWs) {
      openAIWs.close();
      openAIWs = null;
    }
  };

  // Finalize call - send transcript, duration, and usage metrics to update-call-log
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

    // Calculate estimated cost
    const estimatedCost = calculateCost(usageMetrics);
    
    // Get VAD stats
    const vadStats = localVAD?.getStats() || { received: 0, sent: 0, reductionPercent: 0 };

    console.log(`[TRACKING] Finalizing call ${callLogId}:`);
    console.log(`  Duration: ${duration}s, Messages: ${conversationTranscript.length}`);
    console.log(`  Tokens - Input: ${usageMetrics.inputTokens}, Output: ${usageMetrics.outputTokens}`);
    console.log(`  Audio Input: ${usageMetrics.audioInputTokens}, Audio Output: ${usageMetrics.audioOutputTokens}`);
    console.log(`  Text Input: ${usageMetrics.textInputTokens}, Text Output: ${usageMetrics.textOutputTokens}`);
    console.log(`  Estimated Cost: $${estimatedCost.toFixed(4)}`);
    console.log(`  VAD Reduction: ${vadStats.reductionPercent.toFixed(1)}% (${vadStats.sent}/${vadStats.received} chunks)`);

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
            input_tokens: usageMetrics.inputTokens,
            output_tokens: usageMetrics.outputTokens,
            audio_input_tokens: usageMetrics.audioInputTokens,
            audio_output_tokens: usageMetrics.audioOutputTokens,
            text_input_tokens: usageMetrics.textInputTokens,
            text_output_tokens: usageMetrics.textOutputTokens,
            estimated_cost: estimatedCost,
            vad_reduction_percent: vadStats.reductionPercent,
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

  const getElevenLabsVoiceId = () => {
    return agentConfig.elevenlabsVoiceId || "EXAVITQu4vr4xnSDxMaL";
  };

  async function streamElevenLabsSpeech(text: string): Promise<void> {
    const currentToken = ++twilioPlaybackToken;

    try {
      const voiceId = getElevenLabsVoiceId();
      console.log(`[ELEVENLABS] Starting streaming TTS for voice: ${voiceId}`);
      const ttsStartTime = Date.now();
      let firstChunkTime: number | null = null;

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
            model_id: "eleven_turbo_v2_5", // Force turbo model for lowest latency
            voice_settings: { stability: 0.4, similarity_boost: 0.7 },
          }),
        }
      );

      if (!response.ok || !response.body) {
        console.error("[ELEVENLABS] API error:", response.status);
        return;
      }

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      // Smaller chunk size = faster first audio (20ms of 8kHz audio)
      const CHUNK_SIZE = 160;
      let chunksSent = 0;

      while (true) {
        if (currentToken !== twilioPlaybackToken) {
          reader.cancel();
          console.log(`[ELEVENLABS] Cancelled (interrupted after ${chunksSent} chunks)`);
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          // Track time to first audio chunk
          if (!firstChunkTime) {
            firstChunkTime = Date.now();
            console.log(`[ELEVENLABS] First audio chunk in ${firstChunkTime - ttsStartTime}ms`);
          }

          // Append to buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer, 0);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;

          // Send chunks immediately as they arrive (no waiting for full buffer)
          while (buffer.length >= CHUNK_SIZE) {
            const chunk = buffer.slice(0, CHUNK_SIZE);
            buffer = buffer.slice(CHUNK_SIZE);

            if (streamSid && socket.readyState === WebSocket.OPEN) {
              sendAudioToCaller(base64Encode(chunk));
              chunksSent++;
            }
          }
        }
      }

      // Send remaining audio
      if (buffer.length > 0 && streamSid && socket.readyState === WebSocket.OPEN) {
        sendAudioToCaller(base64Encode(buffer));
        chunksSent++;
      }

      const totalTime = Date.now() - ttsStartTime;
      console.log(`[ELEVENLABS] TTS complete: ${chunksSent} chunks, ${totalTime}ms total, first audio at ${firstChunkTime ? firstChunkTime - ttsStartTime : 'N/A'}ms`);
    } catch (error) {
      console.error("[ELEVENLABS] Error:", error);
    }
  }

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data as string);

      switch (data.event) {
        case 'connected':
          console.log(`[${provider.toUpperCase()}] Connected`);
          break;

        case 'start':
          // Auto-detect provider based on Telnyx vs Twilio schemas
          // Telnyx: top-level stream_id + start.call_control_id
          // Twilio: start.streamSid + start.callSid
          if (typeof data.stream_id === 'string' || typeof data?.start?.call_control_id === 'string') {
            provider = 'telnyx';
            streamSid = (data.stream_id || data?.start?.stream_id || data?.start?.streamSid || null) as string | null;
            callSid = (data?.start?.call_control_id || data?.start?.callSid || null) as string | null;
          } else {
            provider = 'twilio';
            streamSid = (data?.start?.streamSid || null) as string | null;
            callSid = (data?.start?.callSid || null) as string | null;
          }
          
          // Initialize call tracking
          callStartTime = Date.now();
          // Twilio: customParameters; Telnyx: we pass callLogId in WS URL
          callLogId = callLogId || data?.start?.customParameters?.call_log_id || data?.start?.customParameters?.callLogId || null;
          conversationTranscript = [];
          usageMetrics = {
            inputTokens: 0,
            outputTokens: 0,
            audioInputTokens: 0,
            audioOutputTokens: 0,
            textInputTokens: 0,
            textOutputTokens: 0,
          };
          
          console.log(`[${provider.toUpperCase()}] Stream started - SID: ${streamSid}, Call: ${callSid}`);
          console.log(`[TRACKING] Call log ID: ${callLogId || 'none'}, Start time: ${new Date(callStartTime).toISOString()}`);

          const startAgentId = data?.start?.customParameters?.agent_id || data?.start?.customParameters?.agentId || null;
          const effectiveAgentId = (startAgentId || urlParams.agentId || "default").toString();
          console.log(`[AGENT] Loading config for: ${effectiveAgentId}`);

          agentConfig = await loadAgentConfig(effectiveAgentId);
          useElevenLabs = agentConfig.voiceProvider === "elevenlabs" || agentConfig.voiceProvider === "custom";
          console.log(`[TTS] Using ${useElevenLabs ? "ElevenLabs" : "OpenAI"}`);
          
          // Initialize local VAD with proper dB-based threshold
          localVAD = new LocalVAD({
            silenceThresholdDb: agentConfig.localVadThresholdDb,
            silenceDurationMs: agentConfig.localVadSilenceMs,
            prefixBufferMs: agentConfig.localVadPrefixMs,
          });
          console.log(`[VAD] Config: threshold=${agentConfig.localVadThresholdDb}dB, silence=${agentConfig.localVadSilenceMs}ms`);

          // Connect to OpenAI Realtime API using native Deno WebSocket
          const openAIUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
          openAIWs = new WebSocket(openAIUrl, [
            "realtime",
            `openai-insecure-api-key.${OPENAI_API_KEY}`,
            "openai-beta.realtime-v1",
          ]);

          openAIWs.onopen = () => {
            console.log(`[OPENAI] Connected`);

            // Build transcription config with optional prompt
            const transcriptionConfig: Record<string, unknown> = { 
              model: "whisper-1",
            };
            if (agentConfig.whisperLanguage && agentConfig.whisperLanguage !== 'auto') {
              transcriptionConfig.language = agentConfig.whisperLanguage;
            }
            if (agentConfig.whisperPrompt) {
              transcriptionConfig.prompt = agentConfig.whisperPrompt;
              console.log(`[WHISPER] Using prompt: "${agentConfig.whisperPrompt.substring(0, 50)}..."`);
            }

            // IMPORTANT: modalities is ["text"] for ElevenLabs to prevent audio_output_tokens
            const sessionConfig = {
              type: "session.update",
              session: {
                modalities: useElevenLabs ? ["text"] : ["text", "audio"],
                instructions: agentConfig.systemPrompt,
                voice: useElevenLabs ? "alloy" : agentConfig.voice,
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_transcription: transcriptionConfig,
                turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 },
              },
            };

            openAIWs?.send(JSON.stringify(sessionConfig));
            console.log(`[OPENAI] Session config sent (modalities: ${useElevenLabs ? '["text"]' : '["text", "audio"]'})`);
          };

          openAIWs.onmessage = (msg) => {
            try {
              const response = JSON.parse(msg.data as string);

              if (response.type === 'session.updated') {
                console.log(`[OPENAI] Session updated`);

                const greetingInstruction = agentConfig.greeting 
                  ? `Di exactamente este saludo, no agregues nada más: "${agentConfig.greeting}"`
                  : "Saluda al usuario de forma breve y amigable.";

                console.log(`[GREETING] ${agentConfig.greeting ? 'Using agent greeting' : 'Using default'}`);

                openAIWs?.send(JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: useElevenLabs ? ["text"] : ["text", "audio"],
                    instructions: greetingInstruction,
                  },
                }));
              } else if (response.type === 'response.audio.delta' && !useElevenLabs) {
                sendAudioToCaller(response.delta);
              } else if (response.type === 'response.text.delta' && useElevenLabs) {
                audioBuffer.push(response.delta);
              } else if (response.type === 'response.text.done') {
                // For ElevenLabs mode: capture agent transcript from text response
                if (useElevenLabs) {
                  const fullText = audioBuffer.join('');
                  audioBuffer = [];
                  if (fullText) {
                    conversationTranscript.push({ role: 'agent', text: fullText });
                    console.log(`[TRANSCRIPT] Agent (text): "${fullText.substring(0, 50)}..."`);
                    streamElevenLabsSpeech(fullText).catch(console.error);
                  }
                }
              } else if (response.type === 'response.done') {
                // CRITICAL: Capture usage metrics from response.done
                if (response.response?.usage) {
                  const usage = response.response.usage;
                  
                  usageMetrics.inputTokens += usage.input_tokens || 0;
                  usageMetrics.outputTokens += usage.output_tokens || 0;
                  
                  // Detailed token breakdown
                  if (usage.input_token_details) {
                    usageMetrics.audioInputTokens += usage.input_token_details.audio_tokens || 0;
                    usageMetrics.textInputTokens += usage.input_token_details.text_tokens || 0;
                  }
                  if (usage.output_token_details) {
                    usageMetrics.audioOutputTokens += usage.output_token_details.audio_tokens || 0;
                    usageMetrics.textOutputTokens += usage.output_token_details.text_tokens || 0;
                  }
                  
                  console.log(`[USAGE] Input: ${usage.input_tokens} (audio: ${usage.input_token_details?.audio_tokens || 0}, text: ${usage.input_token_details?.text_tokens || 0})`);
                  console.log(`[USAGE] Output: ${usage.output_tokens} (audio: ${usage.output_token_details?.audio_tokens || 0}, text: ${usage.output_token_details?.text_tokens || 0})`);
                }
                
                // Fallback for any remaining audio buffer
                if (useElevenLabs && audioBuffer.length > 0) {
                  const fullText = audioBuffer.join('');
                  audioBuffer = [];
                  console.log(`[OPENAI] Remaining text: "${fullText.substring(0, 80)}..."`);
                  streamElevenLabsSpeech(fullText).catch(console.error);
                }
              } else if (response.type === 'conversation.item.input_audio_transcription.completed') {
                // User speech transcription (correct event name from OpenAI Realtime API)
                if (response.transcript) {
                  conversationTranscript.push({ role: 'user', text: response.transcript });
                  console.log(`[TRANSCRIPT] User: "${response.transcript.substring(0, 50)}..."`);
                }
              } else if (response.type === 'input_audio_transcription.completed') {
                // Fallback for alternative event name
                if (response.transcript) {
                  conversationTranscript.push({ role: 'user', text: response.transcript });
                  console.log(`[TRANSCRIPT] User (alt): "${response.transcript.substring(0, 50)}..."`);
                }
              } else if (response.type === 'response.audio_transcript.done') {
                // Agent response transcription
                if (response.transcript) {
                  conversationTranscript.push({ role: 'agent', text: response.transcript });
                  console.log(`[TRANSCRIPT] Agent: "${response.transcript.substring(0, 50)}..."`);
                }
              } else if (response.type === 'input_audio_buffer.speech_started') {
                console.log("[VAD] User speaking (OpenAI VAD)");
                twilioPlaybackToken++;
                audioBuffer = [];
                clearCallerAudio();
              } else if (response.type === 'error') {
                console.error("[OPENAI] Error:", response.error);
              }
            } catch (e) {
              console.error("[OPENAI] Message error:", e);
            }
          };

          openAIWs.onerror = (error) => console.error("[OPENAI] WebSocket error:", error);
          openAIWs.onclose = () => console.log(`[OPENAI] WebSocket closed`);
          break;

        case 'media':
          if (openAIWs && openAIWs.readyState === WebSocket.OPEN && localVAD) {
            // LOCAL VAD: Filter audio before sending to OpenAI
            const vadResult = localVAD.processChunk(data.media.payload);
            
            if (vadResult.shouldSend) {
              for (const chunk of vadResult.chunks) {
                openAIWs.send(JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: chunk,
                }));
              }
            }
            // If !shouldSend, audio is silence and is filtered out
          } else if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
            // Fallback: no local VAD, send all audio
            openAIWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload,
            }));
          }
          break;

        case 'stop':
          console.log(`[${provider.toUpperCase()}] Stream stopped`);
          
          // Log final usage summary
          const cost = calculateCost(usageMetrics);
          console.log(`[USAGE SUMMARY]`);
          console.log(`  Total Input Tokens: ${usageMetrics.inputTokens}`);
          console.log(`  Total Output Tokens: ${usageMetrics.outputTokens}`);
          console.log(`  Audio Input Tokens: ${usageMetrics.audioInputTokens}`);
          console.log(`  Audio Output Tokens: ${usageMetrics.audioOutputTokens} ${usageMetrics.audioOutputTokens === 0 ? '✅' : '⚠️'}`);
          console.log(`  Text Input Tokens: ${usageMetrics.textInputTokens}`);
          console.log(`  Text Output Tokens: ${usageMetrics.textOutputTokens}`);
          console.log(`  Estimated Cost: $${cost.toFixed(4)}`);
          
          if (localVAD) {
            const stats = localVAD.getStats();
            console.log(`[VAD SUMMARY] Chunks: ${stats.sent}/${stats.received} (${stats.reductionPercent.toFixed(1)}% filtered)`);
          }
          
          await finalizeCall();
          cleanup();
          break;
      }
    } catch (error) {
      console.error(`[${provider.toUpperCase()}] Message error:`, error);
    }
  };

  socket.onerror = (error) => console.error(`[${provider.toUpperCase()}] WebSocket error:`, error);
  socket.onclose = () => { console.log(`[${provider.toUpperCase()}] WebSocket closed`); cleanup(); };
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", version: "5.0.0" }), { headers: { "Content-Type": "application/json" } });
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

  return new Response("Realtime Relay Server v5.0.0", { status: 200 });
});

console.log(`✅ Realtime Relay Server v5.0.0 running on port ${PORT}`);

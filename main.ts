/**
 * Railway Relay Server for Multi-Provider Voice Support
 * 
 * This server acts as a bridge between:
 * - Twilio/Telnyx/Other providers (incoming phone calls via WebSocket)
 * - OpenAI Realtime API (speech-to-text and reasoning)
 * - ElevenLabs (high-quality text-to-speech)
 * 
 * Features:
 * - Multi-provider support (auto-detects Twilio, Telnyx, etc.)
 * - Real-time transcription capture (user + agent)
 * - Call duration tracking
 * - Automatic call log updates via backend API
 * 
 * Flow:
 * 1. Provider sends audio stream via WebSocket
 * 2. Audio is forwarded to OpenAI for STT and processing
 * 3. If using ElevenLabs: OpenAI returns text -> ElevenLabs TTS -> audio to provider
 * 4. If using OpenAI voices: OpenAI returns audio directly -> provider
 * 5. On call end: Report duration and transcript to backend
 */

import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";

// Environment variables
// NOTE: avoid non-null assertions for optional integrations to prevent relay crashes.
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const RELAY_SHARED_SECRET = Deno.env.get("RELAY_SHARED_SECRET") || "";
const PORT = parseInt(Deno.env.get("PORT") || "8080");

if (!OPENAI_API_KEY) {
  console.error("[Relay] Missing OPENAI_API_KEY – relay cannot start properly.");
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("[Relay] Missing SUPABASE_URL or SUPABASE_ANON_KEY – agent loading will fail.");
}

if (!RELAY_SHARED_SECRET) {
  console.warn("[Relay] Missing RELAY_SHARED_SECRET – call log updates may fail.");
}

// OpenAI Realtime API configuration
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

// Deno WebSocket helper: OpenAI requires Authorization headers, so we must use Deno.connectWebSocket
async function connectOpenAIRealtime(): Promise<WebSocket> {
  const { socket, response } = await Deno.connectWebSocket({
    url: OPENAI_REALTIME_URL,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  if (response.status !== 101) {
    const body = await response.text().catch(() => "");
    throw new Error(`[OpenAI] WebSocket upgrade failed: ${response.status} ${body}`);
  }

  return socket;
}

// Supported providers
type Provider = "twilio" | "telnyx" | "unknown";

// Agent configuration interface
interface AgentConfig {
  id: string;
  name: string;
  voice: string;
  voice_provider: "openai" | "elevenlabs" | "custom";
  elevenlabs_voice_id: string | null;
  elevenlabs_model: string | null;
  system_prompt: string | null;
  greeting: string | null;
  temperature: number | null;
  vad_threshold: number | null;
  silence_duration_ms: number | null;
  prefix_padding_ms: number | null;
}

// Transcript message interface
interface TranscriptMessage {
  role: "user" | "agent";
  content: string;
  timestamp: number;
}

// Provider-specific message formats
interface ProviderMessage {
  provider: Provider;
  event: string;
  streamId: string;
  audioPayload?: string;
  customParams?: Record<string, string>;
}

// Load agent configuration via secure Edge Function proxy (bypasses RLS)
async function loadAgentConfig(agentId: string): Promise<AgentConfig | null> {
  if (!SUPABASE_URL || !RELAY_SHARED_SECRET) {
    console.error("[Relay] Cannot load agent: missing SUPABASE_URL or RELAY_SHARED_SECRET");
    return null;
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/relay-agent-config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-relay-secret": RELAY_SHARED_SECRET,
      },
      body: JSON.stringify({ agentId }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("[Relay] Agent config fetch failed:", response.status, errorData);
      return null;
    }

    const data = await response.json();
    console.log("[Relay] Loaded agent via proxy:", data.name);

    // Map the Edge Function response to our AgentConfig interface
    return {
      id: data.id,
      name: data.name,
      voice: data.voice,
      voice_provider: data.voiceProvider,
      elevenlabs_voice_id: data.elevenlabsVoiceId,
      elevenlabs_model: data.elevenlabsModel,
      system_prompt: data.systemPrompt,
      greeting: data.greeting,
      temperature: data.temperature,
      vad_threshold: data.vadThreshold,
      silence_duration_ms: data.silenceDurationMs,
      prefix_padding_ms: data.prefixPaddingMs,
    };
  } catch (error) {
    console.error("[Relay] Error loading agent config:", error);
    return null;
  }
}

// Update call log via backend function
async function updateCallLog(
  callLogId: string,
  durationSeconds: number,
  transcript: TranscriptMessage[],
  status: string
): Promise<void> {
  if (!callLogId) {
    console.warn("[Relay] No call_log_id provided, skipping update");
    return;
  }

  try {
    // Format transcript as readable text
    const formattedTranscript = transcript
      .map(msg => `[${msg.role.toUpperCase()}]: ${msg.content}`)
      .join("\n");

    const response = await fetch(`${SUPABASE_URL}/functions/v1/update-call-log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RELAY_SHARED_SECRET}`,
      },
      body: JSON.stringify({
        call_log_id: callLogId,
        duration_seconds: durationSeconds,
        transcript: formattedTranscript,
        status: status,
        ended_at: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[Relay] Failed to update call log:", error);
    } else {
      const result = await response.json();
      console.log("[Relay] Call log updated:", result);
    }
  } catch (error) {
    console.error("[Relay] Error updating call log:", error);
  }
}

// Stream ElevenLabs TTS audio to provider
async function streamElevenLabsSpeech(
  text: string,
  voiceId: string,
  model: string,
  providerSocket: WebSocket,
  streamId: string,
  provider: Provider
): Promise<void> {
  if (!ELEVENLABS_API_KEY) {
    console.error("[ElevenLabs] ELEVENLABS_API_KEY is not set; cannot synthesize speech.");
    return;
  }
  console.log(`[ElevenLabs] Generating speech for: "${text.substring(0, 50)}..."`);
  
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    }
  );

  if (!response.ok) {
    console.error("[ElevenLabs] TTS request failed:", await response.text());
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) return;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Format media message based on provider
      const mediaMessage = formatMediaMessage(provider, streamId, base64Encode(value));

      if (providerSocket.readyState === WebSocket.OPEN) {
        providerSocket.send(mediaMessage);
      }
    }
  } catch (error) {
    console.error("[ElevenLabs] Stream error:", error);
  }
}

// Format media message for specific provider
function formatMediaMessage(provider: Provider, streamId: string, payload: string): string {
  if (provider === "telnyx") {
    // Telnyx format
    return JSON.stringify({
      event: "media",
      stream_id: streamId,
      media: {
        payload: payload,
      },
    });
  }
  // Default: Twilio format
  return JSON.stringify({
    event: "media",
    streamSid: streamId,
    media: {
      payload: payload,
    },
  });
}

// Parse incoming message and detect provider
function parseProviderMessage(data: unknown): ProviderMessage {
  const parsed = data as Record<string, unknown>;
  
  // Telnyx format detection
  if (parsed.stream_id || parsed.call_control_id) {
    const event = parsed.event as string || "unknown";
    const streamId = parsed.stream_id as string || "";
    const media = parsed.media as Record<string, string> | undefined;
    
    // Get custom params from start event
    const startData = parsed.start as Record<string, unknown> | undefined;
    const customParams = startData?.customParameters as Record<string, string> || {};
    
    return {
      provider: "telnyx",
      event: event,
      streamId: streamId,
      audioPayload: media?.payload,
      customParams,
    };
  }
  
  // Twilio format (default)
  const event = parsed.event as string || "unknown";
  const startData = parsed.start as Record<string, unknown> | undefined;
  const streamSid = startData?.streamSid as string || "";
  const media = parsed.media as Record<string, string> | undefined;
  const customParams = startData?.customParameters as Record<string, string> || {};
  
  return {
    provider: "twilio",
    event: event,
    streamId: streamSid,
    audioPayload: media?.payload,
    customParams,
  };
}

// Handle WebSocket connection from any provider
async function handleProviderConnection(
  providerSocket: WebSocket,
  initialAgentId: string | null,
  initialCallLogId: string | null,
  initialProvider: Provider
): Promise<void> {
  console.log(`[Relay] New connection, agentId: ${initialAgentId}, callLogId: ${initialCallLogId}, provider: ${initialProvider}`);

  let agentId = initialAgentId;
  let callLogId = initialCallLogId;
  let provider = initialProvider;
  let agentConfig: AgentConfig | null = null;
  let openAISocket: WebSocket | null = null;
  let streamId = "";
  let audioBuffer: string[] = [];

  // Call tracking
  let callStartTime: number | null = null;
  const transcriptMessages: TranscriptMessage[] = [];

  // Determine if using ElevenLabs (will be set after agent loads)
  let useElevenLabs = false;
  let elevenLabsVoiceId = "JBFqnCBsd6RMkjVDRZzb";
  let elevenLabsModel = "eleven_turbo_v2_5";

  // Function to finalize call and update backend
  const finalizeCall = async (status: string = "completed") => {
    if (!callStartTime) {
      console.warn("[Relay] Call never started, skipping finalization");
      return;
    }

    const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
    console.log(`[Relay] Finalizing call - Duration: ${durationSeconds}s, Messages: ${transcriptMessages.length}`);

    await updateCallLog(callLogId || "", durationSeconds, transcriptMessages, status);
  };

  // Function to initialize OpenAI connection after agent is loaded
  const initializeOpenAI = async () => {
    if (!agentConfig) return;

    const wantsElevenLabs = agentConfig.voice_provider === "elevenlabs" || agentConfig.voice_provider === "custom";
    // If ElevenLabs is configured on the agent but the relay is missing the API key,
    // fall back to OpenAI audio so calls don't hard-fail.
    useElevenLabs = wantsElevenLabs && Boolean(ELEVENLABS_API_KEY);
    elevenLabsVoiceId = agentConfig.elevenlabs_voice_id || "JBFqnCBsd6RMkjVDRZzb";
    elevenLabsModel = agentConfig.elevenlabs_model || "eleven_turbo_v2_5";

    if (wantsElevenLabs && !ELEVENLABS_API_KEY) {
      console.warn(
        "[Relay] Agent is set to ElevenLabs/custom but ELEVENLABS_API_KEY is missing in Railway. Falling back to OpenAI audio."
      );
    }

    console.log(`[Relay] Agent loaded: ${agentConfig.name}, provider: ${agentConfig.voice_provider}`);

    // Connect to OpenAI Realtime API
    if (!OPENAI_API_KEY) {
      console.error("[Relay] Cannot connect to OpenAI Realtime: OPENAI_API_KEY missing");
      return;
    }

    try {
      openAISocket = await connectOpenAIRealtime();
    } catch (err) {
      console.error("[OpenAI] Failed to connect:", err);
      return;
    }

    // Handle OpenAI connection
    openAISocket.onopen = () => {
      console.log("[OpenAI] Connected");

      // Configure session based on voice provider
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: useElevenLabs ? ["text"] : ["text", "audio"],
          instructions: agentConfig!.system_prompt || "You are a helpful assistant.",
          voice: useElevenLabs ? "alloy" : agentConfig!.voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "whisper-1",
          },
          turn_detection: {
            type: "server_vad",
            threshold: agentConfig!.vad_threshold ?? 0.6,
            prefix_padding_ms: agentConfig!.prefix_padding_ms ?? 400,
            silence_duration_ms: agentConfig!.silence_duration_ms ?? 800,
          },
          temperature: agentConfig!.temperature ?? 0.8,
        },
      };

      openAISocket!.send(JSON.stringify(sessionConfig));
      console.log(`[OpenAI] Session configured, modalities: ${useElevenLabs ? "text" : "text+audio"}`);

      // Send greeting immediately after session is configured
      if (agentConfig!.greeting && streamId) {
        sendGreeting();
      }
    };

    // Handle OpenAI messages
    openAISocket.onmessage = async (event) => {
      const data = JSON.parse(event.data as string);

      switch (data.type) {
        case "session.created":
          console.log("[OpenAI] Session created");
          break;

        case "session.updated":
          console.log("[OpenAI] Session updated");
          // Send greeting after session is properly configured
          if (agentConfig!.greeting && streamId) {
            sendGreeting();
          }
          break;

        // Capture user transcription
        case "conversation.item.input_audio_transcription.completed":
          if (data.transcript) {
            console.log("[Transcript] User:", data.transcript);
            transcriptMessages.push({
              role: "user",
              content: data.transcript,
              timestamp: Date.now(),
            });
          }
          break;

        // Capture agent transcription (for audio responses)
        case "response.audio_transcript.done":
          if (data.transcript) {
            console.log("[Transcript] Agent:", data.transcript);
            transcriptMessages.push({
              role: "agent",
              content: data.transcript,
              timestamp: Date.now(),
            });
          }
          break;

        case "response.text.delta":
          // Accumulate text for ElevenLabs
          if (useElevenLabs && data.delta) {
            audioBuffer.push(data.delta);
          }
          break;

        case "response.text.done":
          // Capture agent text response and convert to speech via ElevenLabs
          if (useElevenLabs && audioBuffer.length > 0) {
            const fullText = audioBuffer.join("");
            audioBuffer = [];

            // Add to transcript
            console.log("[Transcript] Agent:", fullText);
            transcriptMessages.push({
              role: "agent",
              content: fullText,
              timestamp: Date.now(),
            });

            await streamElevenLabsSpeech(
              fullText,
              elevenLabsVoiceId,
              elevenLabsModel,
              providerSocket,
              streamId,
              provider
            );
          }
          break;

        case "response.audio.delta":
          // Send OpenAI audio directly to provider (when not using ElevenLabs)
          if (!useElevenLabs && data.delta && streamId) {
            const mediaMessage = formatMediaMessage(provider, streamId, data.delta);

            if (providerSocket.readyState === WebSocket.OPEN) {
              providerSocket.send(mediaMessage);
            }
          }
          break;

        case "error":
          console.error("[OpenAI] Error:", data.error);
          break;

        default:
          // Log transcript events for debugging
          if (data.type.includes("transcript")) {
            console.log(`[OpenAI] ${data.type}:`, data.transcript || data);
          }
      }
    };

    openAISocket.onerror = (error) => {
      console.error("[OpenAI] WebSocket error:", error);
    };

    openAISocket.onclose = () => {
      console.log("[OpenAI] Connection closed");
    };
  };

  // Function to send greeting
  const sendGreeting = async () => {
    if (!agentConfig?.greeting || !streamId) return;
    
    console.log("[Relay] Sending greeting...");

    // Add greeting to transcript
    transcriptMessages.push({
      role: "agent",
      content: agentConfig.greeting,
      timestamp: Date.now(),
    });
    
    if (useElevenLabs) {
      await streamElevenLabsSpeech(
        agentConfig.greeting,
        elevenLabsVoiceId,
        elevenLabsModel,
        providerSocket,
        streamId,
        provider
      );
    } else if (openAISocket && openAISocket.readyState === WebSocket.OPEN) {
      const greetingEvent = {
        type: "response.create",
        response: {
          modalities: ["text", "audio"],
          instructions: `Say exactly this greeting, do not add anything else: "${agentConfig.greeting}"`,
        },
      };
      openAISocket.send(JSON.stringify(greetingEvent));
    }
  };

  // Handle provider messages (multi-provider support)
  providerSocket.onmessage = async (event) => {
    const rawData = JSON.parse(event.data as string);
    const msg = parseProviderMessage(rawData);
    
    // Auto-detect provider from message format if not set
    if (provider === "unknown") {
      provider = msg.provider;
      console.log(`[Relay] Auto-detected provider: ${provider}`);
    }

    switch (msg.event) {
      case "connected":
        console.log(`[${provider}] Stream connected`);
        break;

      case "start":
        // Handle start event - format differs by provider
        if (provider === "telnyx") {
          // Telnyx format
          streamId = rawData.stream_id || rawData.start?.stream_id || "";
          const telnyxParams = rawData.start?.customParameters || rawData.custom_parameters || {};
          if (telnyxParams.agent_id) agentId = telnyxParams.agent_id;
          if (telnyxParams.call_log_id) callLogId = telnyxParams.call_log_id;
          console.log(`[Telnyx] Stream started: ${streamId}`);
        } else {
          // Twilio format (default)
          streamId = rawData.start?.streamSid || "";
          const twilioParams = rawData.start?.customParameters || {};
          if (twilioParams.agent_id) agentId = twilioParams.agent_id;
          if (twilioParams.call_log_id) callLogId = twilioParams.call_log_id;
          console.log(`[Twilio] Stream started: ${streamId}`);
        }
        
        callStartTime = Date.now();
        console.log(`[Relay] Agent ID: ${agentId}, Call Log ID: ${callLogId}`);
        
        // Load agent config if we have an agentId
        if (agentId) {
          agentConfig = await loadAgentConfig(agentId);
          if (agentConfig) {
            console.log(`[Relay] Agent loaded: ${agentConfig.name}`);
            await initializeOpenAI();
          } else {
            console.error("[Relay] Agent not found:", agentId);
          }
        } else {
          console.error("[Relay] No agent_id provided");
        }
        break;

      case "media":
        // Forward audio to OpenAI - payload location may differ
        const audioPayload = rawData.media?.payload || msg.audioPayload;
        if (openAISocket && openAISocket.readyState === WebSocket.OPEN && audioPayload) {
          const audioEvent = {
            type: "input_audio_buffer.append",
            audio: audioPayload,
          };
          openAISocket.send(JSON.stringify(audioEvent));
        }
        break;

      case "stop":
        console.log(`[${provider}] Stream stopped`);
        // Finalize and report call data
        await finalizeCall("completed");
        if (openAISocket) openAISocket.close();
        break;
    }
  };

  providerSocket.onclose = async () => {
    console.log(`[${provider}] Connection closed`);
    // Finalize call if not already done
    if (callStartTime && transcriptMessages.length > 0) {
      await finalizeCall("completed");
    }
    if (openAISocket) openAISocket.close();
  };

  providerSocket.onerror = async (error) => {
    console.error(`[${provider}] WebSocket error:`, error);
    // Mark call as failed
    await finalizeCall("failed");
    if (openAISocket) openAISocket.close();
  };
}

// Main HTTP server
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Handle WebSocket upgrade for provider streams
  if (request.headers.get("upgrade") === "websocket") {
    // Parameters may come from URL or from provider start event
    const agentId = url.searchParams.get("agentId");
    const callLogId = url.searchParams.get("callLogId");
    const providerParam = url.searchParams.get("provider") as Provider || "unknown";
    
    console.log(`[Relay] WebSocket upgrade, agentId: ${agentId}, callLogId: ${callLogId}, provider: ${providerParam}`);

    const { socket, response } = Deno.upgradeWebSocket(request);
    handleProviderConnection(socket, agentId, callLogId, providerParam);
    return response;
  }

  // Health check endpoint
  if (url.pathname === "/health" || url.pathname === "/") {
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "realtime-relay",
        version: "3.0.0",
        features: ["multi-provider", "transcription", "duration-tracking", "call-logging"],
        providers: ["twilio", "telnyx"],
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response("Not found", { status: 404 });
}

// Start server
console.log(`[Relay] Starting server on port ${PORT}...`);
console.log(`[Relay] Features: multi-provider support (Twilio, Telnyx), transcription, duration tracking, call logging`);
Deno.serve({ port: PORT }, handleRequest);

import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

// Load environment variables
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const RELAY_SHARED_SECRET = Deno.env.get("RELAY_SHARED_SECRET");

const PORT = parseInt(Deno.env.get("PORT") || "8080");

console.log(`🚀 Realtime Relay Server v4.1.0 starting on port ${PORT}...`);

async function loadAgentConfig(agentId: string) {
  const defaultConfig = {
    systemPrompt: "You are a helpful AI assistant for phone calls. Respond in Spanish. Be concise and helpful.",
    voice: "alloy",
    voiceProvider: "openai",
    elevenlabsVoiceId: null as string | null,
    elevenlabsModel: "eleven_turbo_v2_5",
    name: "Asistente Virtual",
    greeting: null as string | null,
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

    return {
      systemPrompt: data.systemPrompt || defaultConfig.systemPrompt,
      voice: data.voice || "alloy",
      voiceProvider: data.voiceProvider || "openai",
      elevenlabsVoiceId: data.elevenlabsVoiceId,
      elevenlabsModel: data.elevenlabsModel || "eleven_turbo_v2_5",
      name: data.name || defaultConfig.name,
      greeting: data.greeting || null,
    };
  } catch (e) {
    console.error("[AGENT] Error fetching agent config:", e);
    return defaultConfig;
  }
}

function handleWebSocket(socket: WebSocket, urlAgentId: string | null) {
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
  };
  let useElevenLabs = false;
  let audioBuffer: string[] = [];
  let twilioPlaybackToken = 0;
  
  // Call tracking variables
  let callStartTime: number | null = null;
  let callLogId: string | null = null;
  let conversationTranscript: { role: string; text: string }[] = [];
  
  // Multi-provider support
  let provider: 'twilio' | 'telnyx' = 'twilio';

  const cleanup = () => {
    if (openAIWs) {
      openAIWs.close();
      openAIWs = null;
    }
  };

  // Finalize call - send transcript and duration to update-call-log
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

    console.log(`[TRACKING] Finalizing call ${callLogId}: ${duration}s, ${conversationTranscript.length} messages`);

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
      console.log(`[ELEVENLABS] Starting TTS for voice: ${voiceId}`);

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: agentConfig.elevenlabsModel,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (!response.ok || !response.body) {
        console.error("[ELEVENLABS] API error:", response.status);
        return;
      }

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      const CHUNK_SIZE = 160;

      while (true) {
        if (currentToken !== twilioPlaybackToken) {
          reader.cancel();
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer, 0);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;
        }

        while (buffer.length >= CHUNK_SIZE) {
          const chunk = buffer.slice(0, CHUNK_SIZE);
          buffer = buffer.slice(CHUNK_SIZE);

          if (streamSid && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: base64Encode(chunk) },
            }));
          }
        }
      }

      if (buffer.length > 0 && streamSid && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: base64Encode(buffer) },
        }));
      }

      console.log(`[ELEVENLABS] TTS complete`);
    } catch (error) {
      console.error("[ELEVENLABS] Error:", error);
    }
  }

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data as string);

      switch (data.event) {
        case 'connected':
          console.log(`[TWILIO] Connected`);
          break;

        case 'start':
          // Auto-detect provider based on field names
          if (data.start?.stream_id) {
            provider = 'telnyx';
            streamSid = data.start.stream_id;
            callSid = data.start.call_control_id;
          } else {
            provider = 'twilio';
            streamSid = data.start.streamSid;
            callSid = data.start.callSid;
          }
          
          // Initialize call tracking
          callStartTime = Date.now();
          callLogId = data?.start?.customParameters?.call_log_id || null;
          conversationTranscript = [];
          
          console.log(`[${provider.toUpperCase()}] Stream started - SID: ${streamSid}, Call: ${callSid}`);
          console.log(`[TRACKING] Call log ID: ${callLogId || 'none'}, Start time: ${new Date(callStartTime).toISOString()}`);

          const startAgentId = data?.start?.customParameters?.agent_id || null;
          const effectiveAgentId = (startAgentId || urlAgentId || "default").toString();
          console.log(`[AGENT] Loading config for: ${effectiveAgentId}`);

          agentConfig = await loadAgentConfig(effectiveAgentId);
          useElevenLabs = agentConfig.voiceProvider === "elevenlabs" || agentConfig.voiceProvider === "custom";
          console.log(`[TTS] Using ${useElevenLabs ? "ElevenLabs" : "OpenAI"}`);

          // Connect to OpenAI Realtime API using native Deno WebSocket
          const openAIUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
          openAIWs = new WebSocket(openAIUrl, [
            "realtime",
            `openai-insecure-api-key.${OPENAI_API_KEY}`,
            "openai-beta.realtime-v1",
          ]);

          openAIWs.onopen = () => {
            console.log(`[OPENAI] Connected`);

            const sessionConfig = {
              type: "session.update",
              session: {
                modalities: useElevenLabs ? ["text"] : ["text", "audio"],
                instructions: agentConfig.systemPrompt,
                voice: useElevenLabs ? "alloy" : agentConfig.voice,
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800 },
              },
            };

            openAIWs?.send(JSON.stringify(sessionConfig));
            console.log(`[OPENAI] Session config sent`);
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
                if (streamSid && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: response.delta },
                  }));
                }
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
                console.log("[VAD] User speaking");
                twilioPlaybackToken++;
                audioBuffer = [];
                if (streamSid && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ event: 'clear', streamSid }));
                }
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
          if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
            openAIWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload,
            }));
          }
          break;

        case 'stop':
          console.log(`[${provider.toUpperCase()}] Stream stopped`);
          await finalizeCall();
          cleanup();
          break;
      }
    } catch (error) {
      console.error("[TWILIO] Message error:", error);
    }
  };

  socket.onerror = (error) => console.error("[TWILIO] WebSocket error:", error);
  socket.onclose = () => { console.log(`[TWILIO] WebSocket closed`); cleanup(); };
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", version: "4.1.0" }), { headers: { "Content-Type": "application/json" } });
  }

  if (upgradeHeader.toLowerCase() === "websocket") {
    const urlAgentId = url.searchParams.get('agentId');
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWebSocket(socket, urlAgentId);
    return response;
  }

  return new Response("Realtime Relay Server v4.1.0", { status: 200 });
});

console.log(`✅ Realtime Relay Server v4.1.0 running on port ${PORT}`);

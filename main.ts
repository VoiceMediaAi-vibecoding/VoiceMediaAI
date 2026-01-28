import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

// Load environment variables
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");

const PORT = parseInt(Deno.env.get("PORT") || "8080");

console.log(`🚀 Realtime Relay Server starting on port ${PORT}...`);
console.log(`[CONFIG] SUPABASE_URL: ${SUPABASE_URL}`);
console.log(`[CONFIG] SUPABASE_KEY exists: ${!!SUPABASE_KEY}`);
console.log(`[CONFIG] Using Service Role: ${!!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`);

async function loadAgentConfig(agentId: string) {
  const defaultConfig = {
    systemPrompt: "You are a helpful AI assistant for phone calls. Respond in Spanish. Be concise and helpful.",
    voice: "alloy",
    voiceProvider: "openai",
    customVoiceId: null as string | null,
    language: "es-ES",
    name: "Asistente Virtual",
    greeting: null as string | null,
  };

  try {
    const url = `${SUPABASE_URL}/rest/v1/agents?id=eq.${agentId}&select=*`;
    console.log(`[AGENT_FETCH] URL: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY!,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    
    const raw = await response.text();
    console.log(`[AGENT_FETCH] Status: ${response.status}`);
    console.log(`[AGENT_FETCH] Response: ${raw.substring(0, 500)}`);
    
    const agents = JSON.parse(raw);
    const agent = agents[0];
    
    if (!agent) {
      console.log(`[AGENT] No agent found with ID ${agentId}, using defaults`);
      return defaultConfig;
    }

    console.log(`✅ Loaded agent: ${agent.name} (${agent.id})`);
    console.log(`   Voice Provider: ${agent.voice_provider}, Voice: ${agent.voice}`);
    console.log(`   ElevenLabs Voice ID: ${agent.elevenlabs_voice_id}`);
    console.log(`   Greeting: ${agent.greeting?.substring(0, 80)}...`);

    return {
      systemPrompt: agent.system_prompt || defaultConfig.systemPrompt,
      voice: agent.voice || "alloy",
      voiceProvider: agent.voice_provider || "openai",
      customVoiceId: agent.elevenlabs_voice_id,
      language: agent.language || "es-ES",
      name: agent.name || defaultConfig.name,
      greeting: agent.greeting || null,
    };
  } catch (e) {
    console.error("[AGENT] Error fetching agent config:", e);
    return defaultConfig;
  }
}

function handleWebSocket(socket: WebSocket, urlAgentId: string | null) {
  console.log(`[CONNECTION] New WebSocket connection (urlAgentId: ${urlAgentId ?? 'none'})`);

  let openAIWs: WebSocket | null = null;
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let currentAgentId: string | null = null;
  let agentConfig = {
    systemPrompt: "",
    voice: "alloy",
    voiceProvider: "openai",
    customVoiceId: null as string | null,
    language: "es-ES",
    name: "Asistente",
    greeting: null as string | null,
  };
  let useElevenLabs = false;
  let audioBuffer: string[] = [];
  let twilioPlaybackToken = 0;
  let callStartTime: number | null = null;
  let responseStartTime: number | null = null;

  const cleanup = () => {
    if (openAIWs) {
      openAIWs.close();
      openAIWs = null;
    }
  };

  const getElevenLabsVoiceId = () => {
    if (agentConfig.voiceProvider === "custom" || agentConfig.voiceProvider === "elevenlabs") {
      return agentConfig.customVoiceId;
    }
    return agentConfig.voice;
  };

  async function streamElevenLabsSpeech(text: string): Promise<void> {
    const currentToken = ++twilioPlaybackToken;
    const startTime = performance.now();

    try {
      const voiceId = getElevenLabsVoiceId() || "EXAVITQu4vr4xnSDxMaL";
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
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (!response.ok || !response.body) {
        console.error(`[ELEVENLABS] API error: ${response.status}`);
        return;
      }

      console.log(`[ELEVENLABS] API response in ${Math.round(performance.now() - startTime)}ms`);

      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      const CHUNK_SIZE = 160;
      let chunksSent = 0;

      while (true) {
        if (currentToken !== twilioPlaybackToken) {
          console.log("[ELEVENLABS] Cancelled due to interruption");
          reader.cancel();
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;

        while (buffer.length >= CHUNK_SIZE) {
          if (currentToken !== twilioPlaybackToken) {
            reader.cancel();
            return;
          }

          const chunk = buffer.slice(0, CHUNK_SIZE);
          buffer = buffer.slice(CHUNK_SIZE);

          if (streamSid && socket.readyState === WebSocket.OPEN) {
            const base64Chunk = base64Encode(chunk);
            socket.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: base64Chunk },
            }));
            chunksSent++;
          }
        }
      }

      if (buffer.length > 0 && currentToken === twilioPlaybackToken && streamSid && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: base64Encode(buffer) },
        }));
        chunksSent++;
      }

      console.log(`[ELEVENLABS] Complete: ${chunksSent} chunks in ${(performance.now() - startTime).toFixed(0)}ms`);
    } catch (error) {
      console.error("[ELEVENLABS] Error:", error);
    }
  }

  socket.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.event) {
        case 'connected':
          console.log("[TWILIO] Stream connected");
          break;

        case 'start':
          streamSid = data.start.streamSid;
          callSid = data.start.callSid;
          callStartTime = performance.now();
          console.log(`[TWILIO] Stream started - SID: ${streamSid}, Call: ${callSid}`);

          // Get agent ID from custom parameters (Twilio sends as agent_id)
          const startAgentId = data?.start?.customParameters?.agent_id || null;
          const effectiveAgentId = (startAgentId || urlAgentId || "default").toString();
          currentAgentId = effectiveAgentId !== "default" ? effectiveAgentId : null;
          console.log(`[AGENT] Loading config for: ${effectiveAgentId}`);

          agentConfig = await loadAgentConfig(effectiveAgentId);
          useElevenLabs = agentConfig.voiceProvider === "elevenlabs" || agentConfig.voiceProvider === "custom";
          console.log(`[TTS] Using ${useElevenLabs ? "ElevenLabs" : "OpenAI"}`);

          // Connect to OpenAI Realtime API
          const openAIUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
          openAIWs = new WebSocket(openAIUrl, [
            "realtime",
            `openai-insecure-api-key.${OPENAI_API_KEY}`,
            "openai-beta.realtime-v1"
          ]);

          openAIWs.onopen = () => {
            console.log(`[OPENAI] Connected in ${Math.round(performance.now() - callStartTime!)}ms`);

            const modalitiesConfig = useElevenLabs ? ["text"] : ["text", "audio"];
            const sessionConfig = {
              type: "session.update",
              session: {
                modalities: modalitiesConfig,
                instructions: agentConfig.systemPrompt,
                voice: useElevenLabs ? "alloy" : agentConfig.voice,
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_transcription: { model: "whisper-1" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.6,
                  prefix_padding_ms: 400,
                  silence_duration_ms: 800
                }
              }
            };
            openAIWs?.send(JSON.stringify(sessionConfig));
            console.log("[OPENAI] Session config sent");
          };

          openAIWs.onmessage = async (e) => {
            try {
              const response = JSON.parse(e.data);

              if (response.type === 'session.created') {
                console.log("[OPENAI] Session created");
              } else if (response.type === 'session.updated') {
                console.log(`[OPENAI] Session updated`);

                // Send initial greeting using agent's configured greeting
                responseStartTime = performance.now();
                const greetingInstruction = agentConfig.greeting 
                  ? `Di exactamente este saludo, no agregues nada más: "${agentConfig.greeting}"`
                  : "Saluda al usuario de forma breve y amigable. Preséntate con tu nombre y pregunta en qué puedes ayudar.";
                
                console.log(`[GREETING] Instruction: ${greetingInstruction.substring(0, 100)}...`);
                
                openAIWs?.send(JSON.stringify({
                  type: "response.create",
                  response: {
                    modalities: useElevenLabs ? ["text"] : ["text", "audio"],
                    instructions: greetingInstruction
                  }
                }));
              } else if (response.type === 'response.audio.delta' && !useElevenLabs) {
                if (streamSid && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: response.delta }
                  }));
                }
              } else if (response.type === 'response.text.delta' && useElevenLabs) {
                audioBuffer.push(response.delta);
              } else if (response.type === 'response.text.done' || response.type === 'response.done') {
                if (useElevenLabs && audioBuffer.length > 0) {
                  const fullText = audioBuffer.join('');
                  audioBuffer = [];
                  console.log(`[OPENAI] Text: "${fullText.substring(0, 100)}..."`);
                  streamElevenLabsSpeech(fullText).catch(console.error);
                }

                if (response.type === 'response.done') {
                  console.log(`[METRICS] Response done`);
                  responseStartTime = null;
                }
              } else if (response.type === 'input_audio_buffer.speech_started') {
                console.log("[VAD] User speaking - interrupting");
                responseStartTime = performance.now();
                twilioPlaybackToken++;
                audioBuffer = [];
                if (streamSid && socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ event: 'clear', streamSid }));
                }
              } else if (response.type === 'conversation.item.input_audio_transcription.completed') {
                console.log(`[USER] Said: ${response.transcript}`);
              } else if (response.type === 'error') {
                console.error("[OPENAI] Error:", response.error);
              }
            } catch (e) {
              console.error("[OPENAI] Message processing error:", e);
            }
          };

          openAIWs.onerror = (error) => {
            console.error("[OPENAI] WebSocket error:", error);
          };

          openAIWs.onclose = (event) => {
            console.log(`[OPENAI] WebSocket closed - Code: ${event.code}`);
          };
          break;

        case 'media':
          if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
            openAIWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media.payload
            }));
          }
          break;

        case 'stop':
          console.log(`[TWILIO] Stream stopped`);
          cleanup();
          break;
      }
    } catch (error) {
      console.error("[TWILIO] Message processing error:", error);
    }
  };

  socket.onerror = (error) => {
    console.error("[TWILIO] WebSocket error:", error);
  };

  socket.onclose = () => {
    console.log(`[TWILIO] WebSocket closed`);
    cleanup();
  };
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const upgradeHeader = req.headers.get("upgrade") || "";

  console.log(`[REQUEST] ${req.method} ${url.pathname}`);

  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (upgradeHeader.toLowerCase() === "websocket") {
    const urlAgentId = url.searchParams.get('agentId');
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleWebSocket(socket, urlAgentId);
    return response;
  }

  return new Response("Realtime Relay Server", { status: 200 });
});

console.log(`✅ Realtime Relay Server running on port ${PORT}`);

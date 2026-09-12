-- Alibaba Cloud · Bailian Speech (CosyVoice TTS, non-streaming)
-- Protocol: bailianSpeech  Capability: audio
--
-- API reference:
--   https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
--
-- Workflow:
--   1. POST to the TTS endpoint
--   2. Receive JSON with output.audio.url
--   3. Download the audio from that URL (handled by Rust)

function build_request(call, req, inputs)
    local body = {model = call.model}
    body.input = {text = req.prompt}

    -- Map request params to Bailian TTS parameters
    if req.params.voice then body.input.voice = req.params.voice end
    if req.params.format then body.input.format = req.params.format end
    if req.params.sample_rate then body.input.sample_rate = tonumber(req.params.sample_rate) end
    if req.params.volume then body.input.volume = tonumber(req.params.volume) end
    if req.params.rate then body.input.rate = tonumber(req.params.rate) end
    if req.params.pitch then body.input.pitch = tonumber(req.params.pitch) end

    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode(body),
    }
end

function parse_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local output = data.output or {}
    local audio = output.audio or {}
    local url = audio.url
    if not url or url == "" then
        return {error = "No audio URL in response"}
    end

    -- Infer mime from the URL extension; default to wav
    local mime = "audio/wav"
    if url:match("%.mp3") then mime = "audio/mpeg"
    elseif url:match("%.wav") then mime = "audio/wav"
    elseif url:match("%.opus") then mime = "audio/opus"
    elseif url:match("%.pcm") then mime = "audio/l16" end

    local items = {{url = url, mime = mime}}
    return {text = nil, items = items, usage = nil}
end
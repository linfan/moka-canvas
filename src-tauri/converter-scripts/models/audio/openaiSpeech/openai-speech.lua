-- OpenAI-compatible · Speech API (audio generation)
-- Protocol: openaiSpeech  Capability: audio

function build_request(call, req, inputs)
    local body = {model = call.model, input = req.prompt}
    if req.params.voice then body.voice = req.params.voice end
    if req.params.format then body.response_format = req.params.format end
    if req.params.speed then body.speed = tonumber(req.params.speed) end
    local instruction = req.params.instructions
    if instruction and instruction ~= "" then body.instructions = instruction end
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
    -- Audio arrives as raw binary; the Rust side handles the bytes
    return {
        text = nil,
        items = {{raw = true, mime = "audio/mpeg", bytes = body}},
        usage = nil,
    }
end
-- Google Gemini · generateContent (text, image, audio)
-- Protocol: gemini  Capability: text (also serves image/audio through content endpoint)

function build_request(call, req, inputs)
    local parts = {}
    if req.prompt and req.prompt ~= "" then
        table.insert(parts, {text = req.prompt})
    end
    for _, input in ipairs(inputs or {}) do
        table.insert(parts, {inlineData = {mimeType = input.mime, data = input.base64 or base64.encode(input.bytes or "")}})
    end
    local body = {contents = {{role = "user", parts = parts}}}
    local instruction = req.system or req.params.instructions
    if instruction and instruction ~= "" then
        body.systemInstruction = {parts = {{text = instruction}}}
    end
    local config = {}
    if req.capability == "image" then
        config.responseModalities = {"TEXT", "IMAGE"}
    elseif req.capability == "audio" then
        config.responseModalities = {"AUDIO"}
    end
    local temp = req.params.temperature
    if temp then config.temperature = tonumber(temp) end
    local tokens = req.params.maxTokens
    if tokens then config.maxOutputTokens = tonumber(tokens) end
    local count = req.params.count
    if count and tonumber(count) > 1 then config.candidateCount = tonumber(count) end
    local voice = req.params.voice
    if voice then
        config.speechConfig = {voiceConfig = {prebuiltVoiceConfig = {voiceName = voice}}}
    end
    if next(config) then body.generationConfig = config end
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
    if data.promptFeedback and data.promptFeedback.blockReason then
        return {error = "Prompt refused: " .. data.promptFeedback.blockReason}
    end
    local text = ""
    local items = {}
    local candidates = data.candidates or {}
    for _, candidate in ipairs(candidates) do
        local content = candidate.content or {}
        local parts = content.parts or {}
        for _, part in ipairs(parts) do
            if part.text then
                text = text .. part.text
            elseif part.inlineData then
                table.insert(items, {
                    data_url = "data:" .. part.inlineData.mimeType .. ";base64," .. part.inlineData.data,
                    mime = part.inlineData.mimeType,
                })
            end
        end
    end
    local usage = data.usageMetadata or util.default_table()
    return {
        text = text,
        items = items,
        usage = {
            input_tokens = usage.promptTokenCount,
            output_tokens = usage.candidatesTokenCount,
        },
    }
end

function parse_event(event_json)
    local data = json.decode(event_json)
    local text = ""
    local candidates = data.candidates or {}
    for _, candidate in ipairs(candidates) do
        local content = candidate.content or {}
        local parts = content.parts or {}
        for _, part in ipairs(parts) do
            if part.text then text = text .. part.text end
        end
    end
    local usage = data.usageMetadata or util.default_table()
    return {
        text = (text ~= "") and text or nil,
        complete = nil,
        usage = (usage.promptTokenCount or usage.candidatesTokenCount) and {
            input_tokens = usage.promptTokenCount,
            output_tokens = usage.candidatesTokenCount,
        } or nil,
    }
end
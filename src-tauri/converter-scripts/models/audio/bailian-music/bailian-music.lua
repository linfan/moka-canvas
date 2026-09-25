-- Alibaba Cloud · Bailian Music (fun-music, one-shot)
-- Protocol: bailianMusic  Capability: audio
--
-- API reference:
--   https://help.aliyun.com/zh/model-studio/fun-music-api
--
-- Workflow:
--   1. POST the prompt (and, where the caller has them, the lyrics) to the
--      generation service
--   2. Read the song's own address out of output.audio.url — the answer is a
--      link to an object store rather than the bytes, and the runtime fetches
--      it from here
--
-- The service composes in one request: it has no task to poll, and the link it
-- hands back is good for a day, which is why it is fetched rather than kept.

function build_request(call, req, inputs)
    local input = {}

    -- The prompt only travels where there is one: the service refuses a body
    -- that names neither words nor a description.
    if req.prompt and req.prompt ~= "" then input.prompt = req.prompt end

    if req.params.lyrics and req.params.lyrics ~= "" then
        input.lyrics = req.params.lyrics
    end
    if req.params.gender and req.params.gender ~= "" then
        input.gender = req.params.gender
    end
    if req.params.format and req.params.format ~= "" then
        input.format = req.params.format
    end
    -- A score under a telling's lines is played rather than sung, so the flag
    -- the story room sends is passed on as the service spells it.
    if req.params.instrumental ~= nil then
        input.is_instrumental = req.params.instrumental
    end
    if req.params.watermark ~= nil then
        input.enable_aigc_watermark = req.params.watermark
    end

    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode({model = call.model, input = input}),
    }
end

function parse_response(status, headers, body)
    if status < 200 or status >= 300 then
        local said = body
        local decoded = json.decode(body)
        if decoded and decoded.message then said = decoded.message end
        return {error = "HTTP " .. tostring(status) .. ": " .. tostring(said)}
    end

    local data = json.decode(body)
    local output = data.output or {}
    local audio = output.audio or {}
    local address = audio.url
    if not address or address == "" then
        -- A composition that finished without a song is a refusal wearing a
        -- 200, and what it says about itself is the useful part.
        return {error = data.message or "the answer carried no song"}
    end

    local mime = "audio/mpeg"
    local info = output.extra_info or {}
    if info.format == "wav" then mime = "audio/wav" end

    local words = nil
    if info.lyrics and info.lyrics ~= "" then words = info.lyrics end

    return {
        text = words,
        items = {{url = address, mime = mime}},
        usage = nil,
    }
end

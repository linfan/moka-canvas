-- Google Gemini · long-running (Veo) (video generation, async job)
-- Protocol: geminiVideo  Capability: video

function build_task_request(call, req, inputs)
    local shot = {prompt = req.prompt}
    local frames = {}
    for _, input in ipairs(inputs or {}) do
        if input.mime and string.find(input.mime, "^image/") then
            table.insert(frames, input)
        end
    end
    -- The two pictures the caller labelled as the shot's ends are the frames
    -- it lands on, and anything given beside them travels as a reference: an
    -- act is filmed this way. With no such pair there is only the count to go
    -- on — one picture opens the shot, two open and close it, and three or
    -- more are references, since no provider takes three frames.
    local opening, closing = nil, nil
    for _, frame in ipairs(frames) do
        if frame.role == "firstFrame" and not opening then
            opening = frame
        elseif frame.role == "lastFrame" and not closing then
            closing = frame
        end
    end

    local references = {}
    if req.params.mode == "reference" then
        references = frames
    elseif opening and closing then
        shot.image = {mimeType = opening.mime, bytesBase64Encoded = opening.base64 or ""}
        shot.lastFrame = {mimeType = closing.mime, bytesBase64Encoded = closing.base64 or ""}
        for _, frame in ipairs(frames) do
            if frame ~= opening and frame ~= closing then
                table.insert(references, frame)
            end
        end
    elseif #frames == 1 then
        shot.image = {mimeType = frames[1].mime, bytesBase64Encoded = frames[1].base64 or ""}
    elseif #frames == 2 then
        shot.image = {mimeType = frames[1].mime, bytesBase64Encoded = frames[1].base64 or ""}
        shot.lastFrame = {mimeType = frames[2].mime, bytesBase64Encoded = frames[2].base64 or ""}
    else
        references = frames
    end
    if #references > 0 then
        local images = {}
        for _, frame in ipairs(references) do
            table.insert(images, {referenceType = "ASSET", image = {mimeType = frame.mime, bytesBase64Encoded = frame.base64 or ""}})
        end
        shot.referenceImages = images
    end

    local params = {}
    if req.params.ratio then params.aspectRatio = req.params.ratio end
    if req.params.resolution then params.resolution = req.params.resolution end
    if req.params.seconds then params.durationSeconds = tonumber(req.params.seconds) end
    if req.params.generateAudio ~= nil then params.generateAudio = req.params.generateAudio end

    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode({instances = {shot}, parameters = params}),
    }
end

function parse_task_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local ref = data.name
    if not ref or ref == "" then
        return {error = "No job handle in response"}
    end
    return {reference = ref, poll_interval_ms = 5000}
end

function build_poll_request(call, task)
    local root = get_gemini_root(call.url)
    return {
        method = "GET",
        url = (root or "") .. "/" .. task.reference,
        headers = {},
    }
end

function parse_poll_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    if not data.done then
        return {status = "pending"}
    end
    if data.error and data.error.message then
        return {status = "failed", error = data.error.message}
    end
    local samples = {}
    local resp = data.response or {}
    local gen = resp.generateVideoResponse or {}
    local generated = gen.generatedSamples or {}
    for _, sample in ipairs(generated) do
        local video = sample.video or {}
        if video.uri then
            table.insert(samples, {url = video.uri, mime = "video/mp4"})
        end
    end
    return {status = "succeeded", result = {text = nil, items = samples}}
end

function get_gemini_root(url)
    local idx = string.find(url, "/models/")
    if idx then return string.sub(url, 1, idx - 1) end
    return nil
end
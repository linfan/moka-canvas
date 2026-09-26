-- OpenAI-compatible · Videos API (video generation, async job)
-- Protocol: openaiVideos  Capability: video

function build_task_request(call, req, inputs)
    local body = {model = call.model, prompt = req.prompt}
    if req.params.resolution then body.resolution = req.params.resolution end
    if req.params.ratio then body.ratio = req.params.ratio end
    if req.params.seconds then body.seconds = tonumber(req.params.seconds) end
    if req.params.generateAudio ~= nil then body.generate_audio = req.params.generateAudio end
    if req.params.watermark ~= nil then body.watermark = req.params.watermark end

    local frames = {}
    for _, input in ipairs(inputs or {}) do
        if input.mime and string.find(input.mime, "^image/") then
            table.insert(frames, input)
        end
    end
    local mode = req.params.mode or "auto"
    if #frames > 2 or mode == "reference" then
        local refs = {}
        for _, f in ipairs(frames) do
            table.insert(refs, f.data_url)
        end
        body.reference_images = refs
    elseif #frames == 1 then
        body.first_frame = frames[1].data_url
    elseif #frames == 2 then
        body.first_frame = frames[1].data_url
        body.last_frame = frames[2].data_url
    end
    return {
        method = "POST",
        url = call.url,
        headers = {["Content-Type"] = "application/json"},
        body = json.encode(body),
    }
end

function parse_task_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local ref = data.id
    if not ref or ref == "" then
        return {error = "No job handle in response"}
    end
    return {reference = ref, poll_interval_ms = 5000}
end

function build_poll_request(call, task)
    return {
        method = "GET",
        url = call.url .. "/" .. task.reference,
        headers = {},
    }
end

function parse_poll_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local s = (data.status or ""):lower()
    if s == "succeeded" or s == "completed" then
        return {
            status = "succeeded",
            result = {text = nil, items = {{url = data.output and data.output.video_url, mime = "video/mp4"}}},
        }
    elseif s == "failed" then
        local msg = (data.error or {}).message or "Job failed"
        return {status = "failed", error = msg}
    elseif s == "expired" then
        return {status = "expired", error = "Job expired"}
    else
        return {status = "pending"}
    end
end
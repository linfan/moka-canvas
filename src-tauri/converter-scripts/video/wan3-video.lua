-- Alibaba Cloud · Wan3.0 Video (video generation, async job)
-- Protocol: wan3Video  Capability: video
--
-- API reference:
--   https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference
--
-- Workflow:
--   1. POST to the task endpoint with X-DashScope-Async: enable
--   2. Receive task_id back
--   3. Poll GET /api/v1/tasks/{task_id} until SUCCEEDED or FAILED

function build_task_request(call, req, inputs)
    local body = {model = "wan3.0-video"}
    body.input = {prompt = req.prompt}

    -- Handle reference media (first_frame, last_frame, reference_image, etc.)
    if inputs and #inputs > 0 then
        body.input.media = {}
        for _, input in ipairs(inputs) do
            local mtype = nil
            if input.role == "firstFrame" then
                mtype = "first_frame"
            elseif input.role == "lastFrame" then
                mtype = "last_frame"
            else
                mtype = "reference_image"
            end
            table.insert(body.input.media, {type = mtype, url = input.data_url})
        end
    end

    -- Map request params to Wan3.0 API parameters
    local params = {}
    if req.params.resolution then params.resolution = req.params.resolution end
    if req.params.ratio then params.ratio = req.params.ratio end
    if req.params.seconds then params.duration = tonumber(req.params.seconds) end
    if req.params.generateAudio ~= nil then params.audio = req.params.generateAudio end
    if req.params.watermark ~= nil then params.watermark = req.params.watermark end
    if req.params.prompt_extend ~= nil then params.prompt_extend = req.params.prompt_extend end
    if req.params.seed ~= nil then params.seed = tonumber(req.params.seed) end

    body.parameters = params

    return {
        method = "POST",
        url = call.url,
        headers = {
            ["Content-Type"] = "application/json",
            ["X-DashScope-Async"] = "enable",
        },
        body = json.encode(body),
    }
end

function parse_task_response(status, headers, body)
    if status < 200 or status >= 300 then
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local output = data.output or {}
    local ref = output.task_id
    if not ref or ref == "" then
        return {error = "No task_id in response"}
    end
    -- Wan3.0 recommends polling every ~15 seconds
    return {reference = ref, poll_interval_ms = 15000}
end

function build_poll_request(call, task)
    -- Derive the base URL from the endpoint
    -- The task endpoint is something like:
    --   https://{workspaceId}.{region}.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
    -- The poll endpoint is:
    --   https://{workspaceId}.{region}.maas.aliyuncs.com/api/v1/tasks/{task_id}
    local base = derive_task_base(call.url)
    return {
        method = "GET",
        url = base .. "/" .. task.reference,
        headers = {},
    }
end

function parse_poll_response(status, headers, body)
    if status < 200 or status >= 300 then
        if status == 404 or status == 410 then
            return {status = "expired", error = "Task not found (expired)"}
        end
        return {error = "HTTP " .. tostring(status) .. ": " .. body}
    end
    local data = json.decode(body)
    local output = data.output or {}
    local task_status = output.task_status or "UNKNOWN"

    if task_status == "SUCCEEDED" then
        local items = {}
        if output.video_url then
            table.insert(items, {url = output.video_url, mime = "video/mp4"})
        end
        return {status = "succeeded", result = {text = nil, items = items}}
    elseif task_status == "FAILED" then
        local msg = output.message or output.code or "Job failed"
        return {status = "failed", error = msg}
    elseif task_status == "CANCELED" then
        return {status = "failed", error = "Job cancelled"}
    elseif task_status == "UNKNOWN" then
        return {status = "expired", error = "Task unknown (24h expiry)"}
    else
        -- PENDING, RUNNING, or anything else
        return {status = "pending"}
    end
end

function derive_task_base(url)
    -- Input:  https://{ws}.{region}.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
    -- Output: https://{ws}.{region}.maas.aliyuncs.com/api/v1/tasks
    local prefix, rest = string.match(url, "^(https?://[^/]+)(/.*)$")
    if not prefix then return url end
    -- Try to find the task base by stripping "services/aigc/video-generation/video-synthesis"
    local idx = string.find(rest, "/services/")
    if idx then
        return prefix .. string.sub(rest, 1, idx - 1) .. "/tasks"
    end
    -- Fallback: just use the origin
    return prefix .. "/api/v1/tasks"
end
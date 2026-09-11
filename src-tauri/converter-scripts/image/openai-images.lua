-- OpenAI-compatible · Images API (image generation)
-- Protocol: openaiImages  Capability: image

function build_request(call, req, inputs)
    local body = {model = call.model, prompt = req.prompt}
    local size = req.params.size
    if size then
        local ratio = parse_ratio(size)
        if ratio then
            if ratio > 1.01 then
                body.size = "1536x1024"
            elseif ratio < 0.99 then
                body.size = "1024x1536"
            else
                body.size = "1024x1024"
            end
        else
            body.size = size
        end
    end
    for _, key in ipairs({"quality", "background"}) do
        local val = req.params[key]
        if val then body[key] = val end
    end
    local count = req.params.count
    if count and tonumber(count) > 0 then body.n = tonumber(count) end
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
    local items = {}
    local rewritten = {}
    local entries = data.data or {}
    for _, entry in ipairs(entries) do
        if entry.b64_json then
            table.insert(items, {data_url = "data:image/png;base64," .. entry.b64_json, mime = "image/png"})
        elseif entry.url then
            table.insert(items, {url = entry.url, mime = "image/png"})
        end
        if entry.revised_prompt then
            table.insert(rewritten, entry.revised_prompt)
        end
    end
    return {
        text = (#rewritten > 0) and table.concat(rewritten, "\n") or nil,
        items = items,
        usage = {images = #items},
    }
end

function parse_ratio(size)
    local w_str, h_str = string.match(size, "^(%d+):(%d+)$")
    if not w_str then return nil end
    local w = tonumber(w_str)
    local h = tonumber(h_str)
    if w and h and w > 0 and h > 0 then return w / h end
    return nil
end
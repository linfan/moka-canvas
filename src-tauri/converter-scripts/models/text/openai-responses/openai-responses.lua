-- OpenAI-compatible · Responses API (text, streaming)
-- Protocol: openaiResponses  Capability: text

function build_request(call, req, inputs)
    local body = {model = call.model, input = req.prompt}
    local seen = {}
    for _, input in ipairs(inputs or {}) do
        if input.mime and string.find(input.mime, "^image/") then
            table.insert(seen, input)
        end
    end
    if #seen > 0 then
        local parts = {}
        table.insert(parts, {type = "input_text", text = req.prompt})
        for _, img in ipairs(seen) do
            table.insert(parts, {type = "input_image", image_url = img.data_url})
        end
        body.input = {{type = "message", role = "user", content = parts}}
    end
    local instruction = req.system or req.params.instructions
    if instruction and instruction ~= "" then
        body.instructions = instruction
    end
    local temp = req.params.temperature
    if temp then body.temperature = tonumber(temp) end
    local tokens = req.params.maxTokens
    if tokens then body.max_output_tokens = tonumber(tokens) end
    local effort = req.params.reasoningEffort
    if effort and effort ~= "auto" then
        body.reasoning = {effort = effort}
    end
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
    local text = data.output_text
    if not text or text == "" then
        local parts = {}
        local output = data.output
        if output then
            for _, item in ipairs(output) do
                local content = item.content
                if content then
                    for _, part in ipairs(content) do
                        if part.text then table.insert(parts, part.text) end
                    end
                end
            end
        end
        text = table.concat(parts)
    end
    local usage = data.usage or util.default_table()
    return {
        text = text,
        items = {},
        usage = {
            input_tokens = usage.input_tokens,
            output_tokens = usage.output_tokens,
        },
    }
end

function parse_event(event_json)
    local data = json.decode(event_json)
    local etype = data.type or ""
    local text, complete, usage
    if etype == "response.output_text.delta" then
        text = data.delta
    elseif etype == "response.completed" then
        local resp = data.response
        if resp then
            complete = resp.output_text
            local u = resp.usage
            if u then
                usage = {input_tokens = u.input_tokens, output_tokens = u.output_tokens}
            end
        end
    end
    return {text = text, complete = complete, usage = usage}
end
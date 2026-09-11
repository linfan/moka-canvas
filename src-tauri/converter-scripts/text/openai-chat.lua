-- OpenAI-compatible · Chat Completions (text, streaming)
-- Protocol: openaiChat  Capability: text

function build_request(call, req, inputs)
    local messages = {}
    local instruction = req.system or req.params.instructions
    if instruction and instruction ~= "" then
        table.insert(messages, {role = "system", content = instruction})
    end
    local seen = {}
    for _, input in ipairs(inputs or {}) do
        if input.mime and string.find(input.mime, "^image/") then
            table.insert(seen, input)
        end
    end
    local content
    if #seen == 0 then
        content = req.prompt
    else
        content = {}
        table.insert(content, {type = "text", text = req.prompt})
        for _, img in ipairs(seen) do
            table.insert(content, {type = "image_url", image_url = {url = img.data_url}})
        end
    end
    table.insert(messages, {role = "user", content = content})

    local body = {model = call.model, messages = messages}
    local temp = req.params.temperature
    if temp then body.temperature = tonumber(temp) end
    local tokens = req.params.maxTokens
    if tokens then body.max_tokens = tonumber(tokens) end
    local effort = req.params.reasoningEffort
    if effort and effort ~= "auto" then
        body.reasoning_effort = effort
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
    local text = ""
    local choices = data.choices
    if choices and #choices > 0 then
        text = (choices[1].message or {}).content or ""
    end
    local usage = data.usage or util.default_table()
    return {
        text = text,
        items = {},
        usage = {
            input_tokens = usage.prompt_tokens,
            output_tokens = usage.completion_tokens,
        },
    }
end

function parse_event(event_json)
    local data = json.decode(event_json)
    local text = nil
    local choice = (data.choices or {})[1]
    if choice and choice.delta and choice.delta.content then
        text = choice.delta.content
    end
    local complete = nil
    if choice and choice.message and choice.message.content then
        complete = choice.message.content
    end
    local usage = nil
    if data.usage then
        usage = {
            input_tokens = data.usage.prompt_tokens,
            output_tokens = data.usage.completion_tokens,
        }
    end
    return {text = text, complete = complete, usage = usage}
end
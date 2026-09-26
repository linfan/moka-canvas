-- OpenAI-compatible responses: the newer text endpoint, which answers with a
-- document of parts rather than a message.
--
-- The words alone travel as `input`, which is the shape this endpoint reads a
-- bare question as; a picture beside them makes the same input a message of
-- parts. A stream is asked for in the body, and its events name themselves —
-- several of them carry a `delta`, and only the one that says it is the answer
-- being written is read as one.

local function trimmed(text)
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function pictures_of(inputs)
  local pictures = {}
  for _, input in ipairs(inputs or {}) do
    if (input.mime or ""):sub(1, 6) == "image/" then
      table.insert(pictures, input)
    end
  end
  return pictures
end

local function number_param(params, key)
  local value = params[key]
  if type(value) == "number" then
    return value
  end
  if type(value) == "string" then
    return tonumber(trimmed(value))
  end
  return nil
end

local function integer_param(params, key)
  local value = params[key]
  if value == nil then
    return nil
  end
  if math.type(value) == "integer" then
    return value
  end
  if type(value) == "string" then
    local parsed = tonumber(trimmed(value))
    if parsed ~= nil and math.type(parsed) == "integer" then
      return parsed
    end
  end
  return nil
end

-- "Auto" means the provider picks the effort itself, and some channels reject
-- it as a value they do not know, so it never travels.
local function reasoning_effort(params)
  local effort = params.reasoningEffort
  if type(effort) ~= "string" or trimmed(effort):lower() == "auto" then
    return nil
  end
  return effort
end

local function describe(call, req, inputs, streaming)
  local body = {model = call.model, input = req.prompt or ""}
  local pictures = pictures_of(inputs)
  if #pictures > 0 then
    local parts = {{type = "input_text", text = req.prompt or ""}}
    for _, picture in ipairs(pictures) do
      table.insert(parts, {type = "input_image", image_url = picture.data_url})
    end
    body.input = {{type = "message", role = "user", content = parts}}
  end
  if req.system and trimmed(req.system) ~= "" then
    body.instructions = req.system
  end
  if streaming then
    body.stream = true
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    body.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    body.max_output_tokens = tokens
  end
  local effort = reasoning_effort(req.params)
  if effort ~= nil then
    body.reasoning = {effort = effort}
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

local function tokens(counted)
  if type(counted) ~= "table" then
    return nil
  end
  local input = counted.input_tokens
  local output = counted.output_tokens
  if input == nil and output == nil then
    return nil
  end
  return {input_tokens = input, output_tokens = output}
end

-- The answer assembled from its parts, for a response that carries no
-- aggregate field of its own.
local function parts_text(payload)
  local output = payload.output
  if type(output) ~= "table" then
    return nil
  end
  local said = {}
  for _, item in ipairs(output) do
    for _, part in ipairs(item.content or {}) do
      if type(part.text) == "string" then
        table.insert(said, part.text)
      end
    end
  end
  local text = table.concat(said)
  if trimmed(text) == "" then
    return nil
  end
  return text
end

function build_request(call, req, inputs)
  return describe(call, req, inputs, false)
end

function build_stream_request(call, req, inputs)
  return describe(call, req, inputs, true)
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  local text = payload.output_text
  if type(text) ~= "string" or trimmed(text) == "" then
    text = parts_text(payload)
  end
  return {text = text, usage = tokens(payload.usage)}
end

-- One event, gated on the name it gives itself: the pieces of an answer are
-- the ones this endpoint calls an output-text delta, and the end of the answer
-- is where the whole text and the totals arrive.
function parse_event(event)
  local payload = json.decode(event)
  local kind = payload.type or ""
  if kind == "response.output_text.delta" then
    local text = payload.delta
    if type(text) ~= "string" or text == "" then
      text = nil
    end
    return {text = text}
  end
  if kind == "response.completed" then
    local response = payload.response or {}
    local complete = response.output_text
    if type(complete) ~= "string" or complete == "" then
      complete = parts_text(response)
    end
    return {complete = complete, usage = tokens(response.usage)}
  end
  return {}
end

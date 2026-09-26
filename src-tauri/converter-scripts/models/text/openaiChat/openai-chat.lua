-- OpenAI-compatible chat completions: the shape most gateways and aggregators
-- speak.
--
-- The address a configuration carries is the whole endpoint, and this script
-- posts the question to it and nowhere else — a gateway that answers there
-- answers in this shape.
--
-- A question travels as a message: the words alone are a bare string, which is
-- what a gateway that cannot see pictures accepts, and a picture beside them
-- makes the same message a document of parts. Pieces are asked for in the body,
-- and each event carries what has been written since the last one; a gateway
-- that buffers answers the whole thing in one closing chunk instead, which is
-- read as the answer it is.

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

-- What the question is, as one message: the words, with the pictures beside
-- them where there are any. Audio and video have no part in this shape, and a
-- clip sent as a picture no model can hear would be worse than one left out.
local function said(req, pictures)
  if #pictures == 0 then
    return req.prompt or ""
  end
  local content = {}
  table.insert(content, {type = "text", text = req.prompt or ""})
  for _, picture in ipairs(pictures) do
    table.insert(content, {type = "image_url", image_url = {url = picture.data_url}})
  end
  return content
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
  local messages = {}
  if req.system and trimmed(req.system) ~= "" then
    table.insert(messages, {role = "system", content = req.system})
  end
  table.insert(messages, {role = "user", content = said(req, pictures_of(inputs))})

  local body = {model = call.model, messages = messages}
  if streaming then
    body.stream = true
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    body.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    body.max_tokens = tokens
  end
  local effort = reasoning_effort(req.params)
  if effort ~= nil then
    body.reasoning_effort = effort
  end

  return {
    method = "POST",
    url = call.url,
    headers = {["Content-Type"] = "application/json"},
    body = json.encode(body),
  }
end

local function tokens(payload)
  local counted = payload.usage
  if type(counted) ~= "table" then
    return nil
  end
  local input = counted.prompt_tokens
  local output = counted.completion_tokens
  if input == nil and output == nil then
    return nil
  end
  return {input_tokens = input, output_tokens = output}
end

function build_request(call, req, inputs)
  return describe(call, req, inputs, false)
end

function build_stream_request(call, req, inputs)
  return describe(call, req, inputs, true)
end

function parse_response(status, headers, body)
  local payload = json.decode(body)
  local choice = (payload.choices or {})[1] or {}
  local text = (choice.message or {}).content
  if type(text) ~= "string" or trimmed(text) == "" then
    text = nil
  end
  return {text = text, usage = tokens(payload)}
end

-- One event: the piece written since the last one, and the totals where the
-- service reported them at the end.
function parse_event(event)
  local payload = json.decode(event)
  local choice = (payload.choices or {})[1] or {}
  local delta = choice.delta or {}
  local text = delta.content
  if type(text) ~= "string" or text == "" then
    text = nil
  end
  -- A gateway that buffers answers the whole thing in one closing chunk.
  local complete = (choice.message or {}).content
  if type(complete) ~= "string" or complete == "" then
    complete = nil
  end
  return {text = text, complete = complete, usage = tokens(payload)}
end

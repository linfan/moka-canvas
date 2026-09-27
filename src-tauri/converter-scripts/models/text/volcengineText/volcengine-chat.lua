-- Volcengine Ark (火山方舟) chat completions.
--
-- API reference:
--   https://www.volcengine.com/docs/ark/chat-api
--
-- A question travels as a message: the words alone are a bare string, and a
-- picture beside them makes the same message a document of parts whose picture
-- is carried inside the message rather than left at an address the service has
-- to fetch.
--
-- Pieces are asked for in the body, and the totals of a streamed answer only
-- travel when they are asked for as well: a stream that never counted its
-- tokens leaves the answer uncounted, so the closing event is asked to carry
-- them.
--
-- How hard to think is a switch here rather than a word. The effort the room
-- states is read as the switch off for `none` and on for any effort that was
-- named; `auto` is the service's own middle, which saying nothing is the same
-- as, and a switch the service never read is a word it would refuse.

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

-- The question as one message: the words alone where they are all it is, and
-- beside the pictures otherwise. A clip sent as a picture no model can hear is
-- left out rather than carried as a part nothing reads.
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

-- The switch a stated effort means: nothing said and the service's own middle
-- travel as no switch at all.
local function thinking(params)
  local effort = params.reasoningEffort
  if type(effort) ~= "string" then
    return nil
  end
  local word = trimmed(effort):lower()
  if word == "" or word == "auto" then
    return nil
  end
  if word == "none" then
    return {type = "disabled"}
  end
  return {type = "enabled"}
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
    body.stream_options = {include_usage = true}
  end
  local temperature = number_param(req.params, "temperature")
  if temperature ~= nil then
    body.temperature = temperature
  end
  local tokens = integer_param(req.params, "maxTokens")
  if tokens ~= nil then
    body.max_tokens = tokens
  end
  local switch = thinking(req.params)
  if switch ~= nil then
    body.thinking = switch
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

-- One event: the piece written since the last one, the totals where the closing
-- event carried them, and a complaint where the service sent one instead of a
-- piece — a stream that has opened has no status left to refuse with.
function parse_event(event)
  local payload = json.decode(event)
  if type(payload.error) == "table" then
    local explanation = trimmed(tostring(payload.error.message or ""))
    if explanation == "" then
      explanation = tostring(payload.error.code or "the service refused the request")
    end
    return {failed = explanation}
  end
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

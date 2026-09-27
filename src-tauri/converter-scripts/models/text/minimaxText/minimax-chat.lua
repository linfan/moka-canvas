-- MiniMax chat completions.
--
-- API reference:
--   https://platform.minimax.io/docs/api-reference/text-chat-openai
--
-- A question travels as a message: the words alone are a bare string, and a
-- picture beside them makes the same message a document of parts whose picture
-- is carried inside the message rather than left at an address the service has
-- to fetch.
--
-- How hard to think is two things here: a switch — the service's own middle
-- `adaptive`, or `disabled` to keep the answer to itself — and a word naming
-- one of the depths the service knows. The effort the room states is read as
-- the switch off for `none`, as the lightest word the service has for
-- `minimal` (a depth this service does not name), and as its own word for the
-- rest; `auto` is what saying nothing says, and travels as nothing.
--
-- The totals of a streamed answer travel only where they are asked for: a
-- stream that never counted its tokens leaves the answer uncounted, so the
-- closing event is asked to carry them.

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

-- The depths this service names, with the lightest of its own standing in for
-- the one it does not.
local EFFORT_WORDS = {
  minimal = "low",
  low = "low",
  medium = "medium",
  high = "high",
  xhigh = "xhigh",
  max = "max",
}

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
    -- This service names the ceiling `max_completion_tokens`; the older name
    -- is one it keeps for compatibility rather than reads.
    body.max_completion_tokens = tokens
  end
  local effort = req.params.reasoningEffort
  if type(effort) == "string" then
    local word = trimmed(effort):lower()
    if word == "none" then
      body.thinking = {type = "disabled"}
    elseif EFFORT_WORDS[word] ~= nil then
      body.reasoning_effort = EFFORT_WORDS[word]
    end
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

-- One event: the piece written since the last one, the totals where the
-- closing event carried them, and a complaint where the service sent one
-- instead of a piece — a stream that has opened has no status left to refuse
-- with.
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
